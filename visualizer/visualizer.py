#!/usr/bin/env python3
"""Standalone local web server for the Kestrel visualizer (supersedes backend/editor_bridge.py).

Features:
 - Serves the existing visualizer.html (and any static assets in the folder).
 - Exposes the /open endpoint (same contract as backend/editor_bridge.py) so the
   web UI can open originals in the configured editor.
 - Intended to be frozen into a single executable with PyInstaller.

Usage (development):
    python visualizer/visualizer.py --port 8765 --root C:\Photos\Trip

After starting it will open the default browser at http://127.0.0.1:<port>/ .

Build single-file EXE (example):
    pyinstaller --onefile --name kestrel_viz visualizer/visualizer.py

Optionally set env vars (same as editor_bridge):
  KESTREL_ALLOWED_ROOT=C:\Photos\Trip  (restrict paths)
  KESTREL_BRIDGE_TOKEN=secret              (require auth header)
  KESTREL_ALLOWED_EXTENSIONS=.cr3,.jpg,... (override allowed list)
  KESTREL_ALLOW_ANY_EXTENSION=1            (disable extension filtering)

"""
from __future__ import annotations
windowed_available = False
_webview_import_error = None
try:
    import webview  # type: ignore
    windowed_available = True
except Exception as e:
    _webview_import_error = repr(e)
import argparse
import json
import os
import sys
import subprocess
import webbrowser
import secrets
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
import threading
from urllib.parse import urlparse
from typing import Set

HOST = '127.0.0.1'

# --- Security / behavior configuration (env override matches editor_bridge) ---
ALLOWED_ROOT = os.environ.get('KESTREL_ALLOWED_ROOT')
if ALLOWED_ROOT:
    ALLOWED_ROOT = os.path.abspath(os.path.expanduser(ALLOWED_ROOT))

AUTH_TOKEN = os.environ.get('KESTREL_BRIDGE_TOKEN')
if not AUTH_TOKEN:
    # Generate an ephemeral token per run; injected into served page via /bridge_config.js
    AUTH_TOKEN = secrets.token_urlsafe(32)
MAX_REQUEST_BYTES = int(os.environ.get('KESTREL_MAX_REQUEST_BYTES', '4096'))
ALLOWED_EDITORS: Set[str] = {'system', 'darktable', 'lightroom'}
_default_exts = ['.cr3', '.cr2', '.nef', '.arw', '.dng', '.raf', '.orf', '.rw2', '.sr2', '.jpg', '.jpeg', '.png', '.tif', '.tiff']
ALLOWED_EXTENSIONS: Set[str] = set(os.environ.get('KESTREL_ALLOWED_EXTENSIONS', ','.join(_default_exts)).lower().split(','))
ALLOW_ANY_EXTENSION = os.environ.get('KESTREL_ALLOW_ANY_EXTENSION') == '1'

# Cache for discovered darktable executable on Windows
_DARKTABLE_EXE = None

SETTINGS_FILENAME = 'settings.json'

def _find_darktable_exe() -> str:
    """Best-effort discovery of darktable.exe on Windows.

    Many installs place darktable in one of:
      C:\\Program Files\\darktable\\bin\\darktable.exe
      C:\\Program Files\\darktable\\darktable.exe
      C:\\Program Files (x86)\\darktable\\bin\\darktable.exe
    We also scan PATH entries. Falls back to 'darktable.exe'.
    """
    global _DARKTABLE_EXE
    if _DARKTABLE_EXE and os.path.exists(_DARKTABLE_EXE):
        return _DARKTABLE_EXE
    candidates = [
        os.path.join(os.environ.get('ProgramFiles', ''), 'darktable', 'bin', 'darktable.exe'),
        os.path.join(os.environ.get('ProgramFiles', ''), 'darktable', 'darktable.exe'),
        os.path.join(os.environ.get('ProgramFiles(x86)', ''), 'darktable', 'bin', 'darktable.exe'),
    ]
    # Add PATH search
    for p in os.environ.get('PATH', '').split(os.pathsep):
        if not p:
            continue
        exe = os.path.join(p, 'darktable.exe')
        candidates.append(exe)
    for exe in candidates:
        if exe and os.path.exists(exe):
            _DARKTABLE_EXE = exe
            return exe
    return 'darktable.exe'


