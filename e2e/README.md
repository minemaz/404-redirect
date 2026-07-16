# e2e — 実機 E2E テストキット

実 `redirects/redirects.js` を **headless Chrome 上で動作させ**、
攻撃シナリオがブロックされ正常シナリオが通過することを実 DOM レベルで
検証する。jsdom など追加ランタイムは使わず、手元にある python3 と
google-chrome のみで完結する。

## 必要なもの

- `python3` (3.8+)
- `google-chrome` — パスは環境変数 `CHROME` で上書き可
- **追加の npm/pip 依存はゼロ**

## 実行

```sh
python3 e2e/run-tests.py
```

終了コードは `0`(全 PASS)または `1`(1件以上 FAIL)。
CI に直結できる。詳細出力が欲しい場合は `VERBOSE=1` を付ける。

## 仕組み

1. リポジトリ直下を docroot として **`ErrorDocument 404 /404.html`
   相当の最小 HTTP サーバ**を起動(空きポートを自動選択)
2. `redirects/map.json` を `fixtures/attack-map.json` に一時差替え
   (実行終了 / SIGINT / SIGTERM 時に元へ自動復元)
3. 各シナリオの URL を
   `google-chrome --headless --dump-dom --virtual-time-budget=2500ms`
   で開き、JS 実行後の DOM をパース
4. 観測点を期待値に突き合わせて assert
   - `#panel` の class が `found` / `missing` どちらか
   - 動的に挿入された `<a href>` の値とスキーム
   - `<script>` タグ追加注入の有無
   - 動的 event handler 属性 (`onclick=` 等)の有無

## シナリオ一覧

| ID  | path                         | 検証内容                                                |
|-----|------------------------------|---------------------------------------------------------|
| A1  | `/direct-js`                 | map 直値の `javascript:` URL が拒否される               |
| A2  | `/redir/javascript:alert(1)` | regex キャプチャ経由の `javascript:` 注入が拒否される   |
| A3  | `/data-uri`                  | `data:` スキームが拒否される                            |
| A4  | `/file-leak`                 | `file:` スキームが拒否される                            |
| A5  | `/abs-cross`                 | 絶対 URL によるクロスオリジン転送が拒否される           |
| A6  | `/r//evil.com/phish`         | プロトコル相対オープンリダイレクトが拒否される          |
| OK1 | `/article/1234.html`         | 正規表現の正常転送(title 併記)                        |
| OK2 | `/safe-old/page.html`        | 前方一致の正常転送(title なしでも動く)                |
| OK3 | `/q/foo`                     | 完全一致の正常転送                                      |
| OK4 | `/q/titled`                  | exact の `{ to, title }` オブジェクト形式 + title 表示  |
| T1  | `/q/eviltitle`               | title 内の HTML がエスケープされ script 注入されない    |
| SUG | `/q/unknown`                 | サジェスト欄で `javascript:` 候補が除外される           |
| DEAD| `/deadzone/page`             | 転送先が404(HEAD実在確認で不在)なら転送も案内もしない  |
| ORP | `/zzz-orphan-section/foo`    | 未マッチ&同一区分キー無し→候補を一切出さない            |

A2 は同時に `[unclosed-bracket` という**構文不正 regex** を fixture に
混入させてある。これにより後続ルールが正常評価されることで「不正 regex
混在でも 404 ハンドラ全体が落ちない」という耐性 fix の挙動も併せて
保証される。

## 拡張

新しい攻撃ベクトルを追加する場合:

1. `fixtures/attack-map.json` に該当ルール(`exact` / `prefix` / `regex`)を追加
2. `run-tests.py` の `SCENARIOS` テーブルに行を1つ追加
   `(name, attack_path, expected_panel_class, expected_link_substrings
   [, expected_body_text_substrings])` の形式

## クラッシュ時のリカバリ

シグナル捕捉と `try/finally` で `redirects/map.json` を自動復元する。
万一それも飛んだ場合は `redirects/map.json.e2e-backup` が残っているので
手動で戻す。次回起動時、`.e2e-backup` が残っているとテストは安全のため
即座に `exit 2` する。
