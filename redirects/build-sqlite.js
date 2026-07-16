#!/usr/bin/env node
/*
 * map.json から map.sqlite を生成する
 *
 * 使い方:
 *   npm i better-sqlite3
 *   node build-sqlite.js [map.json] [map.sqlite]
 *
 * sql.js 配布物の取得(別途必要):
 *   npm i sql.js
 *   cp node_modules/sql.js/dist/sql-wasm.js   ./
 *   cp node_modules/sql.js/dist/sql-wasm.wasm ./
 */

const Database = require('better-sqlite3');
const fs = require('fs');
const path = require('path');

const [, , srcArg = 'map.json', dstArg = 'map.sqlite'] = process.argv;
const src = path.resolve(srcArg);
const dst = path.resolve(dstArg);

fs.rmSync(dst, { force: true });

const m = JSON.parse(fs.readFileSync(src, 'utf8'));
const db = new Database(dst);

db.exec(`
  PRAGMA journal_mode = OFF;
  PRAGMA synchronous  = OFF;
  PRAGMA page_size    = 4096;

  CREATE TABLE exact_map (
    old_url TEXT PRIMARY KEY,
    new_url TEXT NOT NULL,
    title   TEXT
  );

  CREATE TABLE prefix_map (
    old_prefix TEXT PRIMARY KEY,
    new_prefix TEXT NOT NULL,
    title      TEXT
  );
  CREATE INDEX idx_prefix_len ON prefix_map(LENGTH(old_prefix) DESC);

  CREATE TABLE regex_map (
    id      INTEGER PRIMARY KEY AUTOINCREMENT,
    pattern TEXT NOT NULL,
    repl    TEXT NOT NULL,
    title   TEXT
  );
`);

const insExact  = db.prepare('INSERT INTO exact_map  (old_url, new_url, title)       VALUES (?, ?, ?)');
const insPrefix = db.prepare('INSERT INTO prefix_map (old_prefix, new_prefix, title) VALUES (?, ?, ?)');
const insRegex  = db.prepare('INSERT INTO regex_map  (pattern, repl, title)          VALUES (?, ?, ?)');

// exact の値は "新URL" 文字列 または { to, title } オブジェクトの2形式
function normExact(v) {
  if (typeof v === 'string') return { to: v, title: null };
  if (v && typeof v.to === 'string') {
    return { to: v.to, title: typeof v.title === 'string' ? v.title : null };
  }
  throw new Error(`invalid exact entry: ${JSON.stringify(v)}`);
}

const total = db.transaction(() => {
  let n = 0;
  for (const [from, v] of Object.entries(m.exact || {})) {
    const { to, title } = normExact(v);
    insExact.run(from, to, title);
    n++;
  }
  // prefix / regex の第3要素は省略可能な title
  for (const [from, to, title] of (m.prefix || [])) { insPrefix.run(from, to, title ?? null); n++; }
  for (const [pat,  rep, title] of (m.regex  || [])) { insRegex.run(pat, rep, title ?? null);  n++; }
  return n;
})();

db.exec('VACUUM');
db.close();

const sz = fs.statSync(dst).size;
console.log(`Built ${dst}: ${total} entries, ${(sz / 1024).toFixed(1)} KB`);
