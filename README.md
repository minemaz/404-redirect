# 404-redirect

サイト大規模リニューアル後の旧 URL を、404 ページ上の JavaScript で新 URL へ
自動転送するための仕組み。

ErrorDocument が返す内部 404 サブリクエストでは URL バーが旧 URL のまま保たれる
ため、JS から `location.pathname` で旧 URL を直接取得できる。これに対して
旧→新マッピングを引き、自動転送するか、見つからない時は類似 URL を提示する。

## 特徴

- ErrorDocument の差し替えだけで導入できる(サーバ側 rewrite ルールに手を入れない)
- **完全一致 / 前方一致(残りパス継承)/ 正規表現** の 3 段で柔軟にマッチ
- クエリ・フラグメントを継承
- 5 秒カウントダウン + キャンセル可能(WCAG の自動リダイレクト要件配慮)
- 該当なし時は階層類似度で候補提示
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
    "/old/about.html": "/about"
  },
  "prefix": [
    ["/blog/old/", "/blog/"]
  ],
  "regex": [
    ["^/article/(\\d+)\\.html$", "/posts/$1"]
  ]
}
```

#### マッチ評価順序

1. **exact** — 完全一致(末尾スラッシュの有無は吸収)
2. **prefix** — 前方一致。残りのパスを引き継ぐ。**長い順に並べておくこと**
3. **regex** — 正規表現。`$1`, `$2` で後方参照可

クエリ文字列とフラグメントは、新 URL 側で明示していなければ元 URL から継承する。

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

## トレードオフ

|              | JSON 版                 | SQLite/sql.js 版        |
|--------------|------------------------|--------------------------|
| 追加転送量   | 数 KB〜数百 KB          | WASM 約 250KB + DB       |
| 初期化       | 即時                    | WASM 読込で数百 ms       |
| 〜数千件     | 単純・高速              | オーバースペック         |
| 数万件超     | O(n) で重くなる         | インデックスで有利       |
| デプロイ     | `map.json` を置くだけ   | ビルド工程が要る         |

迷ったら **JSON 版** を選ぶ。

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
