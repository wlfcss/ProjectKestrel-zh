import cv2
import numpy as np


def compute_similarity_timestamp(path1, path2, threshold_seconds: float = 1.0):
    """
    Return True if two image files were captured within threshold_seconds of each other,
    False if they were not, or None if timestamps could not be read for either file.
    """
    from datetime import timedelta
    try:
        try:
            from .raw_exif import get_capture_time
        except ImportError:
            from raw_exif import get_capture_time
        t1 = get_capture_time(path1)
        t2 = get_capture_time(path2)
        return abs(t1 - t2) <= timedelta(seconds=threshold_seconds)
    except Exception:
        return None


def compute_image_similarity_akaze(img1, img2, max_dim=1600):
    if img1 is None or img2 is None or img1.shape != img2.shape:
        return {
            "feature_similarity": -1,
            "feature_confidence": -1,
            "color_similarity": -1,
            "color_confidence": -1,
            "similar": False,
            "confidence": 0,
        }
    try:
        def resize(img):
            h, w = img.shape[:2]
            scale = max_dim / max(h, w)
            if scale < 1.0:
                img = cv2.resize(img, (int(w * scale), int(h * scale)), interpolation=cv2.INTER_AREA)
            return img

        img1 = resize(img1)
        img2 = resize(img2)
        gray1 = cv2.cvtColor(img1, cv2.COLOR_RGB2GRAY) if img1.ndim == 3 else img1
        gray2 = cv2.cvtColor(img2, cv2.COLOR_RGB2GRAY) if img2.ndim == 3 else img2
        akaze = cv2.AKAZE_create()
        kp1, des1 = akaze.detectAndCompute(gray1, None)
        kp2, des2 = akaze.detectAndCompute(gray2, None)
        if des1 is not None and len(kp1) > 300:
            kp1, des1 = zip(*sorted(zip(kp1, des1), key=lambda x: x[0].response, reverse=True)[:300])
            kp1 = list(kp1)
            des1 = np.array(des1)
        if des2 is not None and len(kp2) > 300:
            kp2, des2 = zip(*sorted(zip(kp2, des2), key=lambda x: x[0].response, reverse=True)[:300])
            kp2 = list(kp2)
            des2 = np.array(des2)
        feature_confidence = min(len(kp1), len(kp2)) / 300 if kp1 and kp2 else 0
        if feature_confidence < 0.25 or des1 is None or des2 is None or len(kp1) == 0 or len(kp2) == 0:
            mean1 = np.mean(img1.reshape(-1, img1.shape[-1]), axis=0)
            mean2 = np.mean(img2.reshape(-1, img2.shape[-1]), axis=0)
            color_diff = np.sum(np.abs(mean1 - mean2))
            return {
                "feature_similarity": 0,
                "feature_confidence": 0,
                "color_similarity": float(color_diff),
                "color_confidence": float(abs((768 - color_diff) / 768) if color_diff <= 150 else abs(color_diff / 768)),
                "similar": bool(color_diff <= 150),
                "confidence": float(abs((768 - color_diff) / 768) if color_diff <= 150 else abs(color_diff / 768)),
            }
        bf = cv2.BFMatcher(cv2.NORM_HAMMING)
        matches = bf.knnMatch(des1, des2, k=2)
        m_arr = np.array([m.distance for m, n in matches])
        n_arr = np.array([n.distance for m, n in matches])
        good_mask = m_arr < 0.7 * n_arr
        feature_similarity = np.sum(good_mask) / ((len(kp1) + len(kp2)) / 2) if (len(kp1) + len(kp2)) > 0 else 0
        similar = feature_similarity >= 0.05
        return {
            "feature_similarity": float(feature_similarity),
            "feature_confidence": float(feature_confidence),
            "color_similarity": 0,
            "color_confidence": 0,
            "similar": bool(similar),
            "confidence": float(feature_confidence),
        }
    except Exception:
        return {
            "feature_similarity": -1,
            "feature_confidence": -1,
            "color_similarity": -1,
            "color_confidence": -1,
            "similar": False,
            "confidence": 0,
        }
