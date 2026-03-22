import io
import os
import sys
import numpy as np
import rawpy
from PIL import Image, ImageOps


RAW_POSTPROCESS_VERSION = 'embedded-preview-v2'


RAW_POSTPROCESS_BASE_KWARGS = {
    'use_camera_wb': True,
    'output_color': rawpy.ColorSpace.sRGB,
}


def postprocess_raw(raw: rawpy.RawPy, *, exposure_stops: float = 0.0):
    """Decode a RAW frame with explicit color settings that match camera previews better."""
    kwargs = dict(RAW_POSTPROCESS_BASE_KWARGS)
    if exposure_stops != 0.0:
        linear_scale = float(np.clip(2.0 ** exposure_stops, 0.25, 8.0))
        kwargs.update({
            'no_auto_bright': True,
            'exp_shift': linear_scale,
            'exp_preserve_highlights': 0.8 if exposure_stops > 0 else 0.0,
        })
    return raw.postprocess(**kwargs)


def extract_preview_from_raw(raw: rawpy.RawPy):
    """Return the embedded RAW preview as an RGB ndarray when available."""
    try:
        thumb = raw.extract_thumb()
    except (rawpy.LibRawNoThumbnailError, rawpy.LibRawUnsupportedThumbnailError):
        return None
    except Exception:
        return None

    try:
        if thumb.format == rawpy.ThumbFormat.JPEG:
            with Image.open(io.BytesIO(thumb.data)) as img:
                img = ImageOps.exif_transpose(img)
                return np.array(img.convert('RGB'))
        if thumb.format == rawpy.ThumbFormat.BITMAP:
            arr = np.asarray(thumb.data)
            if arr.ndim == 2:
                arr = np.stack([arr, arr, arr], axis=-1)
            if arr.dtype != np.uint8:
                arr = np.clip(arr, 0, 255).astype(np.uint8)
            return arr
    except Exception:
        return None
    return None


def read_image(path: str):
    """
    Read an image using rawpy for RAW files or PIL for standard formats.
    Returns a numpy array in RGB format (H, W, 3) or None on failure.
    """
    try:
        # Determine file type by extension
        ext = os.path.splitext(path)[1].lower()

        # RAW formats supported by rawpy
        raw_extensions = {'.cr2', '.cr3', '.nef', '.arw', '.dng', '.raf', '.orf', '.rw2', '.srw'}

        if ext in raw_extensions:
            # Use rawpy for RAW files
            with rawpy.imread(path) as raw:
                rgb = postprocess_raw(raw)
            return rgb
        else:
            # Use PIL for standard image formats (JPEG, PNG, TIFF, etc.)
            img = Image.open(path)

            # Handle EXIF orientation
            from PIL import ImageOps
            img = ImageOps.exif_transpose(img)

            # Convert to RGB (handles grayscale, RGBA, etc.)
            if img.mode != 'RGB':
                img = img.convert('RGB')

            # Convert to numpy array
            rgb = np.array(img)
            return rgb

    except rawpy.LibRawFileUnsupportedError:
        return None
    except rawpy.LibRawIOError:
        return None
    except Exception:
        return None


def read_image_for_pipeline(path: str):
    """
    Preview-first loader for the analysis pipeline.

    For RAW files we **only** extract the embedded JPEG preview (very fast,
    ~50 ms) and keep the rawpy object open.  The expensive full-sensor
    demosaicing (~1500 ms) is deferred until the pipeline actually needs it
    (i.e. when a bird is detected and high-quality crops are required).

    Returns: (ndarray | None, rawpy.RawPy | None, ndarray | None)
      - For RAW files: (preview_rgb, raw_obj, preview_rgb)
            ``preview_rgb`` is the embedded camera JPEG preview.
            The caller can later call ``postprocess_raw(raw_obj)`` for a
            full-resolution decode when needed.
      - For non-RAW:   (rgb_array, None, rgb_array)
      - On failure:    (None, None, None)
    """
    try:
        ext = os.path.splitext(path)[1].lower()
        raw_extensions = {'.cr2', '.cr3', '.nef', '.arw', '.dng', '.raf', '.orf', '.rw2', '.srw'}

        if ext in raw_extensions:
            # Do NOT use a context manager — we intentionally keep the object open.
            raw = rawpy.imread(path)
            preview_rgb = extract_preview_from_raw(raw)
            if preview_rgb is not None:
                # Fast path: use embedded preview for detection, defer full decode
                return preview_rgb, raw, preview_rgb
            else:
                # Fallback: no embedded preview, must do full decode now
                rgb = postprocess_raw(raw)
                return rgb, raw, rgb
        else:
            rgb = read_image(path)
            return rgb, None, rgb

    except rawpy.LibRawFileUnsupportedError:
        return None, None, None
    except rawpy.LibRawIOError:
        return None, None, None
    except Exception:
        return None, None, None
