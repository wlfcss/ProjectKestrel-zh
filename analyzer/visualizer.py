#!/usr/bin/env python3
"""Project Kestrel 可视化界面的独立本地 Web 服务器。

该模块取代了旧的 ``backend/editor_bridge.py``，负责：
 - 提供 ``visualizer.html`` 及其静态资源；
 - 暴露 ``/open`` 接口，供前端用已配置的编辑器打开原图；
 - 支持通过 PyInstaller 冻结为单文件或单目录应用。

开发环境示例：
    python visualizer/visualizer.py --port 8765 --root C:\\Photos\\Trip

启动后会默认打开浏览器访问 ``http://127.0.0.1:<port>/``。

单文件打包示例：
    pyinstaller --onefile --name kestrel_viz visualizer/visualizer.py

可选环境变量：
  KESTREL_ALLOWED_ROOT=C:\\Photos\\Trip    限制允许访问的根目录
  KESTREL_BRIDGE_TOKEN=secret              要求请求携带认证头
  KESTREL_ALLOWED_EXTENSIONS=.cr3,.jpg,... 覆盖允许的扩展名列表
  KESTREL_ALLOW_ANY_EXTENSION=1            禁用扩展名过滤
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

import hmac
import secrets
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
import threading
from urllib.parse import urlparse
from typing import Set

# --- 拆分出的功能模块 ---
from settings_utils import load_persisted_settings, save_persisted_settings, log, _normalize
from editor_launch import launch
from queue_manager import _queue_manager
from api_bridge import Api

HOST = '127.0.0.1'

# --- 安全与行为配置（环境变量约定与 editor_bridge 保持一致） ---
ALLOWED_ROOT = os.environ.get('KESTREL_ALLOWED_ROOT')
if ALLOWED_ROOT:
    ALLOWED_ROOT = os.path.abspath(os.path.expanduser(ALLOWED_ROOT))

AUTH_TOKEN = os.environ.get('KESTREL_BRIDGE_TOKEN')
if not AUTH_TOKEN:
    # 每次启动生成临时令牌，并通过 /bridge_config.js 注入前端页面
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
    # 默认从当前脚本所在目录对应的项目路径提供静态文件
    def translate_path(self, path: str) -> str:  # type: ignore[override]
        """兼容开发态、冻结态和安装态，稳健地解析静态文件路径。

        会依次检查：
        1. 当前工作目录下的常规路径；
        2. ``analyzer/`` 子目录；
        3. PyInstaller 安装目录中的 ``_internal/analyzer/``。
        """
        # 先尝试标准路径解析
        resolved = super().translate_path(path)
        if os.path.exists(resolved):
            return resolved
        
        # 如果没找到且路径本身不带 /analyzer，则补上前缀再试一次
        if not path.startswith('/analyzer'):
            alt = super().translate_path('/analyzer' + path)
            if os.path.exists(alt):
                return alt
        
        # 冻结构建时，再检查 _internal 子目录
        if getattr(sys, 'frozen', False):
            # 尝试 <exe_dir>/_internal/analyzer/<file>
            try:
                exe_dir = os.path.dirname(sys.executable)
                internal_dir = os.path.join(exe_dir, '_internal')
                alt_path = path.lstrip('/')
                alt = os.path.join(internal_dir, alt_path)
                if os.path.exists(alt):
                    return alt
                # 如果路径已经带 /analyzer，也检查 _internal/analyzer/<file>
                if path.startswith('/analyzer'):
                    alt_path = path[1:]  # 去掉开头的 /
                    alt = os.path.join(internal_dir, alt_path)
                    if os.path.exists(alt):
                        return alt
            except Exception:
                pass
            
            # 再尝试 _MEIPASS（PyInstaller 临时解包目录）
            meipass = getattr(sys, '_MEIPASS', None)
            if meipass:
                alt_path = path.lstrip('/')
                alt = os.path.join(meipass, alt_path)
                if os.path.exists(alt):
                    return alt
        
        # 返回原始解析结果；如果文件不存在，后续会自然返回 404
        return resolved

    def end_headers(self):  # 注入基础响应头，不允许通配跨域
        self.send_header('Cache-Control', 'no-store')
        super().end_headers()

    def do_GET(self):  # type: ignore[override]
        # 动态注入桥接令牌与来源配置
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
            # 优先使用 analyzer/visualizer.html，并兼容开发态与打包态位置
            def _find_visualizer():
                # 需要尝试的相对路径列表
                candidates = [
                    'analyzer/visualizer.html',
                    'visualizer.html',
                ]
                
                # 先检查当前工作目录
                for rel in candidates:
                    full = os.path.join(os.getcwd(), rel)
                    if os.path.exists(full):
                        return '/' + rel
                
                # 再检查可执行文件目录（冻结/安装场景）
                try:
                    exe_dir = os.path.dirname(sys.executable)
                    internal_dir = os.path.join(exe_dir, '_internal')
                    for rel in candidates:
                        full = os.path.join(internal_dir, rel)
                        if os.path.exists(full):
                            return '/' + rel
                except Exception:
                    pass
                
                # 再检查 PyInstaller 的 _MEIPASS 目录
                meipass = getattr(sys, '_MEIPASS', None)
                if meipass:
                    for rel in candidates:
                        full = os.path.join(meipass, rel)
                        if os.path.exists(full):
                            return '/' + rel
                
                # 最后的默认回退
                return '/analyzer/visualizer.html'
            
            self.path = _find_visualizer()
        return super().do_GET()

    def do_OPTIONS(self):  # 最小化预检，只允许同源 JS
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
        # 只回显同源 Origin，降低跨站滥用令牌的风险
        self.send_header('Access-Control-Allow-Origin', f'http://{HOST}:{self.server.server_port}')  # type: ignore[attr-defined]
        self.end_headers()
        self.wfile.write(body)

    def handle_open(self):
        if AUTH_TOKEN:
            token = self.headers.get('X-Bridge-Token') or ''
            if not hmac.compare_digest(token, AUTH_TOKEN):
                self._json(401, {'ok': False, 'error': 'Unauthorized'}); return
        # 基础 Origin 校验；部分请求可能不会携带 Origin
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
        # 关闭接口始终要求令牌，避免 CSRF 或外部恶意触发
        if AUTH_TOKEN:
            token = self.headers.get('X-Bridge-Token') or ''
            if not hmac.compare_digest(token, AUTH_TOKEN):
                self._json(401, {'ok': False, 'error': 'Unauthorized'}); return
        log('Received shutdown request from client; scheduling server shutdown.')
        # 先响应，再异步关闭，确保客户端能收到返回值
        self._json(200, {'ok': True, 'message': 'Shutting down'})
        def _shutdown():
            try:
                # 略微延迟，给响应刷出留时间
                import time; time.sleep(0.25)
                self.server.shutdown()
            except Exception as e:  # noqa: BLE001
                log('Error during shutdown:', e)
        threading.Thread(target=_shutdown, daemon=True).start()

    def handle_settings(self):
        if AUTH_TOKEN:
            token = self.headers.get('X-Bridge-Token') or ''
            if not hmac.compare_digest(token, AUTH_TOKEN):
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
            if not hmac.compare_digest(token, AUTH_TOKEN):
                self._json(401, {'ok': False, 'error': 'Unauthorized'})
                return False
        return True
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
    # 当 visualizer.py 从 analyzer/ 内部运行时，将工作目录切到仓库根目录，
    # 这样 assets/ 与可视化静态文件都能被正确访问。
    # 如果是 PyInstaller 的 onedir 版本，则优先使用打包产物里的 _internal 目录，
    # 确保 visualizer.html、logo 等静态资源直接从磁盘包内提供。
    if getattr(sys, 'frozen', False):
        meipass = getattr(sys, '_MEIPASS', None) or os.path.dirname(sys.executable)
        candidate = os.path.join(meipass, '_internal')
        if os.path.isdir(candidate):
            os.chdir(candidate)
        elif meipass and os.path.isdir(meipass):
            os.chdir(meipass)
        else:
            # 未打包运行时，回退到相对于仓库根目录的位置
            os.chdir(os.path.join(os.path.dirname(os.path.abspath(__file__)), '..') or '.')
    else:
        os.chdir(os.path.join(os.path.dirname(os.path.abspath(__file__)), '..') or '.')
    server = ThreadingHTTPServer((HOST, args.port), Handler)
    log(f'Serving visualizer at http://{HOST}:{args.port}/  (Press Ctrl+C to stop)')
    log('Ephemeral bridge token (auto-injected):', AUTH_TOKEN[:8] + '…')

    # ── 初始化设置 ──
    try:
        _init_settings = load_persisted_settings()
        _init_settings.setdefault('raw_preview_cache_enabled', True)
        save_persisted_settings(_init_settings)
    except Exception:
        pass  # 这里不能影响启动流程

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
            api = Api()  # 窗口默认最大化启动
            api._server_port = args.port
            win = webview.create_window('翎鉴 Lite', url, js_api=api, maximized=True, background_color='#0e1218')
            api._main_window = win

            # 当分析队列正在运行时，拦截关闭事件并改为最小化，
            # 避免用户误关导致分析中断。
            def _on_closing():
                # 通过 Python 侧标记检查是否有未保存更改。
                # 这里不要调用 evaluate_js，否则关闭阶段会在 GUI 线程死锁。
                has_unsaved = getattr(api, '_has_unsaved_changes', False)

                # 如果分析正在运行或已暂停，则提示用户选择：
                # 最小化、退出（取消分析）或取消关闭。
                if _queue_manager.is_running or _queue_manager.is_paused:
                    try:
                        # Windows 下优先使用原生 MessageBox，提供简单的三按钮提示；
                        # 其他情况下回退到 tkinter。
                        if sys.platform.startswith('win'):
                            import ctypes
                            MB_YESNOCANCEL = 0x00000003
                            MB_ICONQUESTION = 0x00000020
                            title = '分析进行中'
                            if _queue_manager.is_paused:
                                msg = '分析已暂停。要退出翎鉴吗？稍后重新打开后可以继续。'
                            else:
                                msg = '分析仍在进行中。要取消分析并退出吗？'
                            resp = ctypes.windll.user32.MessageBoxW(0, msg, title, MB_YESNOCANCEL | MB_ICONQUESTION)
                            # IDYES=6   表示退出（取消分析并关闭）
                            # IDNO=7    表示最小化而不是关闭
                            # IDCANCEL=2 表示取消这次关闭
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
                            # tkinter 回退方案
                            import tkinter as _tk
                            from tkinter import messagebox as _mb
                            root = _tk.Tk()
                            root.withdraw()
                            if _queue_manager.is_paused:
                                msg = '分析已暂停。要退出翎鉴吗？稍后重新打开后可以继续。'
                            else:
                                msg = '分析仍在进行中。要取消分析并退出吗？'
                            res = _mb.askyesnocancel('分析进行中', msg)
                            root.destroy()
                            # askyesnocancel 的返回值：
                            # True=是，False=否，None=取消
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
                        # 如果提示框本身失败，运行中场景默认回退到最小化
                        try:
                            win.minimize()
                        except Exception:
                            pass
                        return False

                # 没有分析在运行时，只处理未保存更改提示
                if has_unsaved:
                    try:
                        if sys.platform.startswith('win'):
                            import ctypes
                            MB_YESNO = 0x00000004
                            MB_ICONWARNING = 0x00000030
                            msg = '你有未保存的更改，关闭后将会丢失。仍要关闭吗？'
                            title = '未保存的更改'
                            resp = ctypes.windll.user32.MessageBoxW(0, msg, title, MB_YESNO | MB_ICONWARNING)
                            if resp == 6:  # 是：关闭并丢弃未保存更改
                                return True
                            return False  # 否：取消关闭
                        else:
                            import tkinter as _tk
                            from tkinter import messagebox as _mb
                            root = _tk.Tk()
                            root.withdraw()
                            res = _mb.askyesno('未保存的更改',
                                               '你有未保存的更改，关闭后将会丢失。仍要关闭吗？')
                            root.destroy()
                            if res:
                                return True
                            return False
                    except Exception:
                        return True  # 如果提示失败，则允许关闭

                return True  # 允许正常关闭

            try:
                win.events.closing += _on_closing
            except Exception:
                pass  # 旧版 pywebview 可能不支持这个事件

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
    except Exception:
        raise