def _get_user_data_dir() -> str:
    if sys.platform.startswith('win'):
        base = os.environ.get('LOCALAPPDATA') or os.environ.get('APPDATA') or os.path.expanduser('~')
        return os.path.join(base, 'KestrelVisualizer')
    if sys.platform == 'darwin':
        return os.path.join(os.path.expanduser('~'), 'Library', 'Application Support', 'KestrelVisualizer')
    base = os.environ.get('XDG_DATA_HOME') or os.path.join(os.path.expanduser('~'), '.local', 'share')
    return os.path.join(base, 'kestrel-visualizer')


def _get_settings_path() -> str:
    return os.path.join(_get_user_data_dir(), SETTINGS_FILENAME)


def load_persisted_settings() -> dict:
    path = _get_settings_path()
    try:
        with open(path, 'r', encoding='utf-8') as f:
            data = json.load(f)
            return data if isinstance(data, dict) else {}
    except FileNotFoundError:
        return {}
    except Exception:
        return {}


def save_persisted_settings(data: dict) -> None:
    if not isinstance(data, dict):
        raise ValueError('Settings payload must be an object')
    path = _get_settings_path()
    os.makedirs(os.path.dirname(path), exist_ok=True)
    tmp = path + '.tmp'
    with open(tmp, 'w', encoding='utf-8') as f:
        json.dump(data, f, indent=2, sort_keys=True)
    os.replace(tmp, path)


def log(*args):
    print('[serve]', *args, file=sys.stderr)


def _normalize(p: str) -> str:
    if not p:
        return ''
    p = os.path.expanduser(p)
    if (p.startswith('"') and p.endswith('"')) or (p.startswith("'") and p.endswith("'")):
        p = p[1:-1]
    return os.path.normpath(p)


def build_original_path(root: str, rel: str) -> str:
    if ALLOWED_ROOT:
        root = ALLOWED_ROOT
    else:
        root = _normalize(root) if root else ''
    rel = _normalize(rel) if rel else ''
    if not rel or os.path.isabs(rel):
        return ''
    base = os.path.join(root, rel) if root else rel
    return os.path.abspath(base)


def _is_within_root(path: str) -> bool:
    if not path:
        return False
    if not ALLOWED_ROOT:
        return True
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


def launch(path: str, editor: str):
    if not os.path.exists(path):
        raise FileNotFoundError(path)
    # Windows
    if sys.platform.startswith('win'):
        if editor == 'darktable':
            dt = _find_darktable_exe()
            try:
                subprocess.Popen([dt, path]); return
            except FileNotFoundError:
                log('darktable not found at', dt, 'falling back to system default')
        if editor == 'lightroom':
            # Common Lightroom Classic executable names/locations
            lr_candidates = [
                os.path.join(os.environ.get('ProgramFiles', ''), 'Adobe', 'Adobe Lightroom Classic', 'Lightroom.exe'),
                os.path.join(os.environ.get('ProgramFiles', ''), 'Adobe', 'Lightroom', 'Lightroom.exe'),
                'lightroom.exe',
                'Lightroom.exe'
            ]
            for exe in lr_candidates:
                if exe and os.path.exists(exe):
                    try:
                        subprocess.Popen([exe, path]); return
                    except Exception:
                        continue
            # Fallback to system default if Lightroom not found
        os.startfile(path)  # type: ignore[attr-defined]
        return
    # macOS
    if sys.platform == 'darwin':
        if editor == 'darktable':
            try: subprocess.Popen(['open', '-a', 'darktable', path]); return
            except Exception: pass
        if editor == 'lightroom':
            # macOS Lightroom app bundle name (Classic)
            try: subprocess.Popen(['open', '-a', 'Adobe Lightroom Classic', path]); return
            except Exception: pass
        subprocess.Popen(['open', path]); return
    # Linux / other
    if editor == 'darktable':
        try: subprocess.Popen(['flatpak', 'run', 'org.darktable.Darktable', path]); return
        except FileNotFoundError: pass
    if editor == 'lightroom':
        # Linux users may have a wrapper script named lightroom; attempt it
        try: subprocess.Popen(['lightroom', path]); return
        except FileNotFoundError: pass
    subprocess.Popen(['xdg-open', path])
