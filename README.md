# 404-redirect

サイト大規模リニューアル後の旧 URL を、404 ページ上の JavaScript で新 URL へ
自動転送するための仕組み。

ErrorDocument が返す内部 404 サブリクエストでは URL バーが旧 URL のまま保たれる
ため、JS から `location.pathname` で旧 URL を直接取得できる。これに対して
旧→新マッピングを引き、自動転送するか、見つからない時は類似 URL を提示する。

## 特徴

- ErrorDocument の差し替えだけで導入できる(サーバ側 rewrite ルールに手を入れない)
- **完全一致 / 前方一致(残りパス継承)/ 正規表現** の 3 段で柔軟にマッチ
- 各エントリに省略可能な **title(説明文)** を付けると転送案内・候補提示に表示
- クエリ・フラグメントを継承
- 5 秒カウントダウン + キャンセル可能(WCAG の自動リダイレクト要件配慮)
- **転送先・候補は表示直前に HEAD で実在確認**し、存在しない(404/410)URL は
  転送も提示もしない(移転先が後日削除された場合の 404→404 二重遷移を防ぐ)
- 該当なし時は**同一区分(先頭パスを共有)に限って**候補提示
  (無関係な部分文字列一致は出さない)
- 未登録 404 を `sendBeacon` で収集する枠を内蔵
- 格納形式は **JSON**(本命)と **SQLite/sql.js (WASM)**(数万件超向け)の 2 系統

## ファイル構成

```
404.html                          ErrorDocument が返す本体
redirects/
  redirects.js                    JSON 版 lookup (本命)
  redirects-sqlite.js             SQLite/sql.js (WASM) 版 lookup
  map.json                        旧→新マッピング(編集対象)
  build-sqlite.js                 map.json → map.sqlite ビルダ
server-config.txt                 Apache / Nginx / 静的ホスト設定例
package.json                      SQLite 版用 npm スクリプト
```

## 導入手順

### 1. ファイルを配置

```
/                404.html を置く
/redirects/      redirects ディレクトリ一式を置く
```

### 2. サーバを設定

Apache:

```apache
ErrorDocument 404 /404.html
```

Nginx:

```nginx
error_page 404 /404.html;
location = /404.html { internal; }
```

詳細および静的ホスティングサービス(Netlify / Vercel)の例は
[`server-config.txt`](server-config.txt) を参照。

### 3. マッピングを編集

`redirects/map.json` を実 URL に合わせて編集する。

```json
{
  "exact": {
    "/old/about.html": "/about",
    "/contact.php":    { "to": "/contact", "title": "お問い合わせ" }
  },
  "prefix": [
    ["/blog/old/", "/blog/", "ブログ"]
  ],
  "regex": [
    ["^/article/(\\d+)\\.html$", "/posts/$1", "記事"]
  ]
}
```

#### マッチ評価順序

1. **exact** — 完全一致(末尾スラッシュの有無は吸収)
2. **prefix** — 前方一致。残りのパスを引き継ぐ。**長い順に並べておくこと**
3. **regex** — 正規表現。`$1`, `$2` で後方参照可

クエリ文字列とフラグメントは、新 URL 側で明示していなければ元 URL から継承する。

#### title(説明文)の付け方

転送先 URL だけでなく「どんなページか」を利用者に見せたい場合、
エントリごとに省略可能な title を付けられる:

- **exact** — 値を文字列の代わりに `{ "to": "/contact", "title": "お問い合わせ" }` と書く
- **prefix / regex** — 第3要素として `["旧", "新", "タイトル"]` のように書く

title があると、自動転送の案内パネルとサジェスト候補の両方で URL の上に
表示される。プレーンテキスト扱いで、表示時に HTML エスケープされる
(HTML タグを書いても効かない)。

## SQLite 版へ切り替える

数万件規模になったら sql.js(SQLite を Emscripten で WASM 化したもの)を使う:

```sh
npm install
npm run build      # map.sqlite を生成 + sql-wasm.{js,wasm} を redirects/ に配置
```

`404.html` の script タグを下記に差し替える:

```html
<script src="/redirects/sql-wasm.js"></script>
<script src="/redirects/redirects-sqlite.js"></script>
```

DB の各テーブルには nullable な `title` カラムがあり、`map.json` の
title がそのまま格納される。title カラムを持たない旧形式の `map.sqlite`
に対しても `redirects-sqlite.js` はフォールバックして動作する
(title 表示だけが無効になる)。

## トレードオフ

|              | JSON 版                 | SQLite/sql.js 版        |
|--------------|------------------------|--------------------------|
| 追加転送量   | 数 KB〜数百 KB          | WASM 約 250KB + DB       |
| 初期化       | 即時                    | WASM 読込で数百 ms       |
| 〜数千件     | 単純・高速              | オーバースペック         |
| 数万件超     | O(n) で重くなる         | インデックスで有利       |
| デプロイ     | `map.json` を置くだけ   | ビルド工程が要る         |

