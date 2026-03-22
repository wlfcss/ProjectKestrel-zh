"""Device detection utilities for GPU acceleration.

- macOS Apple Silicon: CoreML (ONNX)
- Windows: DirectML (ONNX, supports NVIDIA/AMD/Intel)
- Fallback: CPU
"""

import platform
import sys


def get_onnx_providers(use_gpu: bool = True):
    """Return an ordered list of ONNX Runtime execution providers.

    On Apple Silicon, ``CoreMLExecutionProvider`` is preferred.
    On Windows, ``DmlExecutionProvider`` is preferred (DirectML).
    """
    try:
        import onnxruntime as ort
        available = set(ort.get_available_providers())
    except Exception:
        return ["CPUExecutionProvider"]

    if use_gpu:
        # macOS Apple Silicon → CoreML
        if sys.platform == "darwin" and platform.machine() == "arm64":
            if "CoreMLExecutionProvider" in available:
                return ["CoreMLExecutionProvider", "CPUExecutionProvider"]

        # Windows → DirectML
        if sys.platform == "win32":
            if "DmlExecutionProvider" in available:
                return ["DmlExecutionProvider", "CPUExecutionProvider"]

    return ["CPUExecutionProvider"]
