"""Apple Silicon (MPS / CoreML) device detection utilities."""

import platform
import sys


def get_onnx_providers(use_gpu: bool = True):
    """Return an ordered list of ONNX Runtime execution providers.

    On Apple Silicon, ``CoreMLExecutionProvider`` is preferred when
    *use_gpu* is True and the provider is actually available in the
    installed ``onnxruntime`` build.
    """
    try:
        import onnxruntime as ort
        available = set(ort.get_available_providers())
    except Exception:
        return ["CPUExecutionProvider"]

    if use_gpu and sys.platform == "darwin" and platform.machine() == "arm64":
        if "CoreMLExecutionProvider" in available:
            return ["CoreMLExecutionProvider", "CPUExecutionProvider"]

    return ["CPUExecutionProvider"]
