# -*- mode: python ; coding: utf-8 -*-
from PyInstaller.utils.hooks import collect_dynamic_libs
from PyInstaller.utils.hooks import collect_all

datas = [
    ('models', 'models'),
    ('kestrel_analyzer', 'kestrel_analyzer'),
    # Front-end resources
    ('visualizer.html', '.'),
    ('visualizer.css', '.'),
    ('visualizer.js', '.'),
    ('i18n.js', '.'),
    ('taxonomy.js', '.'),
    ('taxonomy_zh_cn.json', '.'),
    ('papaparse.local.js', '.'),
    ('culling.html', '.'),
    ('logo.png', '.'),
    ('logo.ico', '.'),
    # Python modules loaded dynamically or via imports
    ('settings_utils.py', '.'),
    ('editor_launch.py', '.'),
    ('queue_manager.py', '.'),
    ('api_bridge.py', '.'),
    ('metadata_writer.py', '.'),
    ('taxonomy_utils.py', '.'),
    ('folder_inspector.py', '.'),
    ('cli.py', '.'),
    ('main.py', '.'),
    ('VERSION.txt', '.'),
]
binaries = []
hiddenimports = [
    'pywebview',
    'PIL',
    'exifread',
    'settings_utils',
    'editor_launch',
    'queue_manager',
    'api_bridge',
    'metadata_writer',
    'taxonomy_utils',
    'folder_inspector',
]
binaries += collect_dynamic_libs('torch')
binaries += collect_dynamic_libs('onnxruntime')
try:
    binaries += collect_dynamic_libs('onnxruntime_directml')
except Exception:
    pass
binaries += collect_dynamic_libs('tensorflow')
tmp_ret = collect_all('msvc-runtime')
datas += tmp_ret[0]; binaries += tmp_ret[1]; hiddenimports += tmp_ret[2]


a = Analysis(
    ['visualizer.py'],
    pathex=['.'],
    binaries=binaries,
    datas=datas,
    hiddenimports=hiddenimports,
    hookspath=[],
    hooksconfig={},
    runtime_hooks=['runtime_hook.py'],
    excludes=[],
    noarchive=False,
    optimize=0,
)
pyz = PYZ(a.pure)

exe = EXE(
    pyz,
    a.scripts,
    [],
    exclude_binaries=True,
    name='LingjianLite',
    debug=False,
    bootloader_ignore_signals=False,
    strip=False,
    upx=True,
    console=False,
    icon='../assets/logo.ico',
    disable_windowed_traceback=False,
    argv_emulation=False,
    target_arch=None,
    codesign_identity=None,
    entitlements_file=None,
)
coll = COLLECT(
    exe,
    a.binaries,
    a.datas,
    strip=False,
    upx=True,
    upx_exclude=[],
    name='LingjianLite',
)
