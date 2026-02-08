# -*- mode: python ; coding: utf-8 -*-

# COMMAND USED TO GENERATE THIS: python -m PyInstaller main.py --onefile --paths=. --runtime-hook=runtime_hook.py --add-data "models;models" --add-data "gui_app.py;." --add-data "gui_helpers.py;." --add-data "cli.py;." --add-data "VERSION.txt;." --add-data "kestrel_analyzer;kestrel_analyzer" --collect-all msvc-runtime --collect-binaries torch --collect-binaries onnxruntime --collect-binaries tensorflow --name "main_with_msvcruntime"
from PyInstaller.utils.hooks import collect_dynamic_libs
from PyInstaller.utils.hooks import collect_all

datas = [('models', 'models'), ('gui_app.py', '.'), ('gui_helpers.py', '.'), ('cli.py', '.'), ('VERSION.txt', '.'), ('kestrel_analyzer', 'kestrel_analyzer')]
binaries = []
hiddenimports = []
binaries += collect_dynamic_libs('torch')
binaries += collect_dynamic_libs('onnxruntime')
binaries += collect_dynamic_libs('tensorflow')
tmp_ret = collect_all('msvc-runtime')
datas += tmp_ret[0]; binaries += tmp_ret[1]; hiddenimports += tmp_ret[2]


a = Analysis(
    ['main.py'],
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
    a.binaries,
    a.datas,
    [],
    name='kestrel_analyzer',
    icon='../assets/logo.ico',
    debug=False,
    bootloader_ignore_signals=False,
    strip=False,
    upx=True,
    upx_exclude=[],
    runtime_tmpdir=None,
    console=False,
    disable_windowed_traceback=False,
    argv_emulation=False,
    target_arch=None,
    codesign_identity=None,
    entitlements_file=None,
)
