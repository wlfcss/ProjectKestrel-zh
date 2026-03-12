#!/usr/bin/env python3
"""Standalone local web server for the Project Kestrel visualizer (supersedes backend/editor_bridge.py).

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

WEBVIEW_IMPORT_SUCCESS = False
try:
    import webview  # type: ignore
    WEBVIEW_IMPORT_SUCCESS = True
except Exception:
    pass

import argparse
import json
import os
import sys
import webbrowser

import secrets
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
import threading
from urllib.parse import urlparse
from typing import Set

# --- Extracted modules ---
from settings_utils import load_persisted_settings, save_persisted_settings, log, _normalize
from editor_launch import launch
from queue_manager import _queue_manager
from api_bridge import Api

# Telemetry — failsafe import (never blocks startup)
try:
    import kestrel_telemetry as _telemetry
except ImportError:
    try:
        from analyzer import kestrel_telemetry as _telemetry
    except ImportError:
        _telemetry = None  # type: ignore[assignment]

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
ALLOWED_EDITORS: Set[str] = {
    'system', 'darktable', 'lightroom', 'photoshop', 'capture_one',
    'affinity', 'gimp', 'rawtherapee', 'luminar', 'dxo', 'on1',
    'acdsee', 'paintshop', 'faststone', 'xnview', 'irfanview', 'custom',
}
_default_exts = ['.cr3', '.cr2', '.nef', '.arw', '.dng', '.raf', '.orf', '.rw2', '.sr2', '.jpg', '.jpeg', '.png', '.tif', '.tiff']
ALLOWED_EXTENSIONS: Set[str] = set(os.environ.get('KESTREL_ALLOWED_EXTENSIONS', ','.join(_default_exts)).lower().split(','))
ALLOW_ANY_EXTENSION = os.environ.get('KESTREL_ALLOW_ANY_EXTENSION') == '1'


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


class Handler(SimpleHTTPRequestHandler):
    # Serve from directory of this script (project root) by default.
    def translate_path(self, path: str) -> str:  # type: ignore[override]
        """Resolve file paths robustly across dev, frozen, and installed builds.
        
        Checks multiple locations:
        1. Normal CWD-relative translation (for dev mode)
        2. analyzer/ subfolder (for files like culling.html)
        3. _internal/analyzer/ (for PyInstaller frozen install in Program Files)
        """
        # Try the normal translation first
        resolved = super().translate_path(path)
        if os.path.exists(resolved):
            return resolved
        
        # If not found and path doesn't already contain /analyzer, try analyzer/ prefix
        if not path.startswith('/analyzer'):
            alt = super().translate_path('/analyzer' + path)
            if os.path.exists(alt):
                return alt
        
        # For frozen builds, also check _internal subdirectories
        if getattr(sys, 'frozen', False):
            # Try <exe_dir>/_internal/analyzer/<file>
            try:
                exe_dir = os.path.dirname(sys.executable)
                internal_dir = os.path.join(exe_dir, '_internal')
                alt_path = path.lstrip('/')
                alt = os.path.join(internal_dir, alt_path)
                if os.path.exists(alt):
                    return alt
                # If path already has /analyzer, also check _internal/analyzer/<file>
                if path.startswith('/analyzer'):
                    alt_path = path[1:]  # Strip leading /
                    alt = os.path.join(internal_dir, alt_path)
                    if os.path.exists(alt):
                        return alt
            except Exception:
                pass
            
            # Try _MEIPASS (PyInstaller temp extraction)
            meipass = getattr(sys, '_MEIPASS', None)
            if meipass:
                alt_path = path.lstrip('/')
                alt = os.path.join(meipass, alt_path)
                if os.path.exists(alt):
                    return alt
        
        # Return the original resolution (will 404 if file doesn't exist)
        return resolved

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
        if self.path == '/queue/status':
            self._json(200, _queue_manager.get_status())
            return
        if self.path in ('/', '/index.html'):
            # Prefer analyzer/visualizer.html when present (merged layout).
            # Check multiple locations across dev, frozen, and installed builds.
            def _find_visualizer():
                # List of relative paths to try (from various base dirs)
                candidates = [
                    'analyzer/visualizer.html',
                    'visualizer.html',
                ]
                
                # Check from CWD
                for rel in candidates:
                    full = os.path.join(os.getcwd(), rel)
                    if os.path.exists(full):
                        return '/' + rel
                
                # Check from exe dir (frozen/installed)
                try:
                    exe_dir = os.path.dirname(sys.executable)
                    internal_dir = os.path.join(exe_dir, '_internal')
                    for rel in candidates:
                        full = os.path.join(internal_dir, rel)
                        if os.path.exists(full):
                            return '/' + rel
                except Exception:
                    pass
                
                # Check PyInstaller _MEIPASS
                meipass = getattr(sys, '_MEIPASS', None)
                if meipass:
                    for rel in candidates:
                        full = os.path.join(meipass, rel)
                        if os.path.exists(full):
                            return '/' + rel
                
                # Default fallback
                return '/analyzer/visualizer.html'
            
            self.path = _find_visualizer()
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
        elif parsed.path == '/feedback':
            self.handle_feedback()
        elif parsed.path == '/shutdown':
            self.handle_shutdown()
        elif parsed.path == '/queue/start':
            self.handle_queue_start()
        elif parsed.path in ('/queue/pause', '/queue/resume', '/queue/cancel', '/queue/clear'):
            self.handle_queue_control(parsed.path)
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
                'hint': 'Ensure Settings -> Local Root points to the folder containing your RAW files.'
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

    def _check_auth(self) -> bool:
        """Return True if authenticated (or no token required). Sends 401 and returns False on failure."""
        if AUTH_TOKEN:
            token = self.headers.get('X-Bridge-Token') or ''
            if token != AUTH_TOKEN:
                self._json(401, {'ok': False, 'error': 'Unauthorized'})
                return False
        return True
    def handle_feedback(self):
        """Accept feedback/bug report submissions (browser-mode fallback)."""
        if not self._check_auth():
            return
        try:
            payload = self._read_json()
            if not isinstance(payload, dict):
                self._json(400, {'ok': False, 'error': 'Invalid payload'}); return
            if _telemetry is None:
                self._json(200, {'ok': True, 'note': 'Telemetry unavailable'}); return
            settings = load_persisted_settings()
            machine_id = _telemetry.get_machine_id(settings)
            log_tail = ''
            if payload.get('include_logs', False):
                log_tail = _telemetry.get_recent_log_tail()
            _telemetry.send_feedback(
                report_type=payload.get('type', 'general'),
                description=payload.get('description', ''),
                contact=payload.get('contact', ''),
                screenshot_b64=payload.get('screenshot_b64', ''),
                log_tail=log_tail,
                machine_id=machine_id,
                version=_telemetry._read_version(),
            )
            self._json(200, {'ok': True})
        except Exception as e:
            self._json(400, {'ok': False, 'error': str(e)})

    def handle_queue_start(self):
        if not self._check_auth():
            return
        try:
            payload = self._read_json()
            paths = payload.get('paths', []) if isinstance(payload, dict) else []
            use_gpu = bool(payload.get('use_gpu', True)) if isinstance(payload, dict) else True
            if not isinstance(paths, list):
                self._json(400, {'ok': False, 'error': '"paths" must be a list'}); return
            result = _queue_manager.enqueue(paths, use_gpu=use_gpu)
            self._json(200, {'ok': result['success'], **result})
        except Exception as e:
            self._json(400, {'ok': False, 'error': str(e)})

    def handle_queue_control(self, path: str):
        if not self._check_auth():
            return
        if path == '/queue/pause':
            self._json(200, {'ok': True, **_queue_manager.pause()})
        elif path == '/queue/resume':
            self._json(200, {'ok': True, **_queue_manager.resume()})
        elif path == '/queue/cancel':
            self._json(200, {'ok': True, **_queue_manager.cancel()})
        elif path == '/queue/clear':
            self._json(200, {'ok': True, **_queue_manager.clear_done()})
        else:
            self._json(404, {'ok': False, 'error': 'Not found'})


def parse_args():
    ap = argparse.ArgumentParser(description='Serve Project Kestrel visualizer with local /open bridge.')
    ap.add_argument('--port', type=int, default=8765, help='Port to listen on (default 8765)')
    ap.add_argument('--no-browser', action='store_true', help='Do not auto-open a browser window')
    ap.add_argument('--windowed', action='store_true', help='Open in a desktop window (requires pywebview) [default]')
    ap.add_argument('--no-windowed', action='store_true', help='Disable windowed mode and use the system browser')
    ap.add_argument('--root', default='', help='Default root folder for RAW originals (client can override unless KESTREL_ALLOWED_ROOT set)')
    return ap.parse_args()


def main():
    args = parse_args()
    # When visualizer.py is run from inside analyzer/ (merged layout) set
    # the working directory to the repository root so assets and shared
    # files (assets/, visualizer files) are served correctly.
    # If frozen by PyInstaller (onedir), prefer the bundled _internal folder
    # inside the distribution so static assets (visualizer.html, logos) are
    # served from the on-disk bundle.
    if getattr(sys, 'frozen', False):
        meipass = getattr(sys, '_MEIPASS', None) or os.path.dirname(sys.executable)
        candidate = os.path.join(meipass, '_internal')
        if os.path.isdir(candidate):
            os.chdir(candidate)
        elif meipass and os.path.isdir(meipass):
            os.chdir(meipass)
        else:
            # Fallback to repo-root relative when running unpacked
            os.chdir(os.path.join(os.path.dirname(os.path.abspath(__file__)), '..') or '.')
    else:
        os.chdir(os.path.join(os.path.dirname(os.path.abspath(__file__)), '..') or '.')
    server = ThreadingHTTPServer((HOST, args.port), Handler)
    log(f'Serving visualizer at http://{HOST}:{args.port}/  (Press Ctrl+C to stop)')
    log('Ephemeral bridge token (auto-injected):', AUTH_TOKEN[:8] + '…')

    # ── Settings init: ensure machine_id and version are persisted ──
    try:
        if _telemetry is not None:
            _init_settings = load_persisted_settings()
            _telemetry.get_machine_id(_init_settings)
            _init_settings['version'] = _telemetry._read_version()
            save_persisted_settings(_init_settings)
    except Exception:
        pass  # failsafe

    if args.root:
        log('Default root (client-supplied):', args.root)
    url = f'http://{HOST}:{args.port}/'
    if args.no_windowed:
        args.windowed = False
    else:
        args.windowed = True
    if args.windowed and not WEBVIEW_IMPORT_SUCCESS:
        log('pywebview not available; falling back to system browser')
        args.windowed = False
    else:
        log('Windowed mode enabled; using pywebview' if args.windowed else 'Windowed mode disabled; using system browser')
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
            api = Api() # start maximized
            api._server_port = args.port
            win = webview.create_window('Project Kestrel', url, js_api=api, maximized=True)
            api._main_window = win

            # When the analysis queue is running, intercept the close event so the
            # window minimizes to the taskbar instead of killing mid-analysis.
            def _on_closing():
                # Check for unsaved changes via the Python-side flag
                # (avoid evaluate_js here — it deadlocks because closing runs on the GUI thread)
                has_unsaved = getattr(api, '_has_unsaved_changes', False)

                # When an analysis is running or paused, prompt the user with
                # options to Minimize, Exit (cancel) or Cancel the close.
                if _queue_manager.is_running or _queue_manager.is_paused:
                    try:
                        # Use native Windows MessageBox if available for a simple
                        # three-button prompt. Fallback to tkinter dialog when not.
                        if sys.platform.startswith('win'):
                            import ctypes
                            MB_YESNOCANCEL = 0x00000003
                            MB_ICONQUESTION = 0x00000020
                            title = 'Analysis in progress'
                            if _queue_manager.is_paused:
                                msg = 'Analysis is paused. Exit Project Kestrel? You can re-open later to resume.'
                            else:
                                msg = 'Analysis is in progress. Cancel analysis and exit?'
                            resp = ctypes.windll.user32.MessageBoxW(0, msg, title, MB_YESNOCANCEL | MB_ICONQUESTION)
                            # IDYES=6 -> Exit (cancel analysis and close)
                            # IDNO=7  -> Minimize instead of closing
                            # IDCANCEL=2 -> Do not close
                            if resp == 6:
                                try:
                                    _queue_manager.cancel()
                                except Exception:
                                    pass
                                return True
                            if resp == 7:
                                try:
                                    win.minimize()
                                except Exception:
                                    pass
                                return False
                            return False
                        else:
                            # Tkinter fallback
                            import tkinter as _tk
                            from tkinter import messagebox as _mb
                            root = _tk.Tk()
                            root.withdraw()
                            if _queue_manager.is_paused:
                                msg = 'Analysis is paused. Exit Project Kestrel? You can re-open later to resume.'
                            else:
                                msg = 'Analysis is in progress. Cancel analysis and exit?'
                            res = _mb.askyesnocancel('Analysis in progress', msg)
                            root.destroy()
                            # askyesnocancel returns True=Yes, False=No, None=Cancel
                            if res is True:
                                try:
                                    _queue_manager.cancel()
                                except Exception:
                                    pass
                                return True
                            if res is False:
                                try:
                                    win.minimize()
                                except Exception:
                                    pass
                                return False
                            return False
                    except Exception:
                        # If the prompt fails, fall back to minimizing when running
                        try:
                            win.minimize()
                        except Exception:
                            pass
                        return False

                # Prompt for unsaved changes when no analysis is running
                if has_unsaved:
                    try:
                        if sys.platform.startswith('win'):
                            import ctypes
                            MB_YESNO = 0x00000004
                            MB_ICONWARNING = 0x00000030
                            msg = 'You have unsaved changes that will be lost. Close anyway?'
                            title = 'Unsaved Changes'
                            resp = ctypes.windll.user32.MessageBoxW(0, msg, title, MB_YESNO | MB_ICONWARNING)
                            if resp == 6:  # Yes – close and discard
                                return True
                            return False  # No – don't close
                        else:
                            import tkinter as _tk
                            from tkinter import messagebox as _mb
                            root = _tk.Tk()
                            root.withdraw()
                            res = _mb.askyesno('Unsaved Changes',
                                               'You have unsaved changes that will be lost. Close anyway?')
                            root.destroy()
                            if res:
                                return True
                            return False
                            return True
                    except Exception:
                        return True  # on failure, allow close

                return True  # allow normal close

            try:
                win.events.closing += _on_closing
            except Exception:
                pass  # older pywebview versions may not support this event

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
    try:
        main()
    except KeyboardInterrupt:
        pass
    except Exception as _main_exc:
        # Top-level crash handler — send crash report before re-raising
        try:
            import traceback as _tb
            if _telemetry is not None:
                _crash_settings = load_persisted_settings()
                _crash_mid = _telemetry.get_machine_id(_crash_settings)
                
                # Fetch recent log tail, passing the active folder's log if available
                _folder_path = _crash_settings.get('active_analysis_path', '')
                if _folder_path:
                    _log_tail = _telemetry.get_recent_log_tail(folder_path=_folder_path)
                else:
                    _log_tail = _telemetry.get_recent_log_tail()
                
                _telemetry.send_crash_report(
                    exc=_main_exc,
                    tb_str=_tb.format_exc(),
                    log_tail=_log_tail,
                    machine_id=_crash_mid,
                    version=_telemetry._read_version(),
                )
                # Give daemon thread a moment to fire off the HTTP request
                import time as _t
                _t.sleep(2)
        except Exception:
            pass  # crash handler itself must never hide the real error
        raise
