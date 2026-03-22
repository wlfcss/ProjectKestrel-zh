# -*- mode: python ; coding: utf-8 -*-
import os

from PyInstaller.utils.hooks import collect_dynamic_libs
from PyInstaller.utils.hooks import collect_all
# tree is already imported by pyinstaller runtime environment.


# Build datas list with proper sample_sets bundling using Tree()
datas = [('models', 'models'), ('folder_inspector.py', '.'), ('cli.py', '.'), ('VERSION.txt', '.'), ('kestrel_analyzer', 'kestrel_analyzer'), ('visualizer.html', '.'), ('visualizer.css', '.'), ('visualizer.js', '.'), ('i18n.js', '.'), ('taxonomy.js', '.'), ('taxonomy_zh_cn.json', '.'), ('papaparse.local.js', '.'), ('culling.html', '.'), ('logo.png', '.'), ('logo.ico', '.'), ('settings_utils.py', '.'), ('editor_launch.py', '.'), ('queue_manager.py', '.'), ('api_bridge.py', '.'), ('metadata_writer.py', '.'), ('taxonomy_utils.py', '.')]

# Add sample_sets using Tree() - convert 3-element tuples to 2-element format for datas
sample_sets_tree = Tree('sample_sets', prefix='sample_sets')
datas += [(item[0], item[1]) for item in sample_sets_tree]  # Only use first 2 elements of each tuple
binaries = []
hiddenimports = ['pywebview', 'certifi','PIL','exifread','settings_utils','editor_launch','queue_manager','api_bridge','metadata_writer','taxonomy_utils','folder_inspector']
binaries += collect_dynamic_libs('torch')
binaries += collect_dynamic_libs('onnxruntime')
binaries += collect_dynamic_libs('tensorflow')

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
    upx=False,
    console=True,
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
    upx=False,
    upx_exclude=[],
    name='LingjianLite',
    icon='../assets/logo.ico',
)

app = BUNDLE(
    coll,
    name='翎鉴 Lite.app',
    icon='../assets/logo.ico',
    bundle_identifier='org.lingjian-lite',
)
