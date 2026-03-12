"""JavaScript API bridge for Project Kestrel visualizer.

Provides the Api class that exposes methods to the pywebview JavaScript layer
and serves as the bridge between the web UI and native OS operations.
"""

from __future__ import annotations

import base64
import json
import os
import shutil
import subprocess
import sys
import webbrowser

from settings_utils import load_persisted_settings, save_persisted_settings, log
from queue_manager import _queue_manager

# Telemetry — failsafe import (never blocks startup)
try:
    import kestrel_telemetry as _telemetry
except ImportError:
    try:
        from analyzer import kestrel_telemetry as _telemetry
    except ImportError:
        _telemetry = None  # type: ignore[assignment]

# pywebview availability
WEBVIEW_IMPORT_SUCCESS = False
try:
    import webview  # type: ignore  # noqa: F401
    WEBVIEW_IMPORT_SUCCESS = True
except Exception:
    pass

# Metadata writing utilities
try:
    from metadata_writer import write_xmp_metadata as _write_xmp_metadata
except ImportError:
    _write_xmp_metadata = None  # type: ignore[assignment]

HOST = '127.0.0.1'


class Api:
    """JavaScript API exposed to webview for native file/folder operations."""

    # Extension → MIME type map used by read_image_file (avoids mimetypes.guess_type overhead)
    _MIME_MAP: dict = {
        '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg',
        '.png': 'image/png',  '.gif': 'image/gif',
        '.webp': 'image/webp',
        '.tif': 'image/tiff', '.tiff': 'image/tiff',
    }

    def __init__(self):
        # Cache os.path.realpath(root_path) — root_path is constant for the session
        # but realpath() does a GetFinalPathNameByHandle syscall on Windows each time.
        self._realpath_cache: dict = {}
        self._has_unsaved_changes: bool = False

    def notify_dirty(self, is_dirty: bool) -> dict:
        """Called from JS whenever the dirty flag changes."""
        self._has_unsaved_changes = bool(is_dirty)
        return {'success': True}

    def _root_realpath(self, root_path: str) -> str:
        """Return os.path.realpath(root_path), cached for the lifetime of this Api."""
        if root_path not in self._realpath_cache:
            self._realpath_cache[root_path] = os.path.realpath(root_path)
        return self._realpath_cache[root_path]

    def get_legal_status(self) -> dict:
        """Check if the user has agreed to the terms and if install telemetry was sent."""
        settings = load_persisted_settings()
        agreed = settings.get('legal_agreed_version', '') != ''
        install_sent = settings.get('installed_telemetry_sent', False)
        log(f'[legal] get_legal_status: agreed={agreed}, install_sent={install_sent}')
        return {
            'agreed': agreed,
            'install_sent': install_sent
        }

    def agree_to_legal(self):
        """Mark legal agreement as accepted and trigger installation telemetry if needed."""
        settings = load_persisted_settings()
        version = _telemetry._read_version() if _telemetry else 'unknown'
        settings['legal_agreed_version'] = version
        log(f'[legal] User agreed to terms (version {version})')
        
        # Trigger installation telemetry on first agreement
        if not settings.get('installed_telemetry_sent', False):
            if _telemetry:
                mid = _telemetry.get_machine_id(settings)
                _telemetry.send_installation_telemetry(mid, version=version)
                settings['installed_telemetry_sent'] = True
                log('[legal] Initial installation telemetry triggered.')
        
        save_persisted_settings(settings)
        return {'success': True}
    
    def choose_directory(self):
        """Open native folder picker dialog.
        Returns: absolute path to selected folder, or None if cancelled.
        """
        print(f"[API] choose_directory() called (platform: {sys.platform})", flush=True)
        try:
            if sys.platform == 'darwin':
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
                import tkinter as tk
                from tkinter import filedialog
                root = tk.Tk()
                root.withdraw()
                root.attributes('-topmost', True)
                folder = filedialog.askdirectory(title="Select folder containing analyzed photos")
                root.destroy()
                if folder:
                    print(f"[API] choose_directory() -> Success: {folder}", flush=True)
                    return folder
                else:
                    print("[API] choose_directory() -> Cancelled by user", flush=True)
                    return None
            else:
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
    
    def choose_application(self):
        """Open native file picker for choosing an application executable.
        Returns: absolute path to selected file, or None if cancelled.
        """
        try:
            if sys.platform == 'darwin':
                import subprocess as _sp
                script = 'POSIX path of (choose file of type {"app","APPL"} with prompt "Select an application")'
                result = _sp.run(['osascript', '-e', script], capture_output=True, text=True, timeout=120)
                if result.returncode == 0 and result.stdout.strip():
                    return result.stdout.strip()
                return None
            else:
                import tkinter as tk
                from tkinter import filedialog
                root = tk.Tk()
                root.withdraw()
                root.attributes('-topmost', True)
                if sys.platform.startswith('win'):
                    filetypes = [('Executables', '*.exe'), ('All Files', '*.*')]
                else:
                    filetypes = [('All Files', '*.*')]
                filepath = filedialog.askopenfilename(
                    title="Select application executable",
                    filetypes=filetypes
                )
                root.destroy()
                return filepath if filepath else None
        except Exception as e:
            print(f"[API] choose_application() -> Error: {e}", flush=True)
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
                csv_path = os.path.join(folder_path, 'kestrel_database.csv')
                parent_folder = os.path.dirname(folder_path)
                print(f"[API] Selected .kestrel folder directly. Parent: {parent_folder}", flush=True)
            else:
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

    def read_kestrel_metadata(self, folder_path: str):
        """Read kestrel_metadata.json from a folder's .kestrel directory."""
        try:
            folder_path = str(folder_path).strip()
            meta_path = os.path.join(folder_path, '.kestrel', 'kestrel_metadata.json')
            if not os.path.isfile(meta_path):
                return {'success': False, 'error': 'Metadata file not found'}
            with open(meta_path, 'r', encoding='utf-8') as f:
                data = json.load(f)
            return {'success': True, 'metadata': data}
        except Exception as e:
            return {'success': False, 'error': str(e)}

    def clear_kestrel_data(self, folder_path: str):
        """Delete the contents of the .kestrel folder within the given folder."""
        try:
            folder_path = str(folder_path).strip()
            kestrel_dir = os.path.join(folder_path, '.kestrel')
            if not os.path.isdir(kestrel_dir):
                return {'success': True, 'message': 'No .kestrel folder found'}
            # Verify the .kestrel dir is actually inside folder_path (prevent path traversal)
            real_parent = os.path.realpath(folder_path)
            real_kestrel = os.path.realpath(kestrel_dir)
            if not real_kestrel.startswith(real_parent + os.sep) and real_kestrel != os.path.join(real_parent, '.kestrel'):
                return {'success': False, 'error': 'Invalid path'}
            shutil.rmtree(kestrel_dir)
            print(f"[API] clear_kestrel_data() -> Removed .kestrel from {folder_path}", flush=True)
            return {'success': True, 'message': 'Kestrel analysis data cleared'}
        except Exception as e:
            print(f"[API] clear_kestrel_data() -> Error: {e}", flush=True)
            return {'success': False, 'error': str(e)}

    def is_frozen_app(self):
        """Return whether the application is running as a frozen (PyInstaller) build."""
        return {'frozen': getattr(sys, 'frozen', False)}

    def get_app_version(self):
        """Return the current application version from config."""
        try:
            from kestrel_analyzer.config import VERSION
            return {'success': True, 'version': VERSION}
        except Exception:
            try:
                from analyzer.kestrel_analyzer.config import VERSION
                return {'success': True, 'version': VERSION}
            except Exception:
                return {'success': True, 'version': 'unknown'}

    def inspect_folder(self, folder_path: str):
        """Return lightweight folder summary (total images, processed count)."""
        try:
            import importlib
            inspector = None
            try:
                inspector = importlib.import_module('analyzer.folder_inspector')
            except Exception:
                try:
                    inspector = importlib.import_module('folder_inspector')
                except Exception:
                    inspector = None
            if inspector is None or not hasattr(inspector, 'inspect_folder'):
                return {'success': False, 'error': 'Inspector unavailable'}
            info = inspector.inspect_folder(folder_path)
            return {'success': True, 'info': info}
        except Exception as e:
            print(f"[API] inspect_folder() -> Error: {e}", flush=True)
            return {'success': False, 'error': str(e)}

    def inspect_folders(self, paths):
        """Batch-inspect multiple folders. Expects a list of absolute paths."""
        try:
            import importlib
            inspector = None
            try:
                inspector = importlib.import_module('analyzer.folder_inspector')
            except Exception:
                try:
                    inspector = importlib.import_module('folder_inspector')
                except Exception:
                    inspector = None
            if inspector is None or not hasattr(inspector, 'inspect_folders'):
                return {'success': False, 'error': 'Inspector unavailable', 'results': {}}
            if isinstance(paths, str):
                try:
                    paths = json.loads(paths)
                except Exception:
                    paths = [paths]
            results = inspector.inspect_folders(list(paths))
            return {'success': True, 'results': results}
        except Exception as e:
            print(f"[API] inspect_folders() -> Error: {e}", flush=True)
            return {'success': False, 'error': str(e), 'results': {}}
    
    def read_image_file(self, relative_path, root_path):
        """Read an image file and return it as base64-encoded data.
        
        Args:
            relative_path: Path relative to root (e.g., ".kestrel/export/photo.jpg") 
                          OR absolute path (for backward compatibility with old databases)
            root_path: Absolute path to root folder
            
        Returns:
            dict with 'success': bool, 'data': str (base64), 'mime': str, 'error': str
        """
        try:
            # Normalize separators
            root_path = root_path.rstrip('/\\')
            relative_path = relative_path.replace('\\', '/')

            # Resolve to full path
            if os.path.isabs(relative_path):
                full_path = relative_path
            else:
                relative_path = relative_path.lstrip('/\\')
                full_path = os.path.join(root_path, relative_path)

            # Security check — fast path: no '..' means path cannot escape root.
            # Slow path: resolve symlinks only when traversal sequences are present.
            if '..' in relative_path or os.path.isabs(relative_path):
                root_path_real = self._root_realpath(root_path)
                if not os.path.realpath(full_path).startswith(root_path_real):
                    return {'success': False, 'error': 'Path escapes root directory', 'data': '', 'mime': ''}

            # Read — let open() raise FileNotFoundError rather than a separate stat call
            try:
                with open(full_path, 'rb') as f:
                    data = f.read()
            except FileNotFoundError:
                return {'success': False, 'error': f'File not found: {full_path}', 'data': '', 'mime': ''}

            ext = os.path.splitext(full_path)[1].lower()
            mime_type = self._MIME_MAP.get(ext, 'image/jpeg')

            return {
                'success': True,
                'data': base64.b64encode(data).decode('ascii'),
                'mime': mime_type,
                'error': ''
            }
        except Exception as e:
            print(f"[API] read_image_file() -> Error: {e}", flush=True)
            return {'success': False, 'error': str(e), 'data': '', 'mime': ''}

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
            try:
                MAX_NODES = max(100, int(os.environ.get('KESTREL_TREE_NODE_LIMIT', '2000')))
            except Exception:
                MAX_NODES = 2000
            node_count = [0]
            limit_reached = [False]

            def _scan(dir_path: str, depth: int) -> list:
                if depth < 1 or node_count[0] >= MAX_NODES:
                    return []
                result = []
                try:
                    entries = sorted(os.scandir(dir_path), key=lambda e: e.name.lower())
                except PermissionError:
                    return []
                for entry in entries:
                    if node_count[0] >= MAX_NODES:
                        limit_reached[0] = True
                        break
                    if not entry.is_dir(follow_symlinks=False):
                        continue
                    name = entry.name
                    if name.startswith('.') or name in ('__pycache__', '$RECYCLE.BIN', 'System Volume Information'):
                        continue
                    node_count[0] += 1
                    full = entry.path
                    has_kestrel = os.path.isfile(os.path.join(full, '.kestrel', 'kestrel_database.csv'))
                    kestrel_version = ''
                    if has_kestrel:
                        try:
                            meta_path = os.path.join(full, '.kestrel', 'kestrel_metadata.json')
                            if os.path.isfile(meta_path):
                                with open(meta_path, 'r', encoding='utf-8') as mf:
                                    kestrel_version = json.load(mf).get('version', '')
                        except Exception:
                            pass
                    children = _scan(full, depth - 1)
                    result.append({
                        'name': name,
                        'path': full,
                        'has_kestrel': has_kestrel,
                        'kestrel_version': kestrel_version,
                        'children': children,
                    })
                return result

            tree = _scan(root_path, max_depth)
            root_has_kestrel = os.path.isfile(os.path.join(root_path, '.kestrel', 'kestrel_database.csv'))
            root_kestrel_version = ''
            if root_has_kestrel:
                try:
                    meta_path = os.path.join(root_path, '.kestrel', 'kestrel_metadata.json')
                    if os.path.isfile(meta_path):
                        with open(meta_path, 'r', encoding='utf-8') as mf:
                            root_kestrel_version = json.load(mf).get('version', '')
                except Exception:
                    pass
            if limit_reached[0]:
                print(f"[API] list_subfolders() -> Node limit reached ({MAX_NODES}); scan truncated at {node_count[0]} nodes", flush=True)
            else:
                print(f"[API] list_subfolders() -> {node_count[0]} nodes found, root_has_kestrel={root_has_kestrel}", flush=True)
            return {
                'success': True,
                'tree': tree,
                'root_has_kestrel': root_has_kestrel,
                'root_kestrel_version': root_kestrel_version,
                'error': '',
                'nodes': node_count[0],
                'truncated': bool(limit_reached[0]),
            }
        except Exception as e:
            print(f"[API] list_subfolders() -> Error: {e}", flush=True)
            return {'success': False, 'tree': [], 'error': str(e)}

    def write_kestrel_csv(self, folder_path: str, csv_content: str):
        """Write CSV content back to .kestrel/kestrel_database.csv for the given folder."""
        try:
            folder_name = os.path.basename(folder_path)
            if folder_name == '.kestrel':
                csv_path = os.path.join(folder_path, 'kestrel_database.csv')
            else:
                csv_path = os.path.join(folder_path, '.kestrel', 'kestrel_database.csv')
            if not os.path.exists(csv_path):
                print(f'[API] write_kestrel_csv({folder_path!r}) -> CSV not found: {csv_path}', flush=True)
                return {'success': False, 'error': f'CSV not found: {csv_path}'}
            with open(csv_path, 'w', encoding='utf-8', newline='') as f:
                f.write(csv_content)
            print(f'[API] write_kestrel_csv({folder_path!r}) -> {len(csv_content)} bytes written to {csv_path}', flush=True)
            return {'success': True, 'path': csv_path}
        except Exception as e:
            print(f'[API] write_kestrel_csv({folder_path!r}) -> Error: {e}', flush=True)
            return {'success': False, 'error': str(e)}

    def open_folder(self, path: str):
        """Open a folder in the system file browser (pywebview desktop mode)."""
        try:
            import platform as _platform
            p = _platform.system()
            if p == 'Windows':
                subprocess.Popen(['explorer', os.path.normpath(path)])
            elif p == 'Darwin':
                subprocess.Popen(['open', path])
            else:
                subprocess.Popen(['xdg-open', path])
            print(f'[API] open_folder({path!r}) -> success', flush=True)
            return {'success': True}
        except Exception as e:
            print(f'[API] open_folder({path!r}) -> Error: {e}', flush=True)
            return {'success': False, 'error': str(e)}

    def open_url(self, url: str):
        """Open a URL in the system default browser (pywebview desktop mode)."""
        try:
            webbrowser.open(url)
            print(f'[API] open_url({url!r}) -> success', flush=True)
            return {'success': True}
        except Exception as e:
            print(f'[API] open_url({url!r}) -> Error: {e}', flush=True)
            return {'success': False, 'error': str(e)}

    # ------------------------------------------------------------------ #
    #  Telemetry / Feedback API                                            #
    # ------------------------------------------------------------------ #

    def send_feedback(self, data):
        """Send feedback / bug report (async, failsafe). Called from JS."""
        try:
            if _telemetry is None:
                print('[API] send_feedback() -> telemetry unavailable', flush=True)
                return {'success': False, 'error': 'Telemetry module not available'}
            if not isinstance(data, dict):
                return {'success': False, 'error': 'Invalid data'}
            settings = load_persisted_settings()
            machine_id = _telemetry.get_machine_id(settings)
            log_tail = ''
            if data.get('include_logs', False):
                log_tail = _telemetry.get_recent_log_tail()
            _telemetry.send_feedback(
                report_type=data.get('type', 'general'),
                description=data.get('description', ''),
                contact=data.get('contact', ''),
                screenshot_b64=data.get('screenshot_b64', ''),
                log_tail=log_tail,
                machine_id=machine_id,
                version=_telemetry._read_version(),
            )
            print(f'[API] send_feedback() -> queued ({data.get("type", "general")})', flush=True)
            return {'success': True}
        except Exception as e:
            print(f'[API] send_feedback() -> Error: {e}', flush=True)
            return {'success': False, 'error': str(e)}

    def get_settings(self):
        """Return persisted settings, ensuring machine_id and version exist."""
        try:
            settings = load_persisted_settings()
            if _telemetry is not None:
                _telemetry.get_machine_id(settings)
            if _telemetry is not None:
                settings['version'] = _telemetry._read_version()
            save_persisted_settings(settings)
            return {'success': True, 'settings': settings}
        except Exception as e:
            print(f'[API] get_settings() -> Error: {e}', flush=True)
            return {'success': False, 'error': str(e), 'settings': {}}

    def save_settings_data(self, settings_dict):
        """Persist settings from JavaScript (wraps save_persisted_settings)."""
        try:
            if not isinstance(settings_dict, dict):
                return {'success': False, 'error': 'Invalid settings'}
            save_persisted_settings(settings_dict)
            return {'success': True}
        except Exception as e:
            print(f'[API] save_settings_data() -> Error: {e}', flush=True)
            return {'success': False, 'error': str(e)}

    # ------------------------------------------------------------------ #
    #  Sample Sets API                                                     #
    # ------------------------------------------------------------------ #

    def get_sample_sets_paths(self):
        """Return absolute paths to bundled sample bird-photo sets.

        Works both during development (sample_sets/ next to the repo root)
        and in PyInstaller frozen builds (bundled via _MEIPASS).
        """
        try:
            candidates = []
            debug_info = []
            
            is_frozen = getattr(sys, 'frozen', False)
            debug_info.append(f'[init] sys.frozen={is_frozen}')
            
            if is_frozen:
                debug_info.append('[frozen] Checking frozen build paths...')
                meipass = getattr(sys, '_MEIPASS', None)
                exe_dir = os.path.dirname(sys.executable) if hasattr(sys, 'executable') else None
                debug_info.append(f'[frozen] sys._MEIPASS={meipass}')
                debug_info.append(f'[frozen] sys.executable={sys.executable}')
                debug_info.append(f'[frozen] exe_dir={exe_dir}')
                
                candidates_checked = []
                bases = []
                
                if meipass:
                    bases.append(meipass)
                    bases.append(os.path.join(meipass, '_internal'))
                if exe_dir:
                    bases.append(exe_dir)
                    bases.append(os.path.join(exe_dir, '_internal'))
                    parent_exe = os.path.dirname(exe_dir)
                    if parent_exe and parent_exe != exe_dir:
                        bases.append(parent_exe)
                        bases.append(os.path.join(parent_exe, '_internal'))
                
                sources_internal = os.path.normpath(os.path.join(os.path.dirname(os.path.abspath(__file__)), '..', '_internal'))
                bases.append(sources_internal)
                
                debug_info.append(f'[frozen] Will check {len(bases)} base paths')
                for base in bases:
                    if not base or base in candidates_checked:
                        continue
                    candidates_checked.append(base)
                    d = os.path.join(base, 'sample_sets')
                    exists = os.path.isdir(d)
                    debug_info.append(f'[frozen] Checking {d}: exists={exists}')
                    if exists:
                        debug_info.append(f'[frozen] Found sample_sets at: {d}')
                        candidates.append(d)
                        break
                
                if not candidates and exe_dir:
                    debug_info.append(f'[frozen-fallback] Exhaustive search starting from {exe_dir}')
                    try:
                        start_dir = os.path.abspath(os.path.join(exe_dir, '..', '..'))
                        if not os.path.isdir(start_dir):
                            start_dir = exe_dir
                        for root, dirs, files in os.walk(start_dir):
                            depth = root[len(exe_dir):].count(os.sep)
                            if depth > 5:
                                del dirs[:]
                                continue
                            if 'sample_sets' in dirs:
                                found = os.path.join(root, 'sample_sets')
                                debug_info.append(f'[frozen-fallback] Found sample_sets at: {found}')
                                candidates.append(found)
                                break
                    except Exception as e:
                        debug_info.append(f'[frozen-fallback] Exhaustive search failed: {e}')
            else:
                debug_info.append('[dev] Not a frozen build')
            
            cwd_candidate = os.path.join(os.getcwd(), 'sample_sets')
            cwd_exists = os.path.isdir(cwd_candidate)
            debug_info.append(f'[dev-cwd] {cwd_candidate}: exists={cwd_exists}')
            if cwd_exists and cwd_candidate not in candidates:
                candidates.append(cwd_candidate)
            
            file_candidate = os.path.join(os.path.dirname(os.path.abspath(__file__)), '..', 'sample_sets')
            file_candidate = os.path.normpath(file_candidate)
            file_exists = os.path.isdir(file_candidate)
            debug_info.append(f'[dev-file] {file_candidate}: exists={file_exists}')
            if file_exists and file_candidate not in candidates:
                candidates.append(file_candidate)
            
            if not candidates and sys.platform.startswith('win'):
                debug_info.append('[fallback] Starting Program Files search...')
                pf_paths = [
                    os.environ.get('ProgramFiles'),
                    os.environ.get('ProgramFiles(x86)'),
                    'C:\\Program Files',
                    'C:\\Program Files (x86)',
                ]
                for pf_base in pf_paths:
                    if not pf_base or not os.path.isdir(pf_base):
                        continue
                    for dirname in os.listdir(pf_base):
                        if 'kestrel' in dirname.lower():
                            kestrel_dir = os.path.join(pf_base, dirname)
                            direct = os.path.join(kestrel_dir, 'sample_sets')
                            if os.path.isdir(direct):
                                debug_info.append(f'[fallback] Found sample_sets at: {direct}')
                                candidates.append(direct)
                                break
                            internal = os.path.join(kestrel_dir, '_internal', 'sample_sets')
                            if os.path.isdir(internal):
                                debug_info.append(f'[fallback] Found sample_sets at: {internal}')
                                candidates.append(internal)
                                break
                    if candidates:
                        break

            debug_info.append(f'[collect] Found {len(candidates)} candidate roots')
            for idx, cand in enumerate(candidates):
                debug_info.append(f'[collect]   [{idx}] {cand}')

            if not candidates:
                error_msg = 'sample_sets folder not found'
                for line in debug_info:
                    print(line, flush=True)
                print(f'[API] get_sample_sets_paths() -> Error: {error_msg}', flush=True)
                return {'success': False, 'error': error_msg, 'paths': []}

            sample_root = candidates[0]
            debug_info.append(f'[api] Using root: {sample_root}')
            
            try:
                items = os.listdir(sample_root)
                debug_info.append(f'[api] Root contains {len(items)} items: {items}')
            except Exception as e:
                debug_info.append(f'[api] Failed to list {sample_root}: {e}')
                items = []
            
            paths = []
            for name in sorted(items):
                full = os.path.join(sample_root, name)
                is_dir = os.path.isdir(full)
                kestrel_dir = os.path.join(full, '.kestrel')
                kestrel_exists = os.path.isdir(kestrel_dir)
                debug_info.append(f'[api]   Item "{name}": is_dir={is_dir}, has .kestrel={kestrel_exists}')
                
                if is_dir and kestrel_exists:
                    readonly_src = os.path.join(kestrel_dir, 'kestrel_database_readonly.csv')
                    db_dst       = os.path.join(kestrel_dir, 'kestrel_database.csv')
                    readonly_exists = os.path.isfile(readonly_src)
                    debug_info.append(f'[api]     readonly_src: {readonly_src} exists={readonly_exists}')
                    
                    if readonly_exists:
                        try:
                            shutil.copy2(readonly_src, db_dst)
                            debug_info.append(f'[api]     Restored sample DB: {db_dst}')
                        except Exception as e:
                            debug_info.append(f'[api]     Failed to restore DB: {e}')
                    else:
                        debug_info.append(f'[api]     No readonly DB found at {readonly_src}')
                    
                    paths.append(full)
                    debug_info.append(f'[api]     Added path: {full}')
            
            for line in debug_info:
                print(line, flush=True)
            print(f'[API] get_sample_sets_paths() -> {len(paths)} sets from {sample_root}', flush=True)
            return {'success': True, 'paths': paths}
        except Exception as e:
            import traceback
            print(f'[API] get_sample_sets_paths() -> Error: {e}', flush=True)
            print(f'[API] Traceback: {traceback.format_exc()}', flush=True)
            return {'success': False, 'error': str(e), 'paths': []}

    # ------------------------------------------------------------------ #
    #  Analysis Queue API (called from JavaScript in pywebview mode)       #
    # ------------------------------------------------------------------ #

    def start_analysis_queue(self, paths, use_gpu=True, wildlife_enabled=True):
        """Enqueue folders for analysis. ``paths`` may be a JSON string or list."""
        try:
            if isinstance(paths, str):
                paths = json.loads(paths)
            if not isinstance(paths, list):
                return {'success': False, 'error': 'paths must be a list'}
            paths = [str(p).strip() for p in paths if p]
            return _queue_manager.enqueue(paths, use_gpu=bool(use_gpu),
                                          wildlife_enabled=bool(wildlife_enabled))
        except Exception as e:
            print(f'[API] start_analysis_queue() -> Error: {e}', flush=True)
            return {'success': False, 'error': str(e)}

    def pause_analysis_queue(self):
        """Pause the running analysis queue."""
        return _queue_manager.pause()

    def resume_analysis_queue(self):
        """Resume a paused analysis queue."""
        return _queue_manager.resume()

    def cancel_analysis_queue(self):
        """Cancel the analysis queue (marks pending items as cancelled)."""
        return _queue_manager.cancel()

    def get_queue_status(self):
        """Return the current state of the analysis queue."""
        return _queue_manager.get_status()

    def clear_queue_done(self):
        """Remove finished/errored/cancelled items from the queue list."""
        return _queue_manager.clear_done()

    def remove_queue_item(self, path: str):
        """Remove a single pending item from the queue by path."""
        try:
            return _queue_manager.remove_pending_item(str(path))
        except Exception as e:
            return {'success': False, 'error': str(e)}

    def reorder_queue(self, ordered_paths):
        """Reorder pending queue items. ordered_paths is a JSON string or list of paths."""
        try:
            if isinstance(ordered_paths, str):
                ordered_paths = json.loads(ordered_paths)
            if not isinstance(ordered_paths, list):
                return {'success': False, 'error': 'ordered_paths must be a list'}
            return _queue_manager.reorder_pending(ordered_paths)
        except Exception as e:
            return {'success': False, 'error': str(e)}

    def is_analysis_running(self):
        """Return True if the analysis queue is actively running."""
        return {'running': _queue_manager.is_running}

    # ------------------------------------------------------------------ #
    #  Culling Assistant API                                               #
    # ------------------------------------------------------------------ #

    _main_window = None
    _culling_window = None
    _server_port = None

    def open_culling_window(self, root_path: str):
        """Open a new pywebview window for the Culling Assistant."""
        try:
            if not WEBVIEW_IMPORT_SUCCESS:
                return {'success': False, 'error': 'pywebview not available'}
            import webview as _wv
            folder_name = os.path.basename(root_path) if root_path else 'Unknown'
            port = self._server_port or 8765
            from urllib.parse import quote
            culling_url = f'http://{HOST}:{port}/culling.html?root={quote(root_path, safe="")}'
            
            methods = [m for m in dir(self) if not m.startswith('_') and callable(getattr(self, m))]
            log(f'[culling] Creating window with Api instance')
            log(f'[culling] Available public methods (first 10): {methods[:10]}')
            log(f'[culling] read_kestrel_csv available: {"read_kestrel_csv" in methods}')
            
            win = _wv.create_window(
                f'Culling Assistant \u2014 {folder_name}',
                culling_url,
                js_api=self,
                width=1400,
                height=900,
            )
            self._culling_window = win
            log(f'[culling] Culling window created successfully')
            return {'success': True}
        except Exception as e:
            log(f'open_culling_window error: {e}')
            import traceback
            log(f'[culling] Traceback: {traceback.format_exc()}')
            return {'success': False, 'error': str(e)}

    def move_rejects_to_folder(self, root_path: str, filenames):
        """Move original photo files into _KESTREL_Rejects subfolder."""
        try:
            if not root_path or not os.path.isdir(root_path):
                return {'success': False, 'error': 'Invalid root path'}
            reject_dir = os.path.join(root_path, '_KESTREL_Rejects')
            os.makedirs(reject_dir, exist_ok=True)
            moved = []
            errors = []
            for fn in (filenames or []):
                src = os.path.join(root_path, fn)
                dst = os.path.join(reject_dir, fn)
                try:
                    if os.path.exists(src):
                        shutil.move(src, dst)
                        moved.append(fn)
                    else:
                        errors.append(f'{fn}: file not found')
                except Exception as e:
                    errors.append(f'{fn}: {e}')
            log(f'move_rejects: moved {len(moved)}, errors {len(errors)}')
            return {'success': True, 'moved': len(moved), 'errors': errors, 'reject_folder': reject_dir}
        except Exception as e:
            log(f'move_rejects_to_folder error: {e}')
            return {'success': False, 'error': str(e)}

    def write_xmp_metadata(self, root_path: str, image_data, overwrite_external: bool = False):
        """Write XMP sidecar files for each image, embedding star rating and culling label."""
        if _write_xmp_metadata is None:
            return {'success': False, 'error': 'metadata_writer module not available'}
        return _write_xmp_metadata(root_path, image_data, overwrite_external)

    def undo_reject_move(self, root_path: str, filenames):
        """Move files back from _KESTREL_Rejects to the root folder."""
        try:
            reject_dir = os.path.join(root_path, '_KESTREL_Rejects')
            if not os.path.isdir(reject_dir):
                return {'success': False, 'error': '_KESTREL_Rejects folder not found'}
            restored = []
            errors = []
            for fn in (filenames or []):
                src = os.path.join(reject_dir, fn)
                dst = os.path.join(root_path, fn)
                try:
                    if os.path.exists(src):
                        shutil.move(src, dst)
                        restored.append(fn)
                    else:
                        errors.append(f'{fn}: not found in rejects')
                except Exception as e:
                    errors.append(f'{fn}: {e}')
            log(f'undo_reject_move: restored {len(restored)}, errors {len(errors)}')
            return {'success': True, 'restored': len(restored), 'errors': errors}
        except Exception as e:
            log(f'undo_reject_move error: {e}')
            return {'success': False, 'error': str(e)}

    def backup_kestrel_csv(self, root_path: str):
        """Copy kestrel_database.csv to kestrel_database_old.csv as backup."""
        try:
            kestrel_dir = os.path.join(root_path, '.kestrel')
            csv_path = os.path.join(kestrel_dir, 'kestrel_database.csv')
            backup_path = os.path.join(kestrel_dir, 'kestrel_database_old.csv')
            if not os.path.exists(csv_path):
                return {'success': False, 'error': 'kestrel_database.csv not found'}
            shutil.copy2(csv_path, backup_path)
            log(f'backup_kestrel_csv: backed up to {backup_path}')
            return {'success': True, 'backup_path': backup_path}
        except Exception as e:
            log(f'backup_kestrel_csv error: {e}')
            return {'success': False, 'error': str(e)}

    def restore_kestrel_csv_backup(self, root_path: str):
        """Restore kestrel_database_old.csv back to kestrel_database.csv."""
        try:
            kestrel_dir = os.path.join(root_path, '.kestrel')
            csv_path = os.path.join(kestrel_dir, 'kestrel_database.csv')
            backup_path = os.path.join(kestrel_dir, 'kestrel_database_old.csv')
            if not os.path.exists(backup_path):
                return {'success': False, 'error': 'kestrel_database_old.csv not found'}
            shutil.copy2(backup_path, csv_path)
            log(f'restore_kestrel_csv_backup: restored from {backup_path}')
            return {'success': True}
        except Exception as e:
            log(f'restore_kestrel_csv_backup error: {e}')
            return {'success': False, 'error': str(e)}

    def open_reject_folder(self, root_path: str):
        """Open the _KESTREL_Rejects folder in the system file browser."""
        reject_dir = os.path.join(root_path, '_KESTREL_Rejects')
        if os.path.isdir(reject_dir):
            return self.open_folder(reject_dir)
        return {'success': False, 'error': '_KESTREL_Rejects folder not found'}

    def notify_main_window_refresh(self):
        """Tell the main visualizer window to reload its data."""
        try:
            if not WEBVIEW_IMPORT_SUCCESS:
                return {'success': False, 'error': 'pywebview not available'}
            import webview as _wv
            if _wv.windows and len(_wv.windows) > 0:
                main_win = _wv.windows[0]
                main_win.evaluate_js('if(window.reloadCurrentFolders) window.reloadCurrentFolders();')
                return {'success': True}
            return {'success': False, 'error': 'No main window found'}
        except Exception as e:
            log(f'notify_main_window_refresh error: {e}')
            return {'success': False, 'error': str(e)}

    def read_raw_full(self, filename: str, root_path: str):
        """Process a RAW file and return full-resolution JPEG as base64.
        Results are cached in {root}/.kestrel/culling_TMP/ for fast subsequent loads.
        Falls back to read_image_file for non-RAW formats."""
        from io import BytesIO

        try:
            full_path = os.path.join(root_path, filename)
            full_path_real = os.path.realpath(full_path)
            root_path_real = os.path.realpath(root_path)
            if not full_path_real.startswith(root_path_real):
                return {'success': False, 'error': 'Path escapes root directory'}
            if not os.path.exists(full_path):
                return {'success': False, 'error': f'File not found: {filename}'}

            raw_extensions = {'.cr2', '.cr3', '.nef', '.arw', '.dng', '.raf', '.orf', '.rw2', '.srw'}
            ext = os.path.splitext(filename)[1].lower()

            if ext not in raw_extensions:
                return self.read_image_file(filename, root_path)

            cache_dir = os.path.join(root_path, '.kestrel', 'culling_TMP')
            cache_name = os.path.splitext(os.path.basename(filename))[0] + '_preview.jpg'
            cache_path = os.path.join(cache_dir, cache_name)

            if os.path.exists(cache_path):
                log(f'read_raw_full: Cache hit for {filename}')
                with open(cache_path, 'rb') as f:
                    b64 = base64.b64encode(f.read()).decode('ascii')
                return {'success': True, 'data': b64}

            import rawpy
            from PIL import Image

            log(f'read_raw_full: Processing RAW file {filename}')
            with rawpy.imread(full_path) as raw:
                rgb = raw.postprocess(
                    use_camera_wb=True,
                    no_auto_bright=False,
                    output_bps=8,
                    fbdd_noise_reduction=rawpy.FBDDNoiseReductionMode.Off,
                )

            img = Image.fromarray(rgb)

            os.makedirs(cache_dir, exist_ok=True)
            buf = BytesIO()
            img.save(buf, format='JPEG', quality=82, optimize=False, progressive=False)
            jpg_bytes = buf.getvalue()
            with open(cache_path, 'wb') as f:
                f.write(jpg_bytes)

            b64 = base64.b64encode(jpg_bytes).decode('ascii')
            log(f'read_raw_full: Done, {len(jpg_bytes)//1024}KB JPEG ({img.width}x{img.height}), cached as {cache_name}')
            return {'success': True, 'data': b64}
        except Exception as e:
            log(f'read_raw_full error: {e}')
            return {'success': False, 'error': str(e)}

    def cleanup_culling_cache(self, root_path: str):
        """Remove the .kestrel/culling_TMP folder to free up space."""
        try:
            cache_dir = os.path.join(root_path, '.kestrel', 'culling_TMP')
            if os.path.exists(cache_dir):
                shutil.rmtree(cache_dir)
                log(f'cleanup_culling_cache: Removed {cache_dir}')
                return {'success': True}
            return {'success': True}
        except Exception as e:
            log(f'cleanup_culling_cache error: {e}')
            return {'success': False, 'error': str(e)}
