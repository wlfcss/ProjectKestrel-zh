import os
from typing import Optional

import numpy as np
from PyQt6.QtGui import QImage


def numpy_to_qimage(img: np.ndarray) -> Optional[QImage]:
    if img is None:
        return None
    if img.ndim == 2:
        h, w = img.shape
        qimg = QImage(img.data, w, h, w, QImage.Format.Format_Grayscale8)
        return qimg.copy()
    if img.ndim == 3:
        h, w, c = img.shape
        if c == 3:
            bytes_per_line = 3 * w
            qimg = QImage(img.data, w, h, bytes_per_line, QImage.Format.Format_RGB888)
            return qimg.copy()
    return None


def load_qimage_from_path(path: str) -> Optional[QImage]:
    if not path or not os.path.exists(path):
        return None
    qimg = QImage(path)
    return qimg if not qimg.isNull() else None
