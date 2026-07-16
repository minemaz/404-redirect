/*
 * 旧URL→新URL リダイレクトテーブル lookup (SQLite / sql.js / WASM 版)
 *
 * 想定する配置物:
 *   /redirects/sql-wasm.js       (sql.js loader: Emscripten 経由でビルドされた SQLite)
 *   /redirects/sql-wasm.wasm     (上記の wasm 本体)
 *   /redirects/map.sqlite        (build-sqlite.js で生成した DB)
 *
 * 404.html 側で sql-wasm.js を本ファイルより先に読み込んでおくこと:
 *   <script src="/redirects/sql-wasm.js"></script>
 *   <script src="/redirects/redirects-sqlite.js"></script>
 *
 * テーブル定義(build-sqlite.js 参照):
 *   exact_map  (old_url TEXT PRIMARY KEY, new_url TEXT NOT NULL, title TEXT)
 *   prefix_map (old_prefix TEXT PRIMARY KEY, new_prefix TEXT NOT NULL, title TEXT)
 *     ※ old_prefix には LIKE のメタ文字 % _ を含めないこと
 *   regex_map  (id INTEGER PRIMARY KEY AUTOINCREMENT, pattern TEXT, repl TEXT, title TEXT)
 *
 * title は転送案内に説明文として表示される(NULL 可)。
 * title カラムを持たない旧形式の map.sqlite でもフォールバックして動作する。
 *
 * JSON 版との比較:
 *   - 起動コスト: 約 250KB〜1MB の WASM 読み込みが入るので JSON より遅い
 *   - 検索コスト: B-tree インデックスを使うため、数万件規模では JSON より速い
 *   - JSON 版で十分なら JSON 版を推奨。数万件超の場合に本版へ切替を検討。
 */

