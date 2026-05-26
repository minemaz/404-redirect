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
    new_url TEXT NOT NULL
  );

  CREATE TABLE prefix_map (
    old_prefix TEXT PRIMARY KEY,
    new_prefix TEXT NOT NULL
  );
  CREATE INDEX idx_prefix_len ON prefix_map(LENGTH(old_prefix) DESC);

  CREATE TABLE regex_map (
    id      INTEGER PRIMARY KEY AUTOINCREMENT,
    pattern TEXT NOT NULL,
    repl    TEXT NOT NULL
  );
`);

const insExact  = db.prepare('INSERT INTO exact_map  (old_url, new_url)       VALUES (?, ?)');
const insPrefix = db.prepare('INSERT INTO prefix_map (old_prefix, new_prefix) VALUES (?, ?)');
const insRegex  = db.prepare('INSERT INTO regex_map  (pattern, repl)          VALUES (?, ?)');

const total = db.transaction(() => {
  let n = 0;
  for (const [from, to] of Object.entries(m.exact  || {})) { insExact.run(from, to);  n++; }
  for (const [from, to] of (m.prefix || []))               { insPrefix.run(from, to); n++; }
  for (const [pat,  rep] of (m.regex  || []))              { insRegex.run(pat, rep);  n++; }
  return n;
})();

db.exec('VACUUM');
db.close();

const sz = fs.statSync(dst).size;
console.log(`Built ${dst}: ${total} entries, ${(sz / 1024).toFixed(1)} KB`);
