# -*- mode: python ; coding: utf-8 -*-
import os
from PyInstaller.utils.hooks import collect_dynamic_libs, collect_all

block_cipher = None

datas = [
    ('models', 'models'),
    ('gui_app.py', '.'),
    ('gui_helpers.py', '.'),
    ('cli.py', '.'),
    ('VERSION.txt', '.'),
    ('kestrel_analyzer', 'kestrel_analyzer'),
    # include analyzer-specific UI assets so onedir contains them
    (os.path.join('analyzer', 'visualizer.html'), 'analyzer'),
    (os.path.join('analyzer', 'logo.png'), 'analyzer'),
    (os.path.join('analyzer', 'logo.ico'), 'analyzer'),
]

binaries = []
hiddenimports = ['pywebview']

# Collect runtime binaries used by major ML libs
binaries += collect_dynamic_libs('torch')
binaries += collect_dynamic_libs('onnxruntime')
binaries += collect_dynamic_libs('tensorflow')

a = Analysis(
    ['analyzer/visualizer.py'],
    pathex=['.'],
    binaries=binaries,
    datas=datas,
    hiddenimports=hiddenimports,
    hookspath=[],
    hooksconfig={},
    runtime_hooks=['analyzer/runtime_hook.py'],
    excludes=[],
    noarchive=False,
)

pyz = PYZ(a.pure, a.zipped_data, cipher=block_cipher)

exe = EXE(
    pyz,
    a.scripts,
    [],
    exclude_binaries=True,
    name='ProjectKestrel',
    debug=False,
    bootloader_ignore_signals=False,
    strip=False,
    upx=True,
    console=False,
)

coll = COLLECT(
    exe,
    a.binaries,
    a.zipfiles,
    a.datas,
    strip=False,
    upx=True,
    name='ProjectKestrel',
)
