# -*- mode: python ; coding: utf-8 -*-
import sys ; sys.setrecursionlimit(sys.getrecursionlimit() * 20)
import os

# COMMAND USED TO GENERATE THIS: python -m PyInstaller main.py --onefile --paths=. --runtime-hook=runtime_hook.py --add-data "models;models" --add-data "gui_app.py;." --add-data "gui_helpers.py;." --add-data "cli.py;." --add-data "VERSION.txt;." --add-data "kestrel_analyzer;kestrel_analyzer" --collect-all msvc-runtime --collect-binaries torch --collect-binaries onnxruntime --collect-binaries tensorflow --name "main_with_msvcruntime"
from PyInstaller.utils.hooks import collect_dynamic_libs
from PyInstaller.utils.hooks import collect_all
from PyInstaller.building.datastruct import Tree

datas = [('models', 'models'), ('gui_app.py', '.'), ('gui_helpers.py', '.'), ('cli.py', '.'), ('VERSION.txt', '.'), ('kestrel_analyzer', 'kestrel_analyzer')]
if os.path.isdir('ImageMagick/ImageMagick-7.0.10'):
    datas.append(Tree('ImageMagick/ImageMagick-7.0.10', prefix='ImageMagick/ImageMagick-7.0.10'))
binaries = []
hiddenimports = []
binaries += collect_dynamic_libs('torch')
binaries += collect_dynamic_libs('onnxruntime')
binaries += collect_dynamic_libs('tensorflow')
tmp_ret = collect_all('msvc-runtime')
datas += tmp_ret[0]; binaries += tmp_ret[1]; hiddenimports += tmp_ret[2]


def _normalize_datas(items):
    normalized = []
    for item in items:
        if isinstance(item, Tree):
            normalized.append(item)
            continue
        if isinstance(item, tuple):
            if len(item) == 2:
                normalized.append(item)
            elif len(item) == 3:
                normalized.append((item[0], item[1]))
            else:
                print(f"Unexpected datas tuple len={len(item)}: {item}")
        elif isinstance(item, list):
            for entry in item:
                if isinstance(entry, tuple):
                    if len(entry) == 2:
                        normalized.append(entry)
                    elif len(entry) == 3:
                        normalized.append((entry[0], entry[1]))
                    else:
                        print(f"Unexpected datas list entry len={len(entry)}: {entry}")
                else:
                    print(f"Unexpected datas list entry type={type(entry)} value={entry}")
        elif hasattr(item, 'toc'):
            try:
                toc_items = item.toc
            except Exception as exc:
                print(f"Failed to read Tree.toc: {exc}")
                continue
            for entry in toc_items:
                if len(entry) == 2:
                    normalized.append(entry)
                elif len(entry) == 3:
                    normalized.append((entry[0], entry[1]))
                else:
                    print(f"Unexpected Tree entry len={len(entry)}: {entry}")
        else:
            print(f"Unexpected datas entry type={type(item)} value={item}")
    return normalized


datas = _normalize_datas(datas)


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

app = BUNDLE(
    exe,
    name='kestrel_analyzer.app',
    icon='../assets/logo.ico',
    bundle_identifier='org.ProjectKestrel.Analyzer',
)
