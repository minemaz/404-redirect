#!/usr/bin/env python3
"""
404-redirect E2E テストスイート

実 redirects.js を headless Chrome 上で動かし、攻撃シナリオが
すべてブロックされ、正常シナリオが通過することを実 DOM レベルで
検証する。

依存: python3 (3.8+), google-chrome
    Chrome バイナリ位置は環境変数 CHROME で上書き可。
"""

import http.server
import os
import re
import shutil
import signal
import socket
import subprocess
import sys
import tempfile
import threading

HERE         = os.path.dirname(os.path.realpath(__file__))
PROJECT_ROOT = os.path.realpath(os.path.join(HERE, '..'))
FIXTURE      = os.path.join(HERE, 'fixtures', 'attack-map.json')
ORIG_MAP     = os.path.join(PROJECT_ROOT, 'redirects', 'map.json')
BACKUP       = ORIG_MAP + '.e2e-backup'
CHROME       = os.environ.get('CHROME', 'google-chrome')
# 他の chrome インスタンスと profile を共有しないよう専用ディレクトリ
USER_DATA    = tempfile.mkdtemp(prefix='404-e2e-chrome-')
# 共有ホスト環境では cold start が秒オーダーで揺れるため余裕を持たせる
CHROME_TIMEOUT = int(os.environ.get('CHROME_TIMEOUT', '45'))


# ---------------------------------------------------------------------------
# ErrorDocument 相当の最小 HTTP サーバ
# ---------------------------------------------------------------------------

class Handler(http.server.SimpleHTTPRequestHandler):
    """未存在 URL でも 404 ステータスで 404.html の本文を返す。
    本番の Apache `ErrorDocument 404 /404.html` 相当。"""
    def __init__(self, *a, **k):
        super().__init__(*a, directory=PROJECT_ROOT, **k)

    def do_GET(self):
        translated = self.translate_path(self.path.split('?', 1)[0])
        if os.path.isfile(translated):
            return super().do_GET()
        with open(os.path.join(PROJECT_ROOT, '404.html'), 'rb') as f:
            body = f.read()
        self.send_response(404)
        self.send_header('Content-Type', 'text/html; charset=utf-8')
        self.send_header('Content-Length', str(len(body)))
        self.send_header('Cache-Control', 'no-store')
        self.end_headers()
        self.wfile.write(body)

    def log_message(self, *_):
        pass  # サーバログは抑制


def pick_port():
    s = socket.socket()
    s.bind(('127.0.0.1', 0))
    port = s.getsockname()[1]
    s.close()
    return port


# ---------------------------------------------------------------------------
# DOM 採取 & パース
# ---------------------------------------------------------------------------

def dump_dom(url):
    r = subprocess.run([
        CHROME, '--headless', '--disable-gpu', '--no-sandbox',
        f'--user-data-dir={USER_DATA}',
        '--virtual-time-budget=2500',
        '--dump-dom', url,
    ], capture_output=True, text=True, timeout=CHROME_TIMEOUT)
    if r.returncode != 0:
        sys.stderr.write(f'[chrome stderr]\n{r.stderr}\n')
    return r.stdout


PANEL_RE = re.compile(r'<div id="panel"([^>]*)>(.*?)</div>', re.S)
SUGG_RE  = re.compile(r'<div [^>]*id="suggestions"[^>]*>(.*?)</div>', re.S)
CLS_RE   = re.compile(r'class="panel ([\w-]+)"')
LINK_RE  = re.compile(r'<a [^>]*href="([^"]+)"')
# <script src="/redirects/redirects.js"> は元 HTML 由来。それ以外の script タグは注入の疑い
SCRIPT_INJ_RE = re.compile(r'<script(?![^>]*src="/redirects/)', re.I)
# 動的に挿入された on* ハンドラ属性
EVENT_INJ_RE  = re.compile(r'\son(?:click|error|load|focus|mouseover|mouseenter|toggle)\s*=', re.I)


def parse(html):
    panel_attrs, panel_body = '', ''
    m = PANEL_RE.search(html)
    if m:
        panel_attrs, panel_body = m.group(1), m.group(2)

    sugg_body = ''
    m = SUGG_RE.search(html)
    if m:
        sugg_body = m.group(1)

    panel_class = ''
    m = CLS_RE.search(panel_attrs)
    if m:
        panel_class = m.group(1)

    links = []
    for block in (panel_body, sugg_body):
        for m in LINK_RE.finditer(block):
            links.append(m.group(1))

    return dict(
        panelClass=panel_class,
        links=links,
        scriptInj=bool(SCRIPT_INJ_RE.search(html)),
        eventInj=bool(EVENT_INJ_RE.search(html)),
    )


