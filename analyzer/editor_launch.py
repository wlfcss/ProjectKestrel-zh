"""Editor launching logic for Project Kestrel.

Handles opening original photo files in various editors across Windows, macOS, and Linux.
"""

from __future__ import annotations

import os
import subprocess
import sys

from settings_utils import load_persisted_settings, log

# Cache for discovered darktable executable on Windows
_DARKTABLE_EXE = None


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


def launch(path: str, editor: str):
    path = os.path.abspath(path)
    print(f"[LAUNCH] requested path={path!r} editor={editor!r} platform={sys.platform}", flush=True)
    if not os.path.exists(path):
        print(f"[LAUNCH] ERROR: path does not exist: {path}", flush=True)
        raise FileNotFoundError(path)

    # Custom editor: load path from settings
    if editor == 'custom':
        settings = load_persisted_settings()
        custom_exe = (settings.get('customEditorPath') or '').strip()
        if custom_exe:
            try:
                if sys.platform == 'darwin' and custom_exe.endswith('.app'):
                    subprocess.Popen(['open', '-a', custom_exe, path]); return
                else:
                    subprocess.Popen([custom_exe, path]); return
            except Exception as e:
                log(f'Custom editor launch failed ({custom_exe}): {e}, falling back to system default')
        # Fall through to system default
        editor = 'system'

    # Editor name -> (Windows exe candidates, macOS app name, Linux commands)
    _EDITOR_REGISTRY = {
        'darktable': {
            'win_find': lambda: [_find_darktable_exe()],
            'mac_app': 'darktable',
            'linux': [['flatpak', 'run', 'org.darktable.Darktable'], ['darktable']],
        },
        'lightroom': {
            'win_candidates': [
                os.path.join(os.environ.get('ProgramFiles', ''), 'Adobe', 'Adobe Lightroom Classic', 'Lightroom.exe'),
                os.path.join(os.environ.get('ProgramFiles', ''), 'Adobe', 'Lightroom', 'Lightroom.exe'),
                'Lightroom.exe',
            ],
            'mac_app': 'Adobe Lightroom Classic',
            'linux': [['lightroom']],
        },
        'photoshop': {
            'win_candidates': [
                os.path.join(os.environ.get('ProgramFiles', ''), 'Adobe', 'Adobe Photoshop 2025', 'Photoshop.exe'),
                os.path.join(os.environ.get('ProgramFiles', ''), 'Adobe', 'Adobe Photoshop 2024', 'Photoshop.exe'),
                os.path.join(os.environ.get('ProgramFiles', ''), 'Adobe', 'Adobe Photoshop 2023', 'Photoshop.exe'),
                os.path.join(os.environ.get('ProgramFiles', ''), 'Adobe', 'Adobe Photoshop CC 2022', 'Photoshop.exe'),
                'Photoshop.exe',
            ],
            'mac_app': 'Adobe Photoshop 2025',
            'mac_app_fallbacks': ['Adobe Photoshop 2024', 'Adobe Photoshop 2023', 'Adobe Photoshop'],
            'linux': [],
        },
        'capture_one': {
            'win_candidates': [
                os.path.join(os.environ.get('ProgramFiles', ''), 'Capture One', 'CaptureOne.exe'),
                'CaptureOne.exe',
            ],
            'mac_app': 'Capture One',
            'linux': [],
        },
        'affinity': {
            'win_candidates': [
                os.path.join(os.environ.get('ProgramFiles', ''), 'Affinity', 'Photo 2', 'Photo.exe'),
                os.path.join(os.environ.get('ProgramFiles', ''), 'Affinity', 'Photo', 'Photo.exe'),
                os.path.join(os.environ.get('ProgramFiles', ''), 'Affinity Photo 2', 'Photo.exe'),
                os.path.join(os.environ.get('ProgramFiles', ''), 'Affinity Photo', 'Photo.exe'),
            ],
            'mac_app': 'Affinity Photo 2',
            'mac_app_fallbacks': ['Affinity Photo'],
            'linux': [],
        },
        'gimp': {
            'win_candidates': [
                os.path.join(os.environ.get('ProgramFiles', ''), 'GIMP 2', 'bin', 'gimp-2.10.exe'),
                os.path.join(os.environ.get('ProgramFiles', ''), 'GIMP 2', 'bin', 'gimp.exe'),
                'gimp.exe',
            ],
            'mac_app': 'GIMP',
            'linux': [['flatpak', 'run', 'org.gimp.GIMP'], ['gimp']],
        },
        'rawtherapee': {
            'win_candidates': [
                os.path.join(os.environ.get('ProgramFiles', ''), 'RawTherapee', 'rawtherapee.exe'),
                os.path.join(os.environ.get('ProgramFiles', ''), 'RawTherapee', '5.9', 'rawtherapee.exe'),
                'rawtherapee.exe',
            ],
            'mac_app': 'RawTherapee',
            'linux': [['flatpak', 'run', 'com.rawtherapee.RawTherapee'], ['rawtherapee']],
        },
        'luminar': {
            'win_candidates': [
                os.path.join(os.environ.get('ProgramFiles', ''), 'Skylum', 'Luminar Neo', 'Luminar Neo.exe'),
                os.path.join(os.environ.get('ProgramFiles', ''), 'Luminar Neo', 'Luminar Neo.exe'),
            ],
            'mac_app': 'Luminar Neo',
            'mac_app_fallbacks': ['Luminar AI', 'Luminar 4'],
            'linux': [],
        },
        'dxo': {
            'win_candidates': [
                os.path.join(os.environ.get('ProgramFiles', ''), 'DxO', 'DxO PhotoLab 7', 'DxO.PhotoLab.exe'),
                os.path.join(os.environ.get('ProgramFiles', ''), 'DxO', 'DxO PhotoLab 6', 'DxO.PhotoLab.exe'),
                os.path.join(os.environ.get('ProgramFiles', ''), 'DxO', 'DxO PhotoLab', 'DxO.PhotoLab.exe'),
            ],
            'mac_app': 'DxO PhotoLab 7',
            'mac_app_fallbacks': ['DxO PhotoLab 6', 'DxO PhotoLab'],
            'linux': [],
        },
        'on1': {
            'win_candidates': [
                os.path.join(os.environ.get('ProgramFiles', ''), 'ON1', 'ON1 Photo RAW 2024', 'ON1 Photo RAW.exe'),
                os.path.join(os.environ.get('ProgramFiles', ''), 'ON1', 'ON1 Photo RAW', 'ON1 Photo RAW.exe'),
            ],
            'mac_app': 'ON1 Photo RAW 2024',
            'mac_app_fallbacks': ['ON1 Photo RAW'],
            'linux': [],
        },
        'acdsee': {
            'win_candidates': [
                os.path.join(os.environ.get('ProgramFiles', ''), 'ACD Systems', 'ACDSee Photo Studio Ultimate 2024', 'ACDSee.exe'),
                os.path.join(os.environ.get('ProgramFiles(x86)', ''), 'ACD Systems', 'ACDSee', 'ACDSee.exe'),
                'ACDSee.exe',
            ],
            'mac_app': None,
            'linux': [],
        },
        'paintshop': {
            'win_candidates': [
                os.path.join(os.environ.get('ProgramFiles', ''), 'Corel', 'Corel PaintShop Pro 2024', 'Corel PaintShop Pro.exe'),
                os.path.join(os.environ.get('ProgramFiles', ''), 'Corel', 'Corel PaintShop Pro', 'Corel PaintShop Pro.exe'),
            ],
            'mac_app': None,
            'linux': [],
        },
        'faststone': {
            'win_candidates': [
                os.path.join(os.environ.get('ProgramFiles(x86)', ''), 'FastStone Image Viewer', 'FSViewer.exe'),
                os.path.join(os.environ.get('ProgramFiles', ''), 'FastStone Image Viewer', 'FSViewer.exe'),
                'FSViewer.exe',
            ],
            'mac_app': None,
            'linux': [],
        },
        'xnview': {
            'win_candidates': [
                os.path.join(os.environ.get('ProgramFiles', ''), 'XnViewMP', 'xnviewmp.exe'),
                os.path.join(os.environ.get('ProgramFiles(x86)', ''), 'XnViewMP', 'xnviewmp.exe'),
                'xnviewmp.exe',
            ],
            'mac_app': 'XnViewMP',
            'linux': [['xnviewmp']],
        },
        'irfanview': {
            'win_candidates': [
                os.path.join(os.environ.get('ProgramFiles', ''), 'IrfanView', 'i_view64.exe'),
                os.path.join(os.environ.get('ProgramFiles(x86)', ''), 'IrfanView', 'i_view32.exe'),
                'i_view64.exe',
            ],
            'mac_app': None,
            'linux': [],
        },
    }

    info = _EDITOR_REGISTRY.get(editor)

    # Windows
    if sys.platform.startswith('win'):
        if info:
            # Special finder for darktable
            if 'win_find' in info:
                candidates = info['win_find']()
            else:
                candidates = info.get('win_candidates', [])
            for exe in candidates:
                if exe and os.path.exists(exe):
                    try:
                        subprocess.Popen([exe, path]); return
                    except Exception:
                        continue
            log(f'{editor} not found on Windows, falling back to system default')
        os.startfile(path)  # type: ignore[attr-defined]
        return

    # macOS
    if sys.platform == 'darwin':
        if info:
            apps_to_try = []
            if info.get('mac_app'):
                apps_to_try.append(info['mac_app'])
            apps_to_try.extend(info.get('mac_app_fallbacks', []))
            for app_name in apps_to_try:
                try:
                    cmd = ['open', '-a', app_name, path]
                    print(f"[LAUNCH] macOS: running: {cmd}", flush=True)
                    subprocess.Popen(cmd)
                    return
                except Exception as e:
                    print(f"[LAUNCH] macOS {app_name} launch failed: {e}", flush=True)
            if not apps_to_try:
                log(f'{editor} not available on macOS, falling back to system default')

        # System default: try a couple of strategies and log results
        try:
            cmd = ['open', path]
            print(f"[LAUNCH] macOS: trying system open: {cmd}", flush=True)
            p = subprocess.run(cmd, check=False)
            print(f"[LAUNCH] macOS: open returned code {p.returncode}", flush=True)
            if p.returncode == 0:
                return
        except Exception as e:
            print(f"[LAUNCH] macOS: open() raised: {e}", flush=True)

        # Fallback: try AppleScript via osascript
        try:
            script = f'tell application "Finder" to open (POSIX file "{path}")'
            print(f"[LAUNCH] macOS: trying osascript: {script}", flush=True)
            p = subprocess.run(['osascript', '-e', script], capture_output=True, text=True)
            print(f"[LAUNCH] macOS: osascript rc={p.returncode} stdout={p.stdout!r} stderr={p.stderr!r}", flush=True)
            if p.returncode == 0:
                return
        except Exception as e:
            print(f"[LAUNCH] macOS: osascript failed: {e}", flush=True)

        # Last resort: reveal in Finder
        try:
            cmd = ['open', '-R', path]
            print(f"[LAUNCH] macOS: fallback reveal: {cmd}", flush=True)
            subprocess.Popen(cmd)
            return
        except Exception as e:
            print(f"[LAUNCH] macOS: reveal fallback failed: {e}", flush=True)
        return

    # Linux / other
    if info:
        for cmd_args in info.get('linux', []):
            try:
                subprocess.Popen(cmd_args + [path]); return
            except FileNotFoundError:
                continue
    subprocess.Popen(['xdg-open', path])
