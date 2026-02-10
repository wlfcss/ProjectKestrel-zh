import os
import sys
import ctypes

if sys.platform == 'win32' and getattr(sys, 'frozen', False):
    base_path = sys._MEIPASS
    
    # Add base path to DLL search
    os.add_dll_directory(base_path)
    os.environ['PATH'] = base_path + os.pathsep + os.environ.get('PATH', '')
    
    # Preload MSVC runtime
    msvc_dlls = ['msvcp140.dll', 'vcruntime140.dll', 'vcruntime140_1.dll']
    for dll in msvc_dlls:
        dll_path = os.path.join(base_path, dll)
        if os.path.exists(dll_path):
            try:
                ctypes.CDLL(dll_path)
            except:
                pass
