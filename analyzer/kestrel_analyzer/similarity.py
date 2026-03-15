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
    if img1 is None or img2 is None:
        return {
            "feature_similarity": -1,
            "feature_confidence": -1,
            "color_similarity": -1,
            "color_confidence": -1,
            "similar": False,
            "confidence": 0,
        }
    try:
        def clamp(value, low, high):
            return float(max(low, min(high, value)))

        def resize(img):
            h, w = img.shape[:2]
            scale = max_dim / max(h, w)
            if scale < 1.0:
                img = cv2.resize(img, (int(w * scale), int(h * scale)), interpolation=cv2.INTER_AREA)
            return img

        def color_similarity_score(a, b):
            # Histogram-based color similarity is much more stable under blur than mean-RGB deltas.
            target_w = 320
            ah, aw = a.shape[:2]
            bh, bw = b.shape[:2]
            a_small = cv2.resize(a, (target_w, max(1, int(target_w * ah / max(aw, 1)))), interpolation=cv2.INTER_AREA)
            b_small = cv2.resize(b, (target_w, max(1, int(target_w * bh / max(bw, 1)))), interpolation=cv2.INTER_AREA)

            hsv1 = cv2.cvtColor(a_small, cv2.COLOR_RGB2HSV)
            hsv2 = cv2.cvtColor(b_small, cv2.COLOR_RGB2HSV)

            hist1 = cv2.calcHist([hsv1], [0, 1, 2], None, [18, 16, 16], [0, 180, 0, 256, 0, 256])
            hist2 = cv2.calcHist([hsv2], [0, 1, 2], None, [18, 16, 16], [0, 180, 0, 256, 0, 256])
            cv2.normalize(hist1, hist1, alpha=1.0, norm_type=cv2.NORM_L1)
            cv2.normalize(hist2, hist2, alpha=1.0, norm_type=cv2.NORM_L1)

            # Bhattacharyya distance in [0, 1] for normalized histograms.
            bhatta = float(cv2.compareHist(hist1, hist2, cv2.HISTCMP_BHATTACHARYYA))
            hist_sim = clamp(1.0 - bhatta, 0.0, 1.0)

            lab1 = cv2.cvtColor(a_small, cv2.COLOR_RGB2LAB)
            lab2 = cv2.cvtColor(b_small, cv2.COLOR_RGB2LAB)
            l1 = np.mean(lab1.reshape(-1, 3), axis=0)
            l2 = np.mean(lab2.reshape(-1, 3), axis=0)
            mean_delta = float(np.linalg.norm(l1 - l2))
            mean_sim = clamp(1.0 - (mean_delta / 130.0), 0.0, 1.0)

            sat_std = max(float(np.std(hsv1[:, :, 1])), float(np.std(hsv2[:, :, 1])))
            val_std = max(float(np.std(hsv1[:, :, 2])), float(np.std(hsv2[:, :, 2])))
            color_conf = clamp((0.65 * sat_std + 0.35 * val_std) / 55.0, 0.25, 1.0)

            color_sim = 0.75 * hist_sim + 0.25 * mean_sim
            return float(color_sim), float(color_conf)

        img1 = resize(img1)
        img2 = resize(img2)
        gray1 = cv2.cvtColor(img1, cv2.COLOR_RGB2GRAY) if img1.ndim == 3 else img1
        gray2 = cv2.cvtColor(img2, cv2.COLOR_RGB2GRAY) if img2.ndim == 3 else img2
        akaze = cv2.AKAZE_create()
        kp1, des1 = akaze.detectAndCompute(gray1, None)
        kp2, des2 = akaze.detectAndCompute(gray2, None)
        if des1 is not None and len(kp1) > 400:
            kp1, des1 = zip(*sorted(zip(kp1, des1), key=lambda x: x[0].response, reverse=True)[:400])
            kp1 = list(kp1)
            des1 = np.array(des1)
        if des2 is not None and len(kp2) > 400:
            kp2, des2 = zip(*sorted(zip(kp2, des2), key=lambda x: x[0].response, reverse=True)[:400])
            kp2 = list(kp2)
            des2 = np.array(des2)
        min_kp = min(len(kp1), len(kp2)) if kp1 and kp2 else 0
        feature_confidence = clamp(min_kp / 240.0, 0.0, 1.0)
        color_similarity, color_confidence = color_similarity_score(img1, img2)

        feature_similarity = 0.0
        if des1 is not None and des2 is not None and len(kp1) > 0 and len(kp2) > 0:
            bf = cv2.BFMatcher(cv2.NORM_HAMMING)
            matches = bf.knnMatch(des1, des2, k=2)

            ratio_thresh = 0.72 + 0.08 * (1.0 - feature_confidence)
            good_matches = []
            for pair in matches:
                if len(pair) < 2:
                    continue
                m, n = pair
                if m.distance < ratio_thresh * n.distance:
                    good_matches.append(m)

            denom = float(max(1, min_kp))
            match_ratio = float(len(good_matches) / denom)

            inlier_ratio = 0.0
            if len(good_matches) >= 8:
                src_pts = np.float32([kp1[m.queryIdx].pt for m in good_matches]).reshape(-1, 1, 2)
                dst_pts = np.float32([kp2[m.trainIdx].pt for m in good_matches]).reshape(-1, 1, 2)
                _, inlier_mask = cv2.findHomography(src_pts, dst_pts, cv2.RANSAC, 4.0)
                if inlier_mask is not None and len(inlier_mask) > 0:
                    inlier_ratio = float(np.sum(inlier_mask) / len(inlier_mask))

            feature_similarity = 0.7 * match_ratio + 0.3 * inlier_ratio
            feature_similarity = clamp(feature_similarity, 0.0, 1.0)

        # Blend feature and color paths. Sparse-keypoint pairs rely more on color.
        weight_feature = 0.2 + 0.65 * feature_confidence
        weight_color = 1.0 - weight_feature
        blended_score = weight_feature * feature_similarity + weight_color * color_similarity

        # "Very high confidence on either path" override.
        very_high_feature = feature_confidence >= 0.75 and feature_similarity >= 0.09
        very_high_color = color_confidence >= 0.80 and color_similarity >= 0.92
        similar = bool(very_high_feature or very_high_color or blended_score >= 0.56)

        overall_confidence = clamp(
            max(feature_confidence * feature_similarity, color_confidence * color_similarity),
            0.0,
            1.0,
        )

        return {
            "feature_similarity": float(feature_similarity),
            "feature_confidence": float(feature_confidence),
            "color_similarity": float(color_similarity),
            "color_confidence": float(color_confidence),
            "similar": bool(similar),
            "confidence": float(overall_confidence),
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