class Handler(SimpleHTTPRequestHandler):
    # Serve from directory of this script (project root) by default.
    def translate_path(self, path: str) -> str:  # type: ignore[override]
        return super().translate_path(path)

    def end_headers(self):  # Inject basic headers (no wildcard CORS; same-origin only)
        self.send_header('Cache-Control', 'no-store')
        super().end_headers()

    def do_GET(self):  # type: ignore[override]
        # Dynamic token/config injection script
        if self.path == '/bridge_config.js':
            body = (
                f"// Generated at runtime\n"
                f"window.__BRIDGE_TOKEN='{AUTH_TOKEN}';\n"
                f"window.__BRIDGE_ORIGIN=window.location.origin;\n"
            ).encode('utf-8')
            self.send_response(200)
            self.send_header('Content-Type', 'application/javascript')
            self.send_header('Cache-Control', 'no-store')
            self.end_headers()
            self.wfile.write(body)
            return
        if self.path == '/settings':
            self._json(200, {'ok': True, 'settings': load_persisted_settings()})
            return
        if self.path in ('/', '/index.html'):
            if os.path.exists('visualizer.html'):
                self.path = '/visualizer.html'
        return super().do_GET()

    def do_OPTIONS(self):  # Minimal preflight (only allow same-origin JS; token still required)
        origin = self.headers.get('Origin')
        if origin and origin != f'http://{HOST}:{self.server.server_port}':  # type: ignore[attr-defined]
            self.send_response(403); self.end_headers(); return
        self.send_response(204)
        self.send_header('Access-Control-Allow-Origin', origin or f'http://{HOST}:{self.server.server_port}')  # type: ignore[attr-defined]
        self.send_header('Access-Control-Allow-Headers', 'Content-Type,X-Bridge-Token')
        self.send_header('Access-Control-Allow-Methods', 'POST, OPTIONS')
        self.end_headers()

    def do_POST(self):  # type: ignore[override]
        parsed = urlparse(self.path)
        if parsed.path == '/open':
            self.handle_open()
        elif parsed.path == '/settings':
            self.handle_settings()
        elif parsed.path == '/shutdown':
            self.handle_shutdown()
        else:
            self.send_response(404); self.end_headers(); self.wfile.write(b'{}')

    def _read_json(self):
        length = int(self.headers.get('Content-Length', 0))
        if length > MAX_REQUEST_BYTES:
            raise ValueError('Request too large')
        raw = self.rfile.read(length) if length else b''
        if not raw:
            return {}
        return json.loads(raw.decode('utf-8'))

    def _json(self, status: int, obj):
        body = json.dumps(obj).encode('utf-8')
        self.send_response(status)
        self.send_header('Content-Type', 'application/json')
        # Only echo same-origin to mitigate unsolicited cross-origin token use
        self.send_header('Access-Control-Allow-Origin', f'http://{HOST}:{self.server.server_port}')  # type: ignore[attr-defined]
        self.end_headers()
        self.wfile.write(body)

    def handle_open(self):
        if AUTH_TOKEN:
            token = self.headers.get('X-Bridge-Token') or ''
            if token != AUTH_TOKEN:
                self._json(401, {'ok': False, 'error': 'Unauthorized'}); return
        # Basic origin check (best-effort; Origin may be absent for some requests)
        origin = self.headers.get('Origin')
        expected_origin = f'http://{HOST}:{self.server.server_port}'  # type: ignore[attr-defined]
        if origin and origin != expected_origin:
            self._json(403, {'ok': False, 'error': 'Origin mismatch'}); return
        try:
            payload = self._read_json()
        except Exception as e:
            self._json(400, {'ok': False, 'error': str(e)}); return
        log('payload', payload)
        root = payload.get('root')
        rel = payload.get('relative')
        editor = (payload.get('editor') or 'system')
        if isinstance(editor, str):
            editor = editor.strip().lower()
        else:
            editor = 'system'
        if editor not in ALLOWED_EDITORS:
            editor = 'system'
        target = build_original_path(root, rel)
        log('open', editor, root, rel, '->', target)
        if not target:
            self._json(400, {'ok': False, 'error': 'Invalid path'}); return
        if not _is_within_root(target):
            self._json(403, {'ok': False, 'error': 'Path escapes allowed root'}); return
        if not os.path.exists(target):
            self._json(404, {
                'ok': False,
                'error': 'File not found',
                'target': target,
                'hint': 'Ensure Settings → Local Root points to the folder containing your RAW files.'
            }); return
        if not _extension_allowed(target):
            self._json(415, {'ok': False, 'error': 'Extension not allowed', 'target': target, 'allowed': sorted(ALLOWED_EXTENSIONS)}); return
        try:
            launch(target, editor)
            self._json(200, {'ok': True, 'path': target})
        except Exception as e:
            self._json(500, {'ok': False, 'error': str(e)})

    def handle_shutdown(self):
        # Require token (always) to prevent CSRF/drive-by shutdown
        if AUTH_TOKEN:
            token = self.headers.get('X-Bridge-Token') or ''
            if token != AUTH_TOKEN:
                self._json(401, {'ok': False, 'error': 'Unauthorized'}); return
        log('Received shutdown request from client; scheduling server shutdown.')
        # Respond first, then shutdown asynchronously so reply is delivered
        self._json(200, {'ok': True, 'message': 'Shutting down'})
        def _shutdown():
            try:
                # slight delay to let response flush
                import time; time.sleep(0.25)
                self.server.shutdown()
            except Exception as e:  # noqa: BLE001
                log('Error during shutdown:', e)
        threading.Thread(target=_shutdown, daemon=True).start()

    def handle_settings(self):
        if AUTH_TOKEN:
            token = self.headers.get('X-Bridge-Token') or ''
            if token != AUTH_TOKEN:
                self._json(401, {'ok': False, 'error': 'Unauthorized'}); return
        origin = self.headers.get('Origin')
        expected_origin = f'http://{HOST}:{self.server.server_port}'  # type: ignore[attr-defined]
        if origin and origin != expected_origin:
            self._json(403, {'ok': False, 'error': 'Origin mismatch'}); return
        try:
            payload = self._read_json()
            settings = payload.get('settings') if isinstance(payload, dict) else None
            if not isinstance(settings, dict):
                raise ValueError('Invalid settings payload')
            save_persisted_settings(settings)
            self._json(200, {'ok': True})
        except Exception as e:
            self._json(400, {'ok': False, 'error': str(e)})


