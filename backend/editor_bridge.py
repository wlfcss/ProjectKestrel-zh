#!/usr/bin/env python3
# Simple local HTTP bridge to open files in an editor from the web visualizer.
# Start:  python backend/editor_bridge.py
# POST /open { "root": "C:/Photos/Trip", "relative": "IMG_0123.CR3", "editor": "system|darktable|photoshop" }

import json
import os
import sys
import subprocess
from http.server import BaseHTTPRequestHandler, HTTPServer
from urllib.parse import urlparse

HOST = '127.0.0.1'
PORT = 8765


def log(*args):
    print('[bridge]', *args, file=sys.stderr)


def _normalize(p: str) -> str:
    if not p:
        return ''
    # Expand ~ and normalize separators
    p = os.path.expanduser(p)
    # Strip surrounding quotes if any
    if (p.startswith('"') and p.endswith('"')) or (p.startswith("'") and p.endswith("'")):
        p = p[1:-1]
    return os.path.normpath(p)


def build_original_path(root, rel):
    root = _normalize(root) if root else ''
    rel = _normalize(rel) if rel else ''
    if not rel:
        return ''
    # Ensure rel is not treated as absolute accidentally
    if os.path.isabs(rel):
        # If the relative is absolute (unexpected), trust it as-is
        path = rel
    else:
        path = os.path.join(root, rel) if root else rel
    return os.path.abspath(path)


def launch(path, editor):
    # editor: 'system' | 'darktable' | 'photoshop'
    if not os.path.exists(path):
        raise FileNotFoundError(path)

    # Windows
    if sys.platform.startswith('win'):
        if editor == 'darktable':
            subprocess.Popen(['darktable.exe', path])
            return
        if editor == 'photoshop':
            # Photoshop command if in PATH; otherwise rely on file assoc
            try:
                subprocess.Popen(['photoshop.exe', path])
                return
            except FileNotFoundError:
                pass
        os.startfile(path)
        return

    # macOS
    if sys.platform == 'darwin':
        if editor == 'darktable':
            try:
                subprocess.Popen(['open', '-a', 'darktable', path])
                return
            except Exception:
                pass
        if editor == 'photoshop':
            try:
                subprocess.Popen(['open', '-a', 'Adobe Photoshop', path])
                return
            except Exception:
                pass
        subprocess.Popen(['open', path])
        return

    # Linux/other
    if editor == 'darktable':
        try:
            subprocess.Popen(['darktable', path])
            return
        except FileNotFoundError:
            pass
    if editor == 'photoshop':
        # Not typically available; users may alias via wine
        try:
            subprocess.Popen(['photoshop', path])
            return
        except FileNotFoundError:
            pass
    subprocess.Popen(['xdg-open', path])


class Handler(BaseHTTPRequestHandler):
    def _set_headers(self, status=200, ct='application/json'):
        self.send_response(status)
        self.send_header('Content-Type', ct)
        # Allow local page to call us (same machine)
        self.send_header('Access-Control-Allow-Origin', '*')
        self.send_header('Access-Control-Allow-Headers', 'Content-Type')
        self.send_header('Access-Control-Allow-Methods', 'POST, OPTIONS')
        self.end_headers()

    def do_OPTIONS(self):
        self._set_headers(204)

    def do_POST(self):
        parsed = urlparse(self.path)
        if parsed.path == '/open':
            self.handle_open()
        else:
            self._set_headers(404)
            self.wfile.write(b'{}')

    def handle_open(self):
        length = int(self.headers.get('Content-Length', 0))
        raw = self.rfile.read(length) if length else b''
        try:
            payload = json.loads(raw.decode('utf-8') or '{}')
        except Exception:
            self._set_headers(400)
            self.wfile.write(json.dumps({'ok': False, 'error': 'Invalid JSON'}).encode('utf-8'))
            return

        root = payload.get('root')
        rel = payload.get('relative')
        editor = (payload.get('editor') or 'system').lower()

        target = build_original_path(root, rel)
        log('Open request editor=', editor, 'root=', root, 'rel=', rel, '->', target)

        if not target or not os.path.exists(target):
            self._set_headers(404)
            self.wfile.write(json.dumps({
                'ok': False,
                'error': 'File not found',
                'target': target,
                'hint': 'Ensure Settings → Local Root points to the folder containing your RAW files.'
            }).encode('utf-8'))
            return
        try:
            launch(target, editor)
            self._set_headers(200)
            self.wfile.write(json.dumps({'ok': True, 'path': target}).encode('utf-8'))
        except Exception as e:
            log('Launch failed:', e)
            self._set_headers(500)
            self.wfile.write(json.dumps({'ok': False, 'error': str(e)}).encode('utf-8'))


def main():
    server = HTTPServer((HOST, PORT), Handler)
    log(f'Started on http://{HOST}:{PORT}')
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        pass
    finally:
        server.server_close()


if __name__ == '__main__':
    main()
