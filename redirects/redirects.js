/*
 * 旧URL→新URL リダイレクトテーブル lookup (JSON 版)
 *
 * map.json の形式:
 *   {
 *     "exact": {                                  // 完全一致
 *       "/old/about.html": "/about",              // 値は文字列、または
 *       "/contact.php":    { "to": "/contact",    // { to, title } オブジェクト
 *                            "title": "お問い合わせ" }
 *     },
 *     "prefix": [                                 // 前方一致(長い順に列挙する)
 *       ["/blog/old/",      "/blog/", "ブログ"],   // 残りパスは引き継ぐ。第3要素は
 *       ["/products/v1/",   "/products/"]         // 省略可能な title
 *     ],
 *     "regex": [                                  // 正規表現(順番に評価)
 *       ["^/article/(\\d+)\\.html$", "/posts/$1", "記事"]  // 第3要素は省略可能な title
 *     ]
 *   }
 *
 * title は転送案内・サジェスト候補に説明文として表示される(省略可)。
 * プレーンテキスト扱いで、表示時に HTML エスケープされる。
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
        // 転送先が新サイトに実在するか表示直前に確認する。
        // 明確に存在しない(404/410)ときは転送せず、案内も出さない。
        // ネットワーク不明時は map が事前検証済みである前提で転送する。
        STATUS.textContent = `転送先を確認中…`;
        checkAlive(target).then(alive => {
          if (alive === false) {
            console.warn('[404] resolved target no longer exists:', target);
            announceNoMatch();
            showSuggestions(origPath, map);
            logEvent('miss', { from: origPath, reason: 'target-gone', to: target });
          } else {
            announceRedirect(target, hit.type, hit.title);
            logEvent('hit', { from: origPath, to: target, type: hit.type });
          }
        });
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

  // 実在確認: HEAD で 200番台なら true、404/410 なら false、
  // それ以外(ネットワークエラー/タイムアウト/曖昧なステータス)は null(不明)。
  // 「存在しないURLは案内しない」を表示時点で担保するための最終ゲート。
  function checkAlive(url) {
    return new Promise(resolve => {
      let settled = false;
      const done = v => { if (!settled) { settled = true; clearTimeout(timer); resolve(v); } };
      const ctl = ('AbortController' in window) ? new AbortController() : null;
      const timer = setTimeout(() => { if (ctl) try { ctl.abort(); } catch {} ; done(null); }, 3500);
      fetch(url, { method: 'HEAD', redirect: 'manual',
                   signal: ctl ? ctl.signal : undefined })
        .then(r => {
          // opaqueredirect(3xx)は実在扱い。200番台=実在。404/410=不在。
          if (r.type === 'opaqueredirect' || r.ok) return done(true);
          if (r.status === 404 || r.status === 410) return done(false);
          done(null);
        })
        .catch(() => done(null));
    });
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

  // exact の値・prefix/regex の転送先には2形式を許す:
  //   文字列                      → 転送先のみ
  //   { to, title } / 第3要素付き → 転送先 + 説明文(title)
  function entryTo(v) {
    return typeof v === 'string' ? v : (v && v.to);
  }
  function entryTitle(v) {
    if (typeof v === 'string') return null;
    return (v && typeof v.title === 'string' && v.title) || null;
  }

  function resolve(path, map) {
    // 1) 完全一致(末尾スラッシュの有無を吸収)
    const variants = path.endsWith('/')
      ? [path, path.slice(0, -1)]
      : [path, path + '/'];

    if (map.exact) {
      for (const v of variants) {
        if (Object.hasOwn(map.exact, v)) {
          const val = map.exact[v];
          return { to: entryTo(val), type: 'exact', title: entryTitle(val) };
        }
      }
    }

    // 2) 前方一致(残りパスを継承)。長い順に並べておくこと
    if (Array.isArray(map.prefix)) {
      for (const [from, to, title] of map.prefix) {
        if (path.startsWith(from)) {
          return {
            to: to + path.slice(from.length),
            type: 'prefix',
            title: title || null
          };
        }
      }
    }

    // 3) 正規表現($1, $2 で参照)
    //    - 異常に長い path は ReDoS のリスクがあるため評価対象から除外
    //      (実運用の URL 長は通常 1024 以下、2048 は十分な余裕)
    //    - pattern 不正な行は new RegExp が SyntaxError を投げるが、
    //      その1行だけスキップして他のルールは継続評価する
    //      (デプロイミスで 404 ハンドラ全体が無反応になるのを防ぐ)
    if (Array.isArray(map.regex) && path.length <= 2048) {
      for (const entry of map.regex) {
        try {
          const [pattern, repl, title] = entry;
          const re = new RegExp(pattern);
          if (re.test(path)) {
            return { to: path.replace(re, repl), type: 'regex', title: title || null };
          }
        } catch {
          // 不正な正規表現はスキップ
        }
      }
    }

    return null;
  }

  function buildTarget(toPath) {
    // object 形式の "to" 欠落など、転送先が文字列でない場合は不成立扱い
    if (typeof toPath !== 'string' || !toPath) return null;
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

  // title はプレーンテキストとして esc() を通す(HTML は書けない)
  function titleHtml(title) {
    return title ? `<span class="entry-title">${esc(title)}</span><br>` : '';
  }

  function announceRedirect(target, type, title) {
    let remain = COUNTDOWN_SEC;
    PANEL.className = 'panel found';
    PANEL.innerHTML = `
      <p>ページは下記に移転しました <small>(${type} match)</small>:</p>
      <p class="target">${titleHtml(title)}<a href="${esc(target)}">${esc(target)}</a></p>
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

  const MAX_SUGGEST = 5;

  function showSuggestions(path, map) {
    if (!map.exact) return;
    const cands = similar(path, Object.keys(map.exact), MAX_SUGGEST);
    if (!cands.length) return;

    // 各候補について: 安全ポリシー(javascript:/別オリジン排除)+ 実在(HEAD)を検証し、
    // 「新サイトに現存し、かつ安全」なものだけを最大 MAX_SUGGEST 件表示する。
    // これにより存在しないURL・無関係URLをユーザに提示しない。
    const seen = new Set();
    const checks = cands.map(([oldUrl]) => {
      const val = map.exact[oldUrl];
      const to  = entryTo(val);
      if (typeof to !== 'string' || !to) return Promise.resolve(null);
      let safeUrl;
      try {
        const u = new URL(to, location.origin);
        if (!isSafeTarget(u)) return Promise.resolve(null);
        safeUrl = u.href;
      } catch {
        return Promise.resolve(null);
      }
      if (seen.has(safeUrl)) return Promise.resolve(null);
      seen.add(safeUrl);
      return checkAlive(safeUrl).then(alive =>
        alive === true ? { oldUrl, safeUrl, title: entryTitle(val) } : null);
    });

    Promise.all(checks).then(list => {
      const items = list.filter(Boolean).slice(0, MAX_SUGGEST).map(it =>
        `<li>
        ${titleHtml(it.title)}<a href="${esc(it.safeUrl)}">${esc(it.safeUrl)}</a>
        <br><small>旧: ${esc(it.oldUrl)}</small>
       </li>`).join('');
      if (!items) return;
      SUGGEST.innerHTML =
        '<h3>関連しそうなページ:</h3><ul class="suggest">' + items + '</ul>';
    });
  }

  // 先頭パス階層(=上位区分)の一致数で類似度を測る。
  // 末尾の部分文字列一致は無関係ページ(例: /tiji/ に対して "...itijikin" 等)を
  // 誘発するため用いない。先頭セグメントを1つも共有しない候補は出さない。
  // 実在確認(HEAD)は showSuggestions 側で行うので、ここは多めに返す。
  function similar(target, keys, k) {
    const tParts = target.split('/').filter(Boolean);
    if (!tParts.length) return [];
    return keys.map(key => {
      const parts = key.split('/').filter(Boolean);
      let lead = 0;
      for (let i = 0; i < Math.min(parts.length, tParts.length); i++) {
        if (parts[i] === tParts[i]) lead += 1;
        else break;
      }
      return [key, lead];
    })
    .filter(([, lead]) => lead >= 1)   // 上位区分(先頭セグメント)を最低1つ共有すること
    .sort((a, b) => b[1] - a[1])
    .slice(0, k * 4);                  // HEAD検証で落ちる分を見込んで多めに取る
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
