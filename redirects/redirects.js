/*
 * 旧URL→新URL リダイレクトテーブル lookup (JSON 版)
 *
 * map.json の形式:
 *   {
 *     "exact": {                                  // 完全一致
 *       "/old/about.html": "/about",
 *       "/contact.php":    "/contact"
 *     },
 *     "prefix": [                                 // 前方一致(長い順に列挙する)
 *       ["/blog/old/",      "/blog/"],            // 残りパスは引き継ぐ
 *       ["/products/v1/",   "/products/"]
 *     ],
 *     "regex": [                                  // 正規表現(順番に評価)
 *       ["^/article/(\\d+)\\.html$", "/posts/$1"]
 *     ]
 *   }
 *
 * 配信サーバ側のヒント:
 *   - map.json は Content-Encoding: gzip (もしくは Brotli) で配信。
 *     例: Apache の AddOutputFilterByType DEFLATE application/json
 *   - Cache-Control: public, max-age=3600 程度を付ける。
 *   - 数万件以上の規模になる場合は redirects-sqlite.js (sql.js/WASM) を検討。
 */

(() => {
  'use strict';

  const STATUS   = document.getElementById('status');
  const PANEL    = document.getElementById('panel');
  const SUGGEST  = document.getElementById('suggestions');
  const MAP_URL  = '/redirects/map.json';
  const COUNTDOWN_SEC = 5;

  // ---- セキュリティ設定 -------------------------------------------------
  // 既定では同一オリジンへの転送のみ許可する。
  // 別ドメインへ意図的に転送したい場合だけ、明示的にオリジンを追加すること。
  // 例: 'https://en.example.com'
  // (これによりオープンリダイレクトと javascript:/data:/file: 経由の XSS を防ぐ)
  const CROSS_ORIGIN_ALLOWLIST = Object.freeze([
    // 'https://en.example.com',
  ]);
  // ----------------------------------------------------------------------

  // 404 で返ったページの URL がそのまま「旧URL」になる
  const origPath   = location.pathname;
  const origSearch = location.search;
  const origHash   = location.hash;

  STATUS.textContent = `「${origPath}」の転送先を検索中…`;

  fetch(MAP_URL, { cache: 'force-cache' })
    .then(r => r.ok ? r.json() : Promise.reject(new Error('HTTP ' + r.status)))
    .then(handleMap)
    .catch(err => {
      console.error('[404] map load failed:', err);
      setPanel('missing', '転送情報の取得に失敗しました。');
    });

  // ---------- main ----------

  function handleMap(map) {
    const hit = resolve(origPath, map);

    if (hit) {
      const target = buildTarget(hit.to);
      if (target) {
        announceRedirect(target, hit.type);
        logEvent('hit', { from: origPath, to: target, type: hit.type });
      } else {
        // 解決した転送先が安全ポリシーに反する(危険スキーム / 許可外オリジン)。
        // 攻撃者が prefix/regex ルールを悪用して javascript: や別オリジン URL を
        // 生成できないように、ここで完全に転送を止める。
        console.warn('[404] resolved target rejected by safety policy:', hit);
        announceNoMatch();
        showSuggestions(origPath, map);
        logEvent('miss', { from: origPath, reason: 'unsafe-target' });
      }
    } else {
      announceNoMatch();
      showSuggestions(origPath, map);
      logEvent('miss', { from: origPath });
    }
  }

  // ---------- safety ----------

  // 解決後の URL が転送先として安全かを判定する。
  //   - http(s) 以外のスキーム(javascript:, data:, file:, blob:, vbscript:, ...)を全拒否
  //   - 同一オリジン以外は CROSS_ORIGIN_ALLOWLIST に明示登録された場合のみ許可
  // これにより:
  //   * <a href="javascript:..."> 経由のリフレクトXSSをブロック
  //   * '//evil.com/...' などプロトコル相対URLによるオープンリダイレクトをブロック
  //   * 'https://evil.com/...' などの絶対URL経由のオープンリダイレクトをブロック
  function isSafeTarget(url) {
    if (url.protocol !== 'http:' && url.protocol !== 'https:') return false;
    if (url.origin === location.origin) return true;
    return CROSS_ORIGIN_ALLOWLIST.includes(url.origin);
  }

  // ---------- matching ----------

  function resolve(path, map) {
    // 1) 完全一致(末尾スラッシュの有無を吸収)
    const variants = path.endsWith('/')
      ? [path, path.slice(0, -1)]
      : [path, path + '/'];

    if (map.exact) {
      for (const v of variants) {
        if (Object.hasOwn(map.exact, v)) {
          return { to: map.exact[v], type: 'exact' };
        }
      }
    }

    // 2) 前方一致(残りパスを継承)。長い順に並べておくこと
    if (Array.isArray(map.prefix)) {
      for (const [from, to] of map.prefix) {
        if (path.startsWith(from)) {
          return { to: to + path.slice(from.length), type: 'prefix' };
        }
      }
    }

    // 3) 正規表現($1, $2 で参照)
    if (Array.isArray(map.regex)) {
      for (const [pattern, repl] of map.regex) {
        const re = new RegExp(pattern);
        if (re.test(path)) {
          return { to: path.replace(re, repl), type: 'regex' };
        }
      }
    }

    return null;
  }

  function buildTarget(toPath) {
    // 新URLが絶対URL(http://…)ならそのまま、相対なら location.origin に乗せる
    let target;
    try {
      target = new URL(toPath, location.origin);
    } catch {
      return null;  // パース失敗
    }
    // 安全性ポリシーで弾かれた場合は null を返し、上位で転送を中止する
    if (!isSafeTarget(target)) return null;
    // クエリ・フラグメントは原則継承(新URLが既に持っている場合はそちら優先)
    if (!target.search && origSearch) target.search = origSearch;
    if (!target.hash   && origHash)   target.hash   = origHash;
    return target.href;
  }

  // ---------- UI ----------
  // テンプレート + esc() + isSafeTarget の URL 検証で安全性は確保している。
  // target は buildTarget で http/https + 同一オリジン(または allowlist)と
  // 検証済みなので、href 属性経由の javascript:/data: 等のXSSは発生しない。

  function announceRedirect(target, type) {
    let remain = COUNTDOWN_SEC;
    PANEL.className = 'panel found';
    PANEL.innerHTML = `
      <p>ページは下記に移転しました <small>(${type} match)</small>:</p>
      <p class="target"><a href="${esc(target)}">${esc(target)}</a></p>
      <p>
        <span class="countdown" id="cd">${remain}</span> 秒後に自動で移動します。
        <button type="button" id="cancel">キャンセル</button>
        <button type="button" id="go">今すぐ移動</button>
      </p>
    `;
    const cd = document.getElementById('cd');
    const timer = setInterval(() => {
      remain -= 1;
      cd.textContent = remain;
      if (remain <= 0) {
        clearInterval(timer);
        location.replace(target);
      }
    }, 1000);

    document.getElementById('cancel').onclick = () => {
      clearInterval(timer);
      const p = cd.parentElement;
      p.innerHTML = '自動転送をキャンセルしました。上記リンクから手動で移動してください。';
    };
    document.getElementById('go').onclick = () => {
      clearInterval(timer);
      location.replace(target);
    };
  }

  function announceNoMatch() {
    PANEL.className = 'panel missing';
    PANEL.innerHTML = `
      <p>該当する移転先が見つかりませんでした。</p>
      <p>下記の候補をお試しいただくか、トップページから目的のページをお探しください。</p>
    `;
  }

  function showSuggestions(path, map) {
    if (!map.exact) return;
    const cands = similar(path, Object.keys(map.exact), 5);
    if (!cands.length) return;

    // 候補のリンク先も同じ安全ポリシーに通す。map.json が汚染されて
    // javascript: URL 等が紛れ込んだ場合に、サジェスト経由のXSSも防ぐ。
    const items = cands.map(([oldUrl]) => {
      let safeUrl;
      try {
        const u = new URL(map.exact[oldUrl], location.origin);
        if (!isSafeTarget(u)) return '';
        safeUrl = u.href;
      } catch {
        return '';
      }
      return `<li>
        <a href="${esc(safeUrl)}">${esc(safeUrl)}</a>
        <br><small>旧: ${esc(oldUrl)}</small>
       </li>`;
    }).filter(Boolean).join('');

    if (!items) return;
    SUGGEST.innerHTML =
      '<h3>類似する旧URL:</h3><ul class="suggest">' + items + '</ul>';
  }

  // パス階層を比較した素朴な類似度
  function similar(target, keys, k) {
    const tParts = target.split('/').filter(Boolean);
    const tTail  = tParts.at(-1) || '';
    return keys.map(key => {
      const parts = key.split('/').filter(Boolean);
      let score = 0;
      for (let i = 0; i < Math.min(parts.length, tParts.length); i++) {
        if (parts[i] === tParts[i]) score += 1;
        else break;
      }
      const ktail = parts.at(-1) || '';
      if (tTail && ktail === tTail) score += 0.7;
      else if (tTail && ktail && ktail.includes(tTail)) score += 0.3;
      return [key, score];
    })
    .filter(([, s]) => s > 0)
    .sort((a, b) => b[1] - a[1])
    .slice(0, k);
  }

  // ---------- util ----------

  function setPanel(cls, html) {
    PANEL.className = 'panel ' + cls;
    PANEL.innerHTML = html;
  }
  function esc(s) {
    return String(s).replace(/[&<>"']/g, c =>
      ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
  }

  // 未登録404を継続的に拾うためのビーコン(必要時に有効化)
  function logEvent(kind, payload) {
    try {
      if (!navigator.sendBeacon) return;
      // const body = JSON.stringify({ kind, ...payload,
      //   ua: navigator.userAgent, ref: document.referrer, t: Date.now() });
      // navigator.sendBeacon('/api/404-log',
      //   new Blob([body], { type: 'application/json' }));
    } catch { /* noop */ }
  }
})();
