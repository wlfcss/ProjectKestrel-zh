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
class Api:
    """JavaScript API exposed to webview for native file/folder operations."""
    
    def choose_directory(self):
        """Open native folder picker dialog.
        Returns: absolute path to selected folder, or None if cancelled.
        """
        print(f"[API] choose_directory() called (platform: {sys.platform})", flush=True)
        try:
            if sys.platform == 'darwin':
                # macOS: Use AppleScript to show folder picker
                import subprocess
                script = 'POSIX path of (choose folder with prompt "Select folder containing analyzed photos")'
                result = subprocess.run(
                    ['osascript', '-e', script],
                    capture_output=True,
                    text=True,
                    timeout=120
                )
                if result.returncode == 0 and result.stdout.strip():
                    selected_path = result.stdout.strip()
                    print(f"[API] choose_directory() -> Success: {selected_path}", flush=True)
                    return selected_path
                print("[API] choose_directory() -> Cancelled by user", flush=True)
                return None
            elif sys.platform.startswith('win'):
                # Windows: Use tkinter folder dialog
                import tkinter as tk
                from tkinter import filedialog
                root = tk.Tk()
                root.withdraw()  # Hide the root window
                root.attributes('-topmost', True)  # Bring dialog to front
                folder = filedialog.askdirectory(title="Select folder containing analyzed photos")
                root.destroy()
                if folder:
                    print(f"[API] choose_directory() -> Success: {folder}", flush=True)
                    return folder
                else:
                    print("[API] choose_directory() -> Cancelled by user", flush=True)
                    return None
            else:
                # Linux: Use tkinter as well
                import tkinter as tk
                from tkinter import filedialog
                root = tk.Tk()
                root.withdraw()
                folder = filedialog.askdirectory(title="Select folder containing analyzed photos")
                root.destroy()
                if folder:
                    print(f"[API] choose_directory() -> Success: {folder}", flush=True)
                    return folder
                else:
                    print("[API] choose_directory() -> Cancelled by user", flush=True)
                    return None
        except Exception as e:
            print(f"[API] choose_directory() -> Error: {e}", flush=True)
            log(f"Error in choose_directory: {e}")
            return None
    
    def read_kestrel_csv(self, folder_path):
        """Read the kestrel_database.csv from the given folder path.
        
        Args:
            folder_path: Absolute path to folder (may be parent folder or .kestrel folder itself)
            
        Returns:
            dict with 'success': bool, 'data': str (CSV content), 'error': str, 'path': str, 'root': str
        """
        print(f"[API] read_kestrel_csv() called with folder_path: {folder_path}", flush=True)
        try:
            import os
            
            # Normalize path: remove trailing separators to ensure reliable basename detection
            folder_path = folder_path.strip()
            while folder_path and folder_path[-1] in ('/', '\\'):
                folder_path = folder_path[:-1]
            
            if not folder_path:
                raise ValueError("Empty folder path")
            
            print(f"[API] Normalized folder_path: {folder_path}", flush=True)
            
            # Determine if this IS the .kestrel folder or contains one
            folder_name = os.path.basename(folder_path)
            print(f"[API] Folder name: '{folder_name}'", flush=True)
            
            is_kestrel_folder = (folder_name == '.kestrel')
            print(f"[API] Is .kestrel folder: {is_kestrel_folder}", flush=True)
            
            if is_kestrel_folder:
                # User selected the .kestrel folder directly
                csv_path = os.path.join(folder_path, 'kestrel_database.csv')
                parent_folder = os.path.dirname(folder_path)
                print(f"[API] Selected .kestrel folder directly. Parent: {parent_folder}", flush=True)
            else:
                # User selected a parent folder; look for .kestrel subfolder
                csv_path = os.path.join(folder_path, '.kestrel', 'kestrel_database.csv')
                parent_folder = folder_path
                print(f"[API] Selected parent folder. Will look for .kestrel subfolder.", flush=True)
            
            if not os.path.exists(csv_path):
                print(f"[API] read_kestrel_csv() -> CSV not found at: {csv_path}", flush=True)
                return {
                    'success': False,
                    'error': f'Could not find kestrel_database.csv at: {csv_path}',
                    'path': csv_path,
                    'data': ''
                }
            
            with open(csv_path, 'r', encoding='utf-8') as f:
                data = f.read()
            
            print(f"[API] read_kestrel_csv() -> Success: Read {len(data)} bytes from {csv_path}", flush=True)
            return {
                'success': True,
                'data': data,
                'error': '',
                'path': csv_path,
                'root': parent_folder
            }
        except Exception as e:
            print(f"[API] read_kestrel_csv() -> Error: {e}", flush=True)
            return {
                'success': False,
                'error': str(e),
                'path': '',
                'data': ''
            }
    
    def read_image_file(self, relative_path, root_path):
        """Read an image file and return it as base64-encoded data.
        
        Args:
            relative_path: Path relative to root (e.g., ".kestrel/export/photo.jpg") 
                          OR absolute path (for backward compatibility with old databases)
            root_path: Absolute path to root folder
            
        Returns:
            dict with 'success': bool, 'data': str (base64), 'mime': str, 'error': str
        """
        print(f"[API] read_image_file() called: relative_path='{relative_path}', root_path='{root_path}'", flush=True)
        try:
            import os
            import base64
            import mimetypes
            
            # Normalize paths
            root_path = root_path.rstrip('/\\')
            
            # Check if relative_path is actually an absolute path (backward compatibility)
            if os.path.isabs(relative_path):
                print(f"[API] Detected absolute path (old format), using directly", flush=True)
                full_path = relative_path
            else:
                # It's a relative path (new format) - join with root
                relative_path = relative_path.lstrip('/\\')
                full_path = os.path.join(root_path, relative_path)
            
            print(f"[API] Full path resolved to: {full_path}", flush=True)
            
            # Security check: ensure path is within or equal to root
            full_path_real = os.path.realpath(full_path)
            root_path_real = os.path.realpath(root_path)
            if not full_path_real.startswith(root_path_real):
                print(f"[API] read_image_file() -> Security error: Path escapes root", flush=True)
                print(f"[API]   full_path_real: {full_path_real}", flush=True)
                print(f"[API]   root_path_real: {root_path_real}", flush=True)
                return {
                    'success': False,
                    'error': 'Path escapes root directory',
                    'data': '',
                    'mime': ''
                }
            
            if not os.path.exists(full_path):
                print(f"[API] read_image_file() -> File not found: {full_path}", flush=True)
                return {
                    'success': False,
                    'error': f'File not found: {full_path}',
                    'data': '',
                    'mime': ''
                }
            
            # Read file as binary
            with open(full_path, 'rb') as f:
                data = f.read()
            
            # Encode as base64
            b64_data = base64.b64encode(data).decode('ascii')
            
            # Detect MIME type
            mime_type, _ = mimetypes.guess_type(full_path)
            if not mime_type:
                # Fallback based on extension
                ext = os.path.splitext(full_path)[1].lower()
                mime_map = {
                    '.jpg': 'image/jpeg',
                    '.jpeg': 'image/jpeg',
                    '.png': 'image/png',
                    '.gif': 'image/gif',
                    '.webp': 'image/webp',
                    '.tif': 'image/tiff',
                    '.tiff': 'image/tiff'
                }
                mime_type = mime_map.get(ext, 'application/octet-stream')
            
            print(f"[API] read_image_file() -> Success: Read {len(data)} bytes ({mime_type}) from {os.path.basename(full_path)}", flush=True)
            return {
                'success': True,
                'data': b64_data,
                'mime': mime_type,
                'error': ''
            }
        except Exception as e:
            print(f"[API] read_image_file() -> Error: {e}", flush=True)
            return {
                'success': False,
                'error': str(e),
                'data': '',
                'mime': ''
            }

    def list_subfolders(self, root_path: str, max_depth: int = 3):
        """Recursively list subfolders under root_path, flagging those with .kestrel.

        Args:
            root_path: Absolute path to the root folder to scan.
            max_depth:  How many directory levels to descend (1 = direct children only).

        Returns:
            dict with 'success': bool, 'tree': list[node], 'error': str
            Each node: {name, path, has_kestrel, children: [...]}
        """
        print(f"[API] list_subfolders() called: root='{root_path}' max_depth={max_depth}", flush=True)
        try:
            root_path = root_path.strip().rstrip('/\\')
            if not root_path or not os.path.isdir(root_path):
                return {'success': False, 'tree': [], 'error': f'Not a directory: {root_path}'}

            # Safety caps
            max_depth = max(1, min(int(max_depth), 6))
            MAX_NODES = 300  # total node limit to avoid huge trees
            node_count = [0]

            def _scan(dir_path: str, depth: int) -> list:
                if depth < 1 or node_count[0] >= MAX_NODES:
                    return []
                result = []
                try:
                    entries = sorted(os.scandir(dir_path), key=lambda e: e.name.lower())
                except PermissionError:
                    return []
                for entry in entries:
                    if not entry.is_dir(follow_symlinks=False):
                        continue
                    name = entry.name
                    # Skip hidden and common system/tool folders
                    if name.startswith('.') or name in ('__pycache__', '$RECYCLE.BIN', 'System Volume Information'):
                        continue
                    node_count[0] += 1
                    full = entry.path
                    has_kestrel = os.path.isfile(os.path.join(full, '.kestrel', 'kestrel_database.csv'))
                    children = _scan(full, depth - 1)
                    result.append({
                        'name': name,
                        'path': full,
                        'has_kestrel': has_kestrel,
                        'children': children,
                    })
                return result

            tree = _scan(root_path, max_depth)
            root_has_kestrel = os.path.isfile(os.path.join(root_path, '.kestrel', 'kestrel_database.csv'))
            print(f"[API] list_subfolders() -> {node_count[0]} nodes found, root_has_kestrel={root_has_kestrel}", flush=True)
            return {'success': True, 'tree': tree, 'root_has_kestrel': root_has_kestrel, 'error': ''}
        except Exception as e:
            print(f"[API] list_subfolders() -> Error: {e}", flush=True)
            return {'success': False, 'tree': [], 'error': str(e)}


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
            api = Api()
            webview.create_window('Kestrel Visualizer', url, js_api=api, fullscreen=True)
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