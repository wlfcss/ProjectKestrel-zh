import io
import os
import sys
import numpy as np
import rawpy
from PIL import Image, ImageOps


RAW_POSTPROCESS_VERSION = 'embedded-preview-v1'


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
        print(f"read_image: Reading {path}", flush=True)
        
        # Determine file type by extension
        ext = os.path.splitext(path)[1].lower()
        
        # RAW formats supported by rawpy
        raw_extensions = {'.cr2', '.cr3', '.nef', '.arw', '.dng', '.raf', '.orf', '.rw2', '.srw'}
        
        if ext in raw_extensions:
            # Use rawpy for RAW files
            print(f"read_image: Detected RAW file, using rawpy", flush=True)
            with rawpy.imread(path) as raw:
                rgb = postprocess_raw(raw)
            print(f"read_image: Successfully read RAW image, shape={rgb.shape}", flush=True)
            return rgb
        else:
            # Use PIL for standard image formats (JPEG, PNG, TIFF, etc.)
            print(f"read_image: Using PIL for standard image format", flush=True)
            img = Image.open(path)
            
            # Handle EXIF orientation
            from PIL import ImageOps
            img = ImageOps.exif_transpose(img)
            
            # Convert to RGB (handles grayscale, RGBA, etc.)
            if img.mode != 'RGB':
                print(f"read_image: Converting from {img.mode} to RGB", flush=True)
                img = img.convert('RGB')
            
            # Convert to numpy array
            rgb = np.array(img)
            print(f"read_image: Successfully read image, shape={rgb.shape}", flush=True)
            return rgb
            
    except rawpy.LibRawFileUnsupportedError:
        print(f"read_image: RAW format not supported for {path}", flush=True)
        return None
    except rawpy.LibRawIOError as e:
        print(f"read_image: I/O error reading RAW file {path}: {e}", flush=True)
        return None
    except Exception as e:
        import traceback
        print(f"Error in read_image({path}): {e}", flush=True)
        traceback.print_exc()
        return None


def read_image_for_pipeline(path: str):
    """
    Like read_image, but for RAW files returns the rawpy.RawPy object *open*
    alongside the postprocessed RGB array so that the pipeline can request a
    re-processed image with different exposure settings without re-reading the
    file from disk.

    Returns: (ndarray | None, rawpy.RawPy | None, ndarray | None)
      - For RAW files: (rgb_array, raw_obj, preview_rgb)
      - For non-RAW:   (rgb_array, None, rgb_array)
      - On failure:    (None, None, None)
    """
    try:
        print(f"read_image_for_pipeline: Reading {path}", flush=True)
        ext = os.path.splitext(path)[1].lower()
        raw_extensions = {'.cr2', '.cr3', '.nef', '.arw', '.dng', '.raf', '.orf', '.rw2', '.srw'}

        if ext in raw_extensions:
            print(f"read_image_for_pipeline: Detected RAW file, keeping rawpy object open", flush=True)
            # Do NOT use a context manager — we intentionally keep the object open.
            raw = rawpy.imread(path)
            rgb = postprocess_raw(raw)
            preview_rgb = extract_preview_from_raw(raw)
            print(f"read_image_for_pipeline: Successfully read RAW image, shape={rgb.shape}", flush=True)
            return rgb, raw, preview_rgb
        else:
            rgb = read_image(path)
            return rgb, None, rgb

    except rawpy.LibRawFileUnsupportedError:
        print(f"read_image_for_pipeline: RAW format not supported for {path}", flush=True)
        return None, None, None
    except rawpy.LibRawIOError as e:
        print(f"read_image_for_pipeline: I/O error reading RAW file {path}: {e}", flush=True)
        return None, None, None
    except Exception as e:
        import traceback
        print(f"Error in read_image_for_pipeline({path}): {e}", flush=True)
        traceback.print_exc()
        return None, None, None