# ---------------------------------------------------------------------------
# シナリオ定義
#   (name, attack-path, expected panel.class, list of substrings that must
#    appear in dynamic links — empty list means "no dyn links at all")
# ---------------------------------------------------------------------------

SCENARIOS = [
    ('A1  直値 javascript:',                  '/direct-js',                       'missing', []),
    ('A2  regex キャプチャ→javascript:',     '/redir/javascript:alert(1)',       'missing', []),
    ('A3  data: URI',                         '/data-uri',                        'missing', []),
    ('A4  file: スキーム',                    '/file-leak',                       'missing', []),
    ('A5  絶対クロスオリジン',                '/abs-cross',                       'missing', []),
    ('A6  プロトコル相対',                    '/r//evil.com/phish',               'missing', []),
    ('OK1 regex 正常転送',                    '/article/1234.html',               'found',   ['/posts/1234']),
    ('OK2 prefix 正常転送',                   '/safe-old/page.html',              'found',   ['/safe-new/page.html']),
    ('OK3 exact 正常転送',                    '/q/foo',                           'found',   ['/safe']),
    ('SUG サジェスト欄が javascript: を除外', '/q/unknown',                       'missing', ['/safe']),
]


def assert_scenario(observed, want_class, want_link_subs):
    issues = []
    if observed['panelClass'] != want_class:
        issues.append(
            f'panelClass: want={want_class!r} got={observed["panelClass"]!r}')

    for sub in want_link_subs:
        if not any(sub in l for l in observed['links']):
            issues.append(f'expected link containing {sub!r}, got {observed["links"]}')

    if want_class == 'missing' and not want_link_subs and observed['links']:
        issues.append(f'expected no dyn links, got {observed["links"]}')

    for l in observed['links']:
        if not l.startswith(('http:', 'https:')):
            issues.append(f'DANGEROUS scheme in link: {l!r}')

    if observed['scriptInj']:
        issues.append('SCRIPT TAG INJECTION DETECTED')
    if observed['eventInj']:
        issues.append('EVENT HANDLER ATTR INJECTION DETECTED')

    return issues


# ---------------------------------------------------------------------------
# entry point
# ---------------------------------------------------------------------------

def restore_map():
    if os.path.exists(BACKUP):
        try:
            shutil.move(BACKUP, ORIG_MAP)
        except Exception as e:
            sys.stderr.write(f'WARNING: failed to restore map.json: {e}\n')


def on_signal(signum, _frame):
    restore_map()
    sys.exit(128 + signum)


def main():
    # 前回の異常終了で残った backup を検出 → 手動チェックを促す
    if os.path.exists(BACKUP):
        sys.stderr.write(
            f'ERROR: leftover backup at {BACKUP}\n'
            '  Previous run did not clean up. Inspect both files manually:\n'
            f'    {ORIG_MAP}\n'
            f'    {BACKUP}\n'
            '  Restore correct content and remove the backup file.\n')
        sys.exit(2)

    # シグナル受信時も map を復元してから抜ける
    signal.signal(signal.SIGINT,  on_signal)
    signal.signal(signal.SIGTERM, on_signal)

    shutil.copy(ORIG_MAP, BACKUP)
    shutil.copy(FIXTURE, ORIG_MAP)

    http.server.ThreadingHTTPServer.allow_reuse_address = True
    port = pick_port()
    srv  = http.server.ThreadingHTTPServer(('127.0.0.1', port), Handler)
    threading.Thread(target=srv.serve_forever, daemon=True).start()
    print(f'serving http://127.0.0.1:{port}  docroot={PROJECT_ROOT}\n')

    passed = failed = 0
    try:
        for name, path, want_class, want_links in SCENARIOS:
            url = f'http://127.0.0.1:{port}{path}'
            html = dump_dom(url)
            obs  = parse(html)
            issues = assert_scenario(obs, want_class, want_links)
            if issues:
                print(f'FAIL  {name}')
                for i in issues:
                    print(f'      - {i}')
                if os.environ.get('VERBOSE'):
                    print(f'      observed: {obs}')
                failed += 1
            else:
                print(f'PASS  {name}')
                passed += 1
    finally:
        srv.shutdown()
        restore_map()
        shutil.rmtree(USER_DATA, ignore_errors=True)

    print(f'\n=== {passed} passed, {failed} failed ===')
    sys.exit(0 if failed == 0 else 1)


if __name__ == '__main__':
    main()
