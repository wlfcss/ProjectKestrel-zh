import os
import sys
import ctypes


def _prepend_env_path(var_name: str, path: str) -> None:
    if not path:
        return
    current = os.environ.get(var_name, '')
    if current:
        os.environ[var_name] = path + os.pathsep + current
    else:
        os.environ[var_name] = path


def _debug(msg: str) -> None:
    print(f"[runtime_hook] {msg}")


def _dump_tree(root: str, max_depth: int = 2) -> None:
    if not os.path.isdir(root):
        _debug(f"MEIPASS not a directory: {root}")
        return
    _debug(f"MEIPASS tree (max depth {max_depth}): {root}")
    root_depth = root.rstrip(os.sep).count(os.sep)
    for current_root, dirs, files in os.walk(root):
        depth = current_root.rstrip(os.sep).count(os.sep) - root_depth
        if depth > max_depth:
            dirs[:] = []
            continue
        indent = '  ' * depth
        _debug(f"{indent}{os.path.basename(current_root) or current_root}")
        for name in sorted(files):
            _debug(f"{indent}  {name}")


if sys.platform == 'win32' and getattr(sys, 'frozen', False):
    base_path = sys._MEIPASS
    _debug(f"frozen=True platform=win32 base_path={base_path}")
    _dump_tree(base_path, max_depth=2)

    # Add base path to DLL search
    os.add_dll_directory(base_path)
    _prepend_env_path('PATH', base_path)

    # Preload MSVC runtime
    msvc_dlls = ['msvcp140.dll', 'vcruntime140.dll', 'vcruntime140_1.dll']
    for dll in msvc_dlls:
        dll_path = os.path.join(base_path, dll)
        if os.path.exists(dll_path):
            try:
                ctypes.CDLL(dll_path)
            except Exception:
                pass
elif sys.platform == 'darwin':
    base_path = sys._MEIPASS
    _debug(f"frozen=True platform=darwin base_path={base_path}")
    _dump_tree(base_path, max_depth=2)
    magick_home = base_path #os.path.join(base_path, 'ImageMagick', 'ImageMagick-7.0.10')
    magick_bin = os.path.join(magick_home, 'bin')
    magick_lib = os.path.join(magick_home, 'lib')
    magick_etc = os.path.join(magick_home, 'etc', 'ImageMagick-7')
    magick_coders = os.path.join(
        magick_lib, 'ImageMagick-7.0.10', 'modules-Q16HDRI', 'coders'
    )

    if os.path.isdir(magick_home):
        os.environ.setdefault('MAGICK_HOME', magick_home)
        if os.path.isdir(magick_etc):
            os.environ.setdefault('MAGICK_CONFIGURE_PATH', magick_etc)
        if os.path.isdir(magick_coders):
            os.environ.setdefault('MAGICK_CODER_MODULE_PATH', magick_coders)
        _prepend_env_path('PATH', magick_bin)
        _prepend_env_path('DYLD_FALLBACK_LIBRARY_PATH', magick_lib)
        _prepend_env_path('DYLD_LIBRARY_PATH', magick_lib)