(async () => {
  'use strict';

  const STATUS = document.getElementById('status');
  const PANEL  = document.getElementById('panel');
  const COUNTDOWN_SEC = 5;

  // ---- セキュリティ設定 -------------------------------------------------
  // 同一オリジンへの転送のみ既定で許可。詳細は redirects.js と同じ。
  const CROSS_ORIGIN_ALLOWLIST = Object.freeze([
    // 'https://en.example.com',
  ]);
  // ----------------------------------------------------------------------

  const origPath   = location.pathname;
  const origSearch = location.search;
  const origHash   = location.hash;

  STATUS.textContent = `「${origPath}」の転送先を検索中… (SQLite 初期化中)`;

  let db;
  try {
    if (typeof window.initSqlJs !== 'function') {
      throw new Error('initSqlJs が見つかりません(sql-wasm.js が未読込)');
    }
    const SQL = await window.initSqlJs({
      locateFile: f => '/redirects/' + f
    });
    const buf = await fetch('/redirects/map.sqlite', { cache: 'force-cache' })
                .then(r => r.ok ? r.arrayBuffer()
                                : Promise.reject(new Error('HTTP ' + r.status)));
    db = new SQL.Database(new Uint8Array(buf));
  } catch (e) {
    console.error('[404] sql.js init failed:', e);
    setPanel('missing', '転送DBの読み込みに失敗しました。');
    return;
  }

  try {
    const hit = lookup(db, origPath);
    if (hit) {
      const target = buildTarget(hit.to);
      if (target) {
        announceRedirect(target, hit.type, hit.title);
      } else {
        // 危険スキーム / 許可外オリジン → 転送せず案内のみ
        console.warn('[404] resolved target rejected by safety policy:', hit);
        setPanel('missing', '該当する移転先が見つかりませんでした。');
      }
    } else {
      setPanel('missing', '該当する移転先が見つかりませんでした。');
    }
  } finally {
    db.close();
  }

  // ---------- safety ----------

  // 詳細は redirects.js の同名関数のコメント参照。
  function isSafeTarget(url) {
    if (url.protocol !== 'http:' && url.protocol !== 'https:') return false;
    if (url.origin === location.origin) return true;
    return CROSS_ORIGIN_ALLOWLIST.includes(url.origin);
  }

  // ---------- matching ----------

  function lookup(db, path) {
    // title カラムを持たない旧形式 DB とのデプロイずれ(新JS + 旧DB)でも
    // 404 ハンドラ全体が無反応にならないよう、有無を確認してフォールバックする。
    // 3テーブルは build-sqlite.js が同時に生成するため exact_map の確認で代表する。
    let hasTitle = true;
    try {
      db.exec('SELECT title FROM exact_map LIMIT 0');
    } catch {
      hasTitle = false;
    }
    const titleCol = hasTitle ? ', title' : '';
    const rowTitle = row => (hasTitle && row.title) || null;

    // 1) 完全一致(末尾スラッシュの有無を吸収)
    const variants = path.endsWith('/')
      ? [path, path.slice(0, -1)]
      : [path, path + '/'];

    const exactHit = queryOne(db,
      `SELECT new_url${titleCol} FROM exact_map WHERE old_url = ? LIMIT 1`,
      variants);
    if (exactHit) {
      return { to: exactHit.new_url, type: 'exact', title: rowTitle(exactHit) };
    }

    // 2) 前方一致(最長一致)
    //    LIKE の左辺 = ユーザ入力パス、右辺 = 'old_prefix' || '%'
    //    old_prefix は我々が管理する静的データなので % _ は含めない前提
    //    → エスケープ不要、ユーザ入力側もそのまま渡せる
    const sPrefix = db.prepare(
      `SELECT old_prefix, new_prefix${titleCol}
         FROM prefix_map
         WHERE ? LIKE old_prefix || '%'
         ORDER BY LENGTH(old_prefix) DESC
         LIMIT 1`);
    try {
      sPrefix.bind([path]);
      if (sPrefix.step()) {
        const row = sPrefix.getAsObject();
        return {
          to: row.new_prefix + path.slice(row.old_prefix.length),
          type: 'prefix',
          title: rowTitle(row)
        };
      }
    } finally {
      sPrefix.free();
    }

    // 3) 正規表現(SQLite 標準では REGEXP 関数未実装のため JS 側で評価)
    //    詳細は redirects.js の同じブロックを参照: 長 path で ReDoS を回避し、
    //    不正な pattern は当該ルールだけスキップする。
    if (path.length <= 2048) {
      const sRegex = db.prepare(
        `SELECT pattern, repl${titleCol} FROM regex_map ORDER BY id`);
      try {
        while (sRegex.step()) {
          const row = sRegex.getAsObject();
          try {
            const re = new RegExp(row.pattern);
            if (re.test(path)) {
              return {
                to: path.replace(re, row.repl),
                type: 'regex',
                title: rowTitle(row)
              };
            }
          } catch {
            // 不正な正規表現はスキップ
          }
        }
      } finally {
        sRegex.free();
      }
    }

    return null;
  }

  // 与えられたパラメータ群を順に試して、最初にヒットした行を返す共通ヘルパ
  function queryOne(db, sql, params) {
    const stmt = db.prepare(sql);
    try {
      for (const p of params) {
        stmt.bind(Array.isArray(p) ? p : [p]);  // bind は内部で reset 呼び済み
        if (stmt.step()) return stmt.getAsObject();
      }
      return null;
    } finally {
      stmt.free();
    }
  }

  function buildTarget(toPath) {
    if (typeof toPath !== 'string' || !toPath) return null;
    let target;
    try {
      target = new URL(toPath, location.origin);
    } catch {
      return null;
    }
    if (!isSafeTarget(target)) return null;
    if (!target.search && origSearch) target.search = origSearch;
    if (!target.hash   && origHash)   target.hash   = origHash;
    return target.href;
  }

  // ---------- UI ----------

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
      cd.parentElement.innerHTML =
        '自動転送をキャンセルしました。上記リンクから手動で移動してください。';
    };
    document.getElementById('go').onclick = () => {
      clearInterval(timer);
      location.replace(target);
    };
  }

  function setPanel(cls, html) {
    PANEL.className = 'panel ' + cls;
    PANEL.innerHTML = html;
  }
  function esc(s) {
    return String(s).replace(/[&<>"']/g, c =>
      ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
  }
})();
