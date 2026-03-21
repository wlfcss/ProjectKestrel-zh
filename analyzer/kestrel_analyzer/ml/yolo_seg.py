import os
import platform
import sys
import time
from pathlib import Path

import cv2
import numpy as np

os.environ.setdefault("YOLO_VERBOSE", "False")

from ..config import YOLO_SEG_WEIGHTS_PATH, MODELS_DIR


def _is_apple_silicon():
    return sys.platform == "darwin" and platform.machine() == "arm64"


class YOLOSegWrapper:
    def __init__(self):
        from ultralytics import YOLO

        weights_path = Path(YOLO_SEG_WEIGHTS_PATH)
        if not weights_path.exists():
            raise FileNotFoundError(
                f"YOLO weights not found at: {weights_path}\n"
                "The weights file should be bundled with the application."
            )
        self._raise_if_lfs_pointer(weights_path)

        self._use_coreml = False
        if _is_apple_silicon():
            coreml_path = MODELS_DIR / "yolo26s-seg.mlpackage"
            try:
                if coreml_path.exists():
                    self.model = YOLO(str(coreml_path))
                    self._use_coreml = True
                else:
                    print("[yolo_seg] Converting to CoreML (one-time)...")
                    pt_model = YOLO(str(weights_path))
                    pt_model.export(format="coreml", imgsz=640)
                    # export saves to same directory as .pt with .mlpackage suffix
                    exported = weights_path.with_suffix(".mlpackage")
                    if exported.exists() and exported != coreml_path:
                        exported.rename(coreml_path)
                    self.model = YOLO(str(coreml_path))
                    self._use_coreml = True
            except Exception as exc:
                print(f"[yolo_seg] CoreML init failed, using PyTorch CPU: {exc}")
                self.model = YOLO(str(weights_path))
        else:
            self.model = YOLO(str(weights_path))

        # Build COCO class name list compatible with pipeline's string comparisons
        self.COCO_INSTANCE_CATEGORY_NAMES = list(self.model.names.values())

        print(f"[yolo_seg] Model loaded (coreml={'yes' if self._use_coreml else 'no'})")

    @staticmethod
    def _raise_if_lfs_pointer(weights_path: Path) -> None:
        """Fail fast when the bundled model file is still a Git LFS pointer."""
        try:
            with open(weights_path, "rb") as handle:
                prefix = handle.read(256)
        except OSError:
            return
        if prefix.startswith(b"version https://git-lfs.github.com/spec/v1"):
            raise RuntimeError(
                f"YOLO weights at {weights_path} are a Git LFS pointer, not the real model file.\n"
                "Please download the actual model asset or run Git LFS pull."
            )

    def get_prediction(self, image_data, threshold=0.40, mask_threshold=0.5):
        """Get predictions from the model.

        Args:
            image_data: Input image array (RGB).
            threshold: Detection confidence threshold (0.1-0.99).
            mask_threshold: Pixel confidence threshold for mask segmentation (0.5-0.95).

        Returns:
            (masks, pred_boxes, pred_class, pred_score) or
            (None, None, None, None) if no detections or
            ([], [], [], []) on error.
        """
        mask_threshold = max(0.5, min(0.95, float(mask_threshold)))
        orig_h, orig_w = image_data.shape[:2]

        for attempt in range(3):
            try:
                results = self.model.predict(
                    image_data, conf=threshold, verbose=False
                )
                r = results[0]

                if r.boxes is None or len(r.boxes) == 0:
                    return None, None, None, None

                if r.masks is None or len(r.masks) == 0:
                    return None, None, None, None

                # Masks are at model resolution, resize to original image size
                masks_raw = r.masks.data.cpu().numpy().astype(np.float32)
                masks = np.stack([
                    cv2.resize(m, (orig_w, orig_h), interpolation=cv2.INTER_LINEAR)
                    > mask_threshold
                    for m in masks_raw
                ])

                # Boxes are already in original image coordinates
                boxes_xyxy = r.boxes.xyxy.cpu().numpy()
                pred_boxes = [
                    [(float(b[0]), float(b[1])), (float(b[2]), float(b[3]))]
                    for b in boxes_xyxy
                ]

                cls_ids = r.boxes.cls.cpu().numpy().astype(int)
                pred_class = [self.model.names[c] for c in cls_ids]
                pred_score = r.boxes.conf.cpu().numpy().tolist()

                return self.filter_overlapping_detections(
                    masks, pred_boxes, pred_class, pred_score
                )
            except Exception as e:
                if attempt < 2:
                    if self._use_coreml:
                        print(f"[yolo_seg] CoreML inference failed: {e}. Falling back to PyTorch CPU.")
                        from ultralytics import YOLO
                        self.model = YOLO(str(YOLO_SEG_WEIGHTS_PATH))
                        self._use_coreml = False
                    else:
                        print(f"Prediction attempt {attempt + 1} failed: {e}. Retrying...")
                    time.sleep(0.1)
                else:
                    print("Error occurred while getting prediction after 3 attempts:", e)
        return [], [], [], []

    @staticmethod
    def _center_of_mass(mask):
        y, x = np.where(mask > 0)
        return (int(np.mean(x)), int(np.mean(y)))

    @staticmethod
    def _fsolve(func, xmin, xmax):
        x_min, x_max = xmin, xmax
        while x_max - x_min > 10:
            x_mid = (x_min + x_max) / 2
            if func(x_mid) < 0:
                x_min = x_mid
            else:
                x_max = x_mid
        return (x_min + x_max) / 2

    def _get_bounding_box(self, mask):
        center = self._center_of_mass(mask)

        def fraction_inside(center_of_mass, S):
            x_min = int(center_of_mass[0] - S / 2)
            x_max = int(center_of_mass[0] + S / 2)
            y_min = int(center_of_mass[1] - S / 2)
            y_max = int(center_of_mass[1] + S / 2)
            x_min2 = max(0, x_min)
            x_max2 = min(mask.shape[1], x_max)
            y_min2 = max(0, y_min)
            y_max2 = min(mask.shape[0], y_max)
            return np.sum(mask[y_min2:y_max2, x_min2:x_max2]) / np.sum(mask)

        S = self._fsolve(lambda S: fraction_inside(center, S) - 0.8, 10, 3000)
        S = int(S * 1 / 0.5)
        x_min = int(center[0] - S / 2)
        x_max = int(center[0] + S / 2)
        y_min = int(center[1] - S / 2)
        y_max = int(center[1] + S / 2)
        x_min = max(0, x_min)
        x_max = min(mask.shape[1], x_max)
        y_min = max(0, y_min)
        y_max = min(mask.shape[0], y_max)
        slx = x_max - x_min
        sly = y_max - y_min
        if slx > sly:
            center = (int((x_min + x_max) / 2), int((y_min + y_max) / 2))
            s_new = sly
        else:
            center = (int((x_min + x_max) / 2), int((y_min + y_max) / 2))
            s_new = slx
        x_min = int(center[0] - s_new / 2)
        x_max = int(center[0] + s_new / 2)
        y_min = int(center[1] - s_new / 2)
        y_max = int(center[1] + s_new / 2)
        return x_min, x_max, y_min, y_max

    @staticmethod
    def filter_overlapping_detections(masks, pred_boxes, pred_class, pred_score, iou_threshold=0.5):
        """Remove lower-confidence detections that overlap significantly with higher-confidence ones."""
        if masks is None or len(masks) == 0:
            return masks, pred_boxes, pred_class, pred_score

        n = len(pred_score)
        keep = [True] * n
        sorted_indices = sorted(range(n), key=lambda i: pred_score[i], reverse=True)

        for i_idx, i in enumerate(sorted_indices):
            if not keep[i]:
                continue
            for j in sorted_indices[i_idx + 1:]:
                if not keep[j]:
                    continue
                intersection = np.logical_and(masks[i], masks[j]).sum()
                union = np.logical_or(masks[i], masks[j]).sum()
                if union > 0 and intersection / union > iou_threshold:
                    keep[j] = False

        indices = [i for i in range(n) if keep[i]]
        if not indices:
            return masks, pred_boxes, pred_class, pred_score

        return (
            masks[indices],
            [pred_boxes[i] for i in indices],
            [pred_class[i] for i in indices],
            [pred_score[i] for i in indices],
        )

    def get_square_crop(self, mask, img, resize=True):
        x_min, x_max, y_min, y_max = self._get_bounding_box(mask)
        crop = img[y_min:y_max, x_min:x_max]
        mask_crop = mask[y_min:y_max, x_min:x_max]
        if resize:
            crop = cv2.resize(crop, (1024, 1024))
            mask_crop = cv2.resize(mask_crop.astype(np.uint8), (1024, 1024))
        return crop, mask_crop

    @staticmethod
    def get_species_crop(box, img):
        xmin = int(box[0][0])
        ymin = int(box[0][1])
        xmax = int(box[1][0])
        ymax = int(box[1][1])
        return img[ymin:ymax, xmin:xmax]