迷ったら **JSON 版** を選ぶ。

## セキュリティ

### コードでブロックしているもの

| 攻撃 | 防御 |
|---|---|
| `<a href="javascript:...">` 経由の XSS | 解決後 URL の protocol を `http:` / `https:` のみに制限 |
| `data:` / `file:` / `blob:` / `vbscript:` 経由の XSS | 同上 |
| `//evil.com/...` プロトコル相対 URL でのオープンリダイレクト | 解決後 URL の origin を同一オリジンに制限 |
| `https://evil.com/...` 絶対 URL でのオープンリダイレクト | 同上(`CROSS_ORIGIN_ALLOWLIST` で明示許可可能) |
| 正規表現キャプチャから javascript URL 生成 | 上記スキーム検証で阻止 |
| サジェスト候補リンク経由の XSS | 表示時にも同じ安全ポリシーを適用 |
| title(説明文)経由の XSS | プレーンテキスト扱いで `esc()` によりエスケープ |
| HTML エスケープ漏れ(`<`, `>`, `"`, `'`, `&`) | innerHTML へ入る全ユーザ入力部分で `esc()` 適用 |
| Prototype 汚染 | `Object.hasOwn` でキー存在確認、`JSON.parse` 利用 |

別ドメインへ意図的に転送したい場合は `redirects.js` / `redirects-sqlite.js`
の `CROSS_ORIGIN_ALLOWLIST` にオリジンを明示追加する。

### サーバ側で必ず設定すべきもの(多層防御)

- HTTPS 強制(map.json の MITM 改ざんを防ぐ)
- `Content-Security-Policy` — 設定例は [`server-config.txt`](server-config.txt)
- `X-Content-Type-Options: nosniff`
- `Referrer-Policy: strict-origin-when-cross-origin`
- `X-Frame-Options: DENY`(クリックジャッキング防止)

### 残るリスク(運用責任で対処)

- **`map.json` の改ざん**: 静的ファイルなので配置サーバが侵害された場合は
  任意リダイレクトが可能。デプロイパイプラインと配信ストレージのアクセス制御で守る。
- **正規表現の ReDoS**: コード側で path 長 > 2048 のときの regex 評価は
  自動スキップするが、それ以下の長さでも catastrophic regex
  (`(.+)+x` の類)は admin 側で書かないこと。レビュー時に確認。
- **`CROSS_ORIGIN_ALLOWLIST` の subdomain takeover**: ここに登録した
  サブドメインを後で手放した場合、攻撃者が DNS / CDN 残骸を奪うと
  公式 404 経由で被害者を任意サイトへ誘導できる。**所有を確実に
  維持できるオリジンだけを記載**し、退役時はリストからも除く。

## 高トラフィック運用での注意

### map.json のバージョニング(キャッシュ即時無効化)

現状の `cache: 'force-cache'` 構成では、誤マッピングを push しても
ブラウザキャッシュに古い `map.json` が残り、緊急差替えが効かない。
本番では下記のいずれかを推奨:

- **バージョン付き URL**(推奨): デプロイごとにファイル名へハッシュを
  付与(`map-{git-sha}.json`)し `Cache-Control: public, max-age=31536000, immutable`
  で配信。`redirects.js` 冒頭の `MAP_URL` をデプロイ時に書き換える。
- **短い max-age**: `Cache-Control: public, max-age=300` に切り替え、
  代わりに ETag/If-None-Match で 304 を返してサーバ負荷を抑える。

### SEO(検索流入の保護)

JS による redirect は Googlebot が JS 評価をスキップ/タイムアウトする
ケースで 404 のまま de-index される可能性がある。**検索流入の多い
トップ旧 URL は server 側 301 で対応**し、本仕組みは long tail
(膨大で server config に書ききれない URL 群)の救済に充てるのが望ましい。

### CDN・キャッシュ・ヘッダ

- `404.html` / `redirects.js` も含めて全て CDN に乗せる
- 404 レスポンスにも CSP / HSTS / COOP 等を必ず付与
  (詳細は [`server-config.txt`](server-config.txt))
- map.json は HTTPS 必須(中間者改ざん防止)

## 未登録 404 の収集(任意)

`redirects/redirects.js` の `logEvent` 内のコメントアウトを有効化すると、
未マッピング 404 を `/api/404-log` へ `sendBeacon` で送る。
集まったログから順次マッピングを拡充できる。

## ローカル動作確認

```sh
npm run serve            # python3 -m http.server 8080 のショートカット
# http://localhost:8080/old/about.html  などへアクセス
```

`map.json` のサンプルマッピング(`/old/about.html` → `/about` 等)で
exact / prefix / regex すべての挙動を確認できる。

## ライセンス

[MIT License](LICENSE) — Copyright (c) 2026 Hiroki Minematsu
