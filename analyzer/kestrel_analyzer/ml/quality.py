import csv
import time

import cv2
import numpy as np
import tensorflow as tf


class QualityClassifier:
    def __init__(self, model_path: str, normalization_data_path: str = None):
        gpus = tf.config.list_physical_devices("GPU")
        if gpus:
            print(f"[quality] TensorFlow GPU devices available: {[g.name for g in gpus]}")
        else:
            print("[quality] No TensorFlow GPU detected, using CPU")
        self.model = tf.keras.models.load_model(model_path)
        self._norm_qualities = None
        self._norm_percentiles = None
        if normalization_data_path:
            try:
                self._load_normalization_data(normalization_data_path)
            except Exception:
                # Fallback to raw quality output if normalization data cannot be read.
                self._norm_qualities = None
                self._norm_percentiles = None

    def _load_normalization_data(self, normalization_data_path: str) -> None:
        rows = []
        with open(normalization_data_path, "r", newline="", encoding="utf-8") as f:
            reader = csv.DictReader(f)
            for row in reader:
                try:
                    p = float(row.get("percentile", ""))
                    q = float(row.get("quality", ""))
                except (TypeError, ValueError):
                    continue
                if not np.isfinite(p) or not np.isfinite(q):
                    continue
                rows.append((q, p / 100.0))
        if not rows:
            return
        rows.sort(key=lambda x: x[0])
        self._norm_qualities = np.array([q for q, _ in rows], dtype=np.float32)
        self._norm_percentiles = np.array([p for _, p in rows], dtype=np.float32)

    def _normalize_quality_to_percentile(self, quality: float) -> float:
        if quality < 0:
            return quality
        if self._norm_qualities is None or self._norm_percentiles is None:
            return quality

        q = float(quality)
        qualities = self._norm_qualities
        percentiles = self._norm_percentiles

        if q <= qualities[0]:
            return float(percentiles[0])
        if q >= qualities[-1]:
            return float(percentiles[-1])

        idx = int(np.searchsorted(qualities, q, side="right"))
        q0 = float(qualities[idx - 1])
        q1 = float(qualities[idx])
        p0 = float(percentiles[idx - 1])
        p1 = float(percentiles[idx])

        if q1 <= q0:
            return p1
        t = (q - q0) / (q1 - q0)
        return p0 + t * (p1 - p0)

    @staticmethod
    def _preprocess(cropped_img, cropped_mask):
        img = cv2.cvtColor(cropped_img, cv2.COLOR_RGB2GRAY)
        sobel_x = cv2.Sobel(img, cv2.CV_32F, 1, 0, ksize=5)
        sobel_y = cv2.Sobel(img, cv2.CV_32F, 0, 1, ksize=5)
        img = np.sqrt(sobel_x ** 2 + sobel_y ** 2)
        img1 = cv2.bitwise_and(img, img, mask=cropped_mask.astype(np.uint8))
        images = np.array([img1]).transpose(1, 2, 0)
        return images

    def classify(self, cropped_image, cropped_mask, retry=5):
        for _ in range(retry):
            try:
                input_data = self._preprocess(cropped_image, cropped_mask)
                output_value = self.model.predict(np.expand_dims(input_data, axis=0), verbose=0)
                raw_quality = float(output_value[0][0])
                return self._normalize_quality_to_percentile(raw_quality)
            except Exception:
                time.sleep(0.05)
        return -1.0
