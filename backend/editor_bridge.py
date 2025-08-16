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
from typing import Set

HOST = '127.0.0.1'
PORT = 8765

# --- Security / behavior configuration ---
# Optional fixed root directory (overrides client-provided root) to constrain file access.
ALLOWED_ROOT = os.environ.get('KESTREL_ALLOWED_ROOT')
if ALLOWED_ROOT:
    ALLOWED_ROOT = os.path.abspath(os.path.expanduser(ALLOWED_ROOT))

# Optional shared secret token. If set, clients must send header: X-Bridge-Token: <token>
AUTH_TOKEN = os.environ.get('KESTREL_BRIDGE_TOKEN')

# Maximum size of a JSON request body (bytes)
MAX_REQUEST_BYTES = int(os.environ.get('KESTREL_MAX_REQUEST_BYTES', '4096'))

# Allowed editor values; anything else falls back to 'system'
ALLOWED_EDITORS: Set[str] = {'system', 'darktable', 'photoshop'}

# Allowed file extensions (lowercase, including the dot). Adjust via env var if needed.
_default_exts = ['.cr3', '.cr2', '.nef', '.arw', '.dng', '.raf', '.orf', '.rw2', '.sr2', '.jpg', '.jpeg', '.png', '.tif', '.tiff']
ALLOWED_EXTENSIONS: Set[str] = set(os.environ.get('KESTREL_ALLOWED_EXTENSIONS', ','.join(_default_exts)).lower().split(','))

# If set ("1"), allow any extension (disables ALLOWED_EXTENSIONS filtering)
ALLOW_ANY_EXTENSION = os.environ.get('KESTREL_ALLOW_ANY_EXTENSION') == '1'


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
    """Return an absolute candidate path without yet enforcing root containment.

    If ALLOWED_ROOT is configured, the provided root parameter from the client is ignored.
    Absolute rel paths are rejected (return ''). This prevents arbitrary file access
    when a malicious webpage attempts to POST an absolute system path.
    """
    # If a fixed root is configured server-side, ignore client-supplied root entirely.
    if ALLOWED_ROOT:
        root = ALLOWED_ROOT
    else:
        root = _normalize(root) if root else ''

    rel = _normalize(rel) if rel else ''
    if not rel:
        return ''
    if os.path.isabs(rel):
        # Reject absolute paths coming from the client.
        return ''
    base = os.path.join(root, rel) if root else rel
    return os.path.abspath(base)


def _is_within_root(path: str) -> bool:
    """Return True if path is within the allowed root (if any configured)."""
    if not path:
        return False
    if not ALLOWED_ROOT:
        return True  # No restriction configured
    try:
        common = os.path.commonpath([os.path.realpath(path), os.path.realpath(ALLOWED_ROOT)])
        return common == os.path.realpath(ALLOWED_ROOT)
    except Exception:
        return False


def _extension_allowed(path: str) -> bool:
    if ALLOW_ANY_EXTENSION:
        return True
    _, ext = os.path.splitext(path)
    return ext.lower() in ALLOWED_EXTENSIONS


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
        # Enforce auth token if configured
        if AUTH_TOKEN:
            provided = self.headers.get('X-Bridge-Token')
            if not provided or provided != AUTH_TOKEN:
                self._set_headers(401)
                self.wfile.write(json.dumps({'ok': False, 'error': 'Unauthorized'}).encode('utf-8'))
                return

        length = int(self.headers.get('Content-Length', 0))
        if length > MAX_REQUEST_BYTES:
            self._set_headers(413)
            self.wfile.write(json.dumps({'ok': False, 'error': 'Request entity too large'}).encode('utf-8'))
            return
        raw = self.rfile.read(length) if length else b''
        try:
            payload = json.loads(raw.decode('utf-8') or '{}')
        except Exception:
            self._set_headers(400)
            self.wfile.write(json.dumps({'ok': False, 'error': 'Invalid JSON'}).encode('utf-8'))
            return

        root = payload.get('root')  # May be ignored if ALLOWED_ROOT set
        rel = payload.get('relative')
        editor = (payload.get('editor') or 'system').lower()
        if editor not in ALLOWED_EDITORS:
            editor = 'system'

        target = build_original_path(root, rel)
        log('Open request editor=', editor, 'root=', root, 'rel=', rel, '->', repr(target))

        if not target:
            self._set_headers(400)
            self.wfile.write(json.dumps({'ok': False, 'error': 'Invalid or empty path'}).encode('utf-8'))
            return

        if not _is_within_root(target):
            self._set_headers(403)
            self.wfile.write(json.dumps({'ok': False, 'error': 'Path escapes allowed root'}).encode('utf-8'))
            return

        if not os.path.exists(target):
            self._set_headers(404)
            self.wfile.write(json.dumps({
                'ok': False,
                'error': 'File not found',
                'target': target,
                'hint': 'Ensure Settings → Local Root points to the folder containing your RAW files.'
            }).encode('utf-8'))
            return

        if not _extension_allowed(target):
            self._set_headers(415)
            self.wfile.write(json.dumps({'ok': False, 'error': 'Extension not allowed'}).encode('utf-8'))
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