def parse_args():
    ap = argparse.ArgumentParser(description='Serve Kestrel visualizer with local /open bridge.')
    ap.add_argument('--port', type=int, default=8765, help='Port to listen on (default 8765)')
    ap.add_argument('--no-browser', action='store_true', help='Do not auto-open a browser window')
    ap.add_argument('--windowed', action='store_true', help='Open in a desktop window (requires pywebview) [default]')
    ap.add_argument('--no-windowed', action='store_true', help='Disable windowed mode and use the system browser')
    ap.add_argument('--root', default='', help='Default root folder for RAW originals (client can override unless KESTREL_ALLOWED_ROOT set)')
    return ap.parse_args()


def main():
    args = parse_args()
    os.chdir(os.path.dirname(os.path.abspath(__file__)) or '.')
    server = ThreadingHTTPServer((HOST, args.port), Handler)
    log(f'Serving visualizer at http://{HOST}:{args.port}/  (Press Ctrl+C to stop)')
    log('Ephemeral bridge token (auto-injected):', AUTH_TOKEN[:8] + '…')
    if args.root:
        log('Default root (client-supplied):', args.root)
    url = f'http://{HOST}:{args.port}/'
    if args.no_windowed:
        args.windowed = False
    else:
        args.windowed = True
    if args.windowed:
        if not windowed_available:
            log('Windowed mode disabled: failed to import pywebview:', _webview_import_error)
        args.windowed = windowed_available
    if args.windowed:
        def _serve():
            try:
                server.serve_forever()
            except Exception:
                pass
        t = threading.Thread(target=_serve, daemon=True)
        t.start()
        try:
            log('Starting windowed UI via pywebview...')
            webview.create_window('Kestrel Visualizer', url)
            webview.start()
        except Exception as e:
            log('Windowed mode failed at runtime; falling back to browser:', repr(e))
            try:
                webbrowser.open(url)
            except Exception:
                pass
        finally:
            server.shutdown()
            server.server_close()
            log('Server stopped.')
    else:
        if not args.no_browser:
            try:
                webbrowser.open(url)
            except Exception:
                pass
        try:
            server.serve_forever()
        except KeyboardInterrupt:
            pass
        finally:
            server.server_close()
            log('Server stopped.')


if __name__ == '__main__':
    main()
