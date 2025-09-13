"""GUI version of analyze_directory.

Features:
 - Select folder with images (RAW or fallback JPEG/PNG)
 - Optional GPU (DirectML) for ONNX bird species classifier
 - Progress bar with processed / total
 - Live display of current export image and quality crop
 - Display of species, confidence, quality score, rating, scene count, similarity metrics
 - Pause / Resume processing

This reproduces the core pipeline logic of analyze_directory without the CLI prompts.
Future improvement: refactor shared logic into a common module to avoid duplication.
"""

import os
import sys
import threading
import time
import gc
import json
from datetime import datetime
from typing import Optional, Dict

import numpy as np
import pandas as pd
import cv2
import onnxruntime as ort
import tensorflow as tf
import torch
import torchvision
import torchvision.transforms as T
from wand.image import Image as WandImage

from PyQt5.QtCore import Qt, pyqtSignal, QThread
from PyQt5.QtGui import QImage, QPixmap
from PyQt5.QtWidgets import (
    QApplication, QWidget, QPushButton, QLabel, QVBoxLayout, QHBoxLayout,
    QFileDialog, QProgressBar, QCheckBox, QMessageBox, QGroupBox, QGridLayout,
    QSizePolicy
)

# -------------------- Constants -------------------- #
SPECIESCLASSIFIER_PATH = "models/model.onnx"
SPECIESCLASSIFIER_LABELS = "models/labels.txt"
QUALITYCLASSIFIER_PATH = "models/quality.keras"

WILDLIFE_CATEGORIES = ['cat', 'dog', 'horse', 'sheep', 'cow', 'elephant', 'bear', 'zebra', 'giraffe', 'bird']

RAW_EXTENSIONS = [".cr2", ".cr3", ".nef", ".arw", ".dng", ".orf", ".raf", ".rw2", ".pef", ".sr2", ".x3f"]
JPEG_EXTENSIONS = [".jpg", ".jpeg", ".png"]

VERSION = "1.2.0"

# -------------------- Core CV / ML Components (Copied & Adapted) -------------------- #

class MaskRCNNWrapper:
    def __init__(self):
        self.COCO_INSTANCE_CATEGORY_NAMES = [
            '__background__', 'person', 'bicycle', 'car', 'motorcycle', 'airplane', 'bus',
            'train', 'truck', 'boat', 'traffic light', 'fire hydrant', 'N/A', 'stop sign',
            'parking meter', 'bench', 'bird', 'cat', 'dog', 'horse', 'sheep', 'cow',
            'elephant', 'bear', 'zebra', 'giraffe', 'N/A', 'backpack', 'umbrella', 'N/A', 'N/A',
            'handbag', 'tie', 'suitcase', 'frisbee', 'skis', 'snowboard', 'sports ball',
            'kite', 'baseball bat', 'baseball glove', 'skateboard', 'surfboard', 'tennis racket',
            'bottle', 'N/A', 'wine glass', 'cup', 'fork', 'knife', 'spoon', 'bowl',
            'banana', 'apple', 'sandwich', 'orange', 'broccoli', 'carrot', 'hot dog', 'pizza',
            'donut', 'cake', 'chair', 'couch', 'potted plant', 'bed', 'N/A', 'dining table',
            'N/A', 'N/A', 'toilet', 'N/A', 'tv', 'laptop', 'mouse', 'remote', 'keyboard', 'cell phone',
            'microwave', 'oven', 'toaster', 'sink', 'refrigerator', 'N/A', 'book',
            'clock', 'vase', 'scissors', 'teddy bear', 'hair drier', 'toothbrush'
        ]
        self.model = torchvision.models.detection.maskrcnn_resnet50_fpn_v2(
            weights=torchvision.models.detection.MaskRCNN_ResNet50_FPN_V2_Weights.DEFAULT
        )
        self.model.eval()

    def get_prediction(self, image_data, threshold=0.5):
        # Retry prediction up to 3 times in case of transient runtime errors.
        for attempt in range(3):
            try:
                transform = T.Compose([T.ToTensor()])
                img = transform(image_data)
                # Use no_grad to avoid building autograd graph and reduce memory footprint.
                with torch.no_grad():
                    pred = self.model([img])
                pred_score = list(pred[0]['scores'].detach().numpy())
                if (np.array(pred_score) > threshold).sum() == 0:
                    return None, None, None, None
                pred_t = [pred_score.index(x) for x in pred_score if x > threshold][-1]
                masks = (pred[0]['masks'] > 0.5).squeeze().detach().cpu().numpy()
                if len(masks.shape) == 2:
                    masks = np.expand_dims(masks, axis=0)
                pred_class = [self.COCO_INSTANCE_CATEGORY_NAMES[i] for i in list(pred[0]['labels'].numpy())]
                pred_boxes = [[(i[0], i[1]), (i[2], i[3])] for i in list(pred[0]['boxes'].detach().numpy())]
                masks = masks[:pred_t + 1]
                pred_boxes = pred_boxes[:pred_t + 1]
                pred_class = pred_class[:pred_t + 1]
                return masks, pred_boxes, pred_class, pred_score[:pred_t + 1]
            except Exception as e:
                if attempt < 2:
                    print(f"Prediction attempt {attempt + 1} failed: {e}. Retrying...")
                    time.sleep(0.1)
                else:
                    print("Error occurred while getting prediction after 3 attempts:", e)
        return [], [], [], []  # Final failure after retries

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
        SLX = x_max - x_min
        SLY = y_max - y_min
        if SLX > SLY:
            center = (int((x_min + x_max) / 2), int((y_min + y_max) / 2))
            S_new = SLY
        else:
            center = (int((x_min + x_max) / 2), int((y_min + y_max) / 2))
            S_new = SLX
        x_min = int(center[0] - S_new / 2)
        x_max = int(center[0] + S_new / 2)
        y_min = int(center[1] - S_new / 2)
        y_max = int(center[1] + S_new / 2)
        return x_min, x_max, y_min, y_max

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
        xmin = int(box[0][0]); ymin = int(box[0][1]); xmax = int(box[1][0]); ymax = int(box[1][1])
        return img[ymin:ymax, xmin:xmax]


class BirdSpeciesClassifier:
    def __init__(self, model_path: str, labels_path: str, use_gpu: bool):
        """Initialize ONNX session, load labels and build vectorized family aggregation structures.

        Precomputes a family indicator matrix so family probabilities can be obtained via
        a single matrix multiplication: family_probs = family_matrix @ species_probs.
        """
        with open(labels_path, 'r') as f:
            self.labels = np.array([l.strip() for l in f.readlines()])  # (num_species,)
        providers = ['DmlExecutionProvider'] if use_gpu else ['CPUExecutionProvider']
        self.session = ort.InferenceSession(model_path, providers=providers)

        # ---------------- Family / Display Name Mappings (Precomputed) ---------------- #
        try:
            df_sf = pd.read_csv('models/labels_scispecies.csv')  # columns: Species, Scientific Family
            df_disp = pd.read_csv('models/scispecies_dispname.csv')  # columns: Scientific Family, Display Name
        except Exception as e:
            print(f"Failed to load family mapping CSVs: {e}")
            # Fallback: empty structures
            self.family_matrix = np.zeros((0, len(self.labels)), dtype=np.float32)
            self.family_display_names = []
            return

        species_to_family = dict(zip(df_sf['Species'], df_sf['Scientific Family']))
        family_to_display = dict(zip(df_disp['Scientific Family'], df_disp['Display Name']))

        # Build array of display family names aligned with self.labels order.
        display_families = []
        unknown_family_name = 'Unknown Family'
        for sp in self.labels:
            fam = species_to_family.get(sp)
            if fam is None:
                display_families.append(unknown_family_name)
            else:
                display_families.append(family_to_display.get(fam, fam))
        display_families = np.array(display_families)

        # Unique display family names (stable order of first occurrence)
        _, unique_indices = np.unique(display_families, return_index=True)
        ordered_unique_fams = display_families[np.sort(unique_indices)]
        self.family_display_names = ordered_unique_fams.tolist()

        # Vectorized indicator matrix construction
        fam_index_map = {fam: i for i, fam in enumerate(self.family_display_names)}
        fam_indices = np.array([fam_index_map[f] for f in display_families])  # shape (num_species,)
        num_fams = len(self.family_display_names)
        num_species = len(self.labels)
        family_matrix = np.zeros((num_fams, num_species), dtype=np.float32)
        # Advanced indexing to set 1 where species belongs to family
        family_matrix[fam_indices, np.arange(num_species)] = 1.0
        self.family_matrix = family_matrix  # shape (num_fams, num_species)
        # Store for later reference if needed
        self._species_family_display = display_families

    @staticmethod
    def _preprocess(image):
        image = cv2.resize(image, dsize=(300, 300)).astype(np.float32)
        image = np.transpose(image, (2, 0, 1))  # CHW
        return np.expand_dims(image, 0)

    def classify(self, image, top_k=5):
        """Run inference and return top-k species and family probabilities.

        Returns dict with:
          top_species_labels, top_species_scores, top_family_labels, top_family_scores
        """
        input_tensor = self._preprocess(image)
        input_name = self.session.get_inputs()[0].name
        outputs = self.session.run(None, {input_name: input_tensor})
        logits = outputs[0][0]  # raw probabilities/logits already (assumed calibrated)

        # Top species
        top_species_indices = np.argsort(logits)[-top_k:][::-1]
        top_species_labels = self.labels[top_species_indices]
        top_species_scores = logits[top_species_indices].astype(float)

        # Vectorized family aggregation (matrix multiplication)
        if self.family_matrix.shape[0] > 0:
            family_probs = self.family_matrix @ logits  # shape (num_families,)
            top_family_indices = np.argsort(family_probs)[-top_k:][::-1]
            top_family_labels = [self.family_display_names[i] for i in top_family_indices]
            top_family_scores = family_probs[top_family_indices].astype(float).tolist()
        else:
            top_family_labels, top_family_scores = [], []

        return {
            'top_species_labels': top_species_labels,
            'top_species_scores': top_species_scores,
            'top_family_labels': top_family_labels,
            'top_family_scores': top_family_scores
        }


class QualityClassifier:
    def __init__(self, model_path: str):
        self.model = tf.keras.models.load_model(model_path)

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
                return float(output_value[0][0])
            except Exception:
                time.sleep(0.05)
        return -1.0


# -------------------- Utility Functions -------------------- #

def read_image(path: str):
    try:
        with WandImage(filename=path) as img:
            if img.orientation == 'left_bottom':
                img.rotate(270)
            elif img.orientation == 'right_bottom':
                img.rotate(90)
            elif img.orientation == 'bottom':
                img.rotate(180)
            return np.array(img)
    except Exception:
        return None


def compute_image_similarity_akaze(img1, img2, max_dim=1600):
    if img1 is None or img2 is None or img1.shape != img2.shape:
        return {'feature_similarity': -1, 'feature_confidence': -1, 'color_similarity': -1,
                'color_confidence': -1, 'similar': False, 'confidence': 0}
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
            kp1 = list(kp1); des1 = np.array(des1)
        if des2 is not None and len(kp2) > 300:
            kp2, des2 = zip(*sorted(zip(kp2, des2), key=lambda x: x[0].response, reverse=True)[:300])
            kp2 = list(kp2); des2 = np.array(des2)
        feature_confidence = min(len(kp1), len(kp2)) / 300 if kp1 and kp2 else 0
        if feature_confidence < 0.25 or des1 is None or des2 is None or len(kp1) == 0 or len(kp2) == 0:
            mean1 = np.mean(img1.reshape(-1, img1.shape[-1]), axis=0)
            mean2 = np.mean(img2.reshape(-1, img2.shape[-1]), axis=0)
            color_diff = np.sum(np.abs(mean1 - mean2))
            return {
                'feature_similarity': 0,
                'feature_confidence': 0,
                'color_similarity': float(color_diff),
                'color_confidence': float(abs((768 - color_diff) / 768) if color_diff <= 150 else abs(color_diff / 768)),
                'similar': bool(color_diff <= 150),
                'confidence': float(abs((768 - color_diff) / 768) if color_diff <= 150 else abs(color_diff / 768))
            }
        bf = cv2.BFMatcher(cv2.NORM_HAMMING)
        matches = bf.knnMatch(des1, des2, k=2)
        m_arr = np.array([m.distance for m, n in matches])
        n_arr = np.array([n.distance for m, n in matches])
        good_mask = m_arr < 0.7 * n_arr
        feature_similarity = np.sum(good_mask) / ((len(kp1) + len(kp2)) / 2) if (len(kp1) + len(kp2)) > 0 else 0
        similar = feature_similarity >= 0.05
        return {
            'feature_similarity': float(feature_similarity),
            'feature_confidence': float(feature_confidence),
            'color_similarity': 0,
            'color_confidence': 0,
            'similar': bool(similar),
            'confidence': float(feature_confidence)
        }
    except Exception:
        return {'feature_similarity': -1, 'feature_confidence': -1, 'color_similarity': -1,
                'color_confidence': -1, 'similar': False, 'confidence': 0}


def quality_to_rating(q: float) -> int:
    if q == -1:
        return 0
    if q < 0.15:
        return 1
    if q < 0.3:
        return 2
    if q < 0.6:
        return 3
    if q < 0.9:
        return 4
    return 5


def numpy_to_qimage(img: np.ndarray) -> Optional[QImage]:
    if img is None:
        return None
    if img.ndim == 2:
        h, w = img.shape
        qimg = QImage(img.data, w, h, w, QImage.Format_Grayscale8)
        return qimg.copy()
    if img.ndim == 3:
        h, w, c = img.shape
        if c == 3:
            bytes_per_line = 3 * w
            qimg = QImage(img.data, w, h, bytes_per_line, QImage.Format_RGB888)
            return qimg.copy()
    return None


def load_qimage_from_path(path: str) -> Optional[QImage]:
    """Load a QImage directly from a saved file path (export/crop)."""
    if not path or not os.path.exists(path):
        return None
    qimg = QImage(path)
    return qimg if not qimg.isNull() else None


# -------------------- Worker Thread -------------------- #

class ProcessingWorker(QThread):
    progress = pyqtSignal(int, int)  # processed, total
    image_processed = pyqtSignal(dict, QImage, QImage)  # entry, export_img, crop_img
    status = pyqtSignal(str)
    finished = pyqtSignal()

    def __init__(self, folder: str, use_gpu: bool, parent=None):
        super().__init__(parent)
        self.folder = folder
        self.use_gpu = use_gpu
        self._pause_event = threading.Event()
        self._pause_event.set()  # initially running
        self._stop_flag = False
        self.database_name = "kestrel_database.csv"
        self.kestrel_dir = os.path.join(self.folder, ".kestrel")
        self.export_dir = os.path.join(self.kestrel_dir, "export")
        self.crop_dir = os.path.join(self.kestrel_dir, "crop")
        os.makedirs(self.export_dir, exist_ok=True)
        os.makedirs(self.crop_dir, exist_ok=True)

    def pause(self):
        self._pause_event.clear()

    def resume(self):
        self._pause_event.set()

    def run(self):
        try:
            files = [f for f in os.listdir(self.folder) if os.path.isfile(os.path.join(self.folder, f)) and os.path.splitext(f)[1].lower() in RAW_EXTENSIONS]
            if not files:
                files = [f for f in os.listdir(self.folder) if os.path.isfile(os.path.join(self.folder, f)) and os.path.splitext(f)[1].lower() in JPEG_EXTENSIONS]
            files.sort()
            total = len(files)
            if total == 0:
                self.status.emit("No supported image files found.")
                self.finished.emit()
                return

            db_path = os.path.join(self.kestrel_dir, self.database_name)
            if os.path.exists(db_path):
                database = pd.read_csv(db_path)
            else:
                # Initialize fresh database
                database = pd.DataFrame(columns=[
                    "filename", "species", "species_confidence", "family", "family_confidence", "quality", "export_path", "crop_path", "rating",
                    "scene_count", "feature_similarity", "feature_confidence", "color_similarity", "color_confidence", "similar",
                    "secondary_species_list", "secondary_species_scores", "secondary_family_list", "secondary_family_scores"
                ])
                # Write metadata file once on creation
                metadata_path = os.path.join(self.kestrel_dir, "kestrel_metadata.json")
                try:
                    if not os.path.exists(metadata_path):
                        metadata = {
                            "version": VERSION,
                            "analyzer": "gui",
                            "created_utc": datetime.utcnow().isoformat() + "Z",
                            "database_file": self.database_name
                        }
                        with open(metadata_path, 'w', encoding='utf-8') as mf:
                            json.dump(metadata, mf, indent=2)
                except Exception as e:
                    print(f"Warning: failed to write metadata file: {e}")

            # Ensure any newly added columns exist (backwards compatibility with older DB)
            required_columns = [
                "family", "family_confidence", "secondary_family_list", "secondary_family_scores"
            ]
            for col in required_columns:
                if col not in database.columns:
                    if col.endswith('_list'):
                        database[col] = [[] for _ in range(len(database))]
                    elif col.endswith('_scores'):
                        database[col] = [[] for _ in range(len(database))]
                    else:
                        database[col] = "Unknown" if 'family' in col else 0.0

            processed_set = set(database['filename'].values)
            new_files = [f for f in files if f not in processed_set]
            if not new_files:
                self.status.emit("No new files to process.")
                self.finished.emit()
                return
            total = len(new_files)

            self.status.emit("Loading models... This may take a while on first run.")
            mask_rcnn = MaskRCNNWrapper()
            species_clf = BirdSpeciesClassifier(SPECIESCLASSIFIER_PATH, SPECIESCLASSIFIER_LABELS, self.use_gpu)
            quality_clf = QualityClassifier(QUALITYCLASSIFIER_PATH)
            self.status.emit("Models loaded. Processing started.")

            # Set previous_image to last processed image if available and exists
            previous_image = None
            if not database.empty:
                last_row = database.iloc[-1]
                last_filename = last_row["filename"]
                last_image_path = os.path.join(self.folder, last_filename)
                if os.path.exists(last_image_path):
                    img = read_image(last_image_path)
                    if img is not None:
                        previous_image = img
            scene_count = database['scene_count'].max() if not database.empty else 0

            for idx, raw_file in enumerate(new_files, start=1):
                self._pause_event.wait()

                # Base entry for this file
                entry = {
                    "filename": raw_file,
                    "species": "Unknown",
                    "species_confidence": 0.0,
                    "family": "Unknown",
                    "family_confidence": 0.0,
                    "quality": -1.0,
                    "export_path": "N/A",
                    "crop_path": "N/A",
                    "scene_count": scene_count,
                    "rating": 0,
                    "feature_similarity": -1.0,
                    "feature_confidence": -1.0,
                    "color_similarity": -1.0,
                    "color_confidence": -1.0,
                    "similar": False,
                    "secondary_species_list": [],
                    "secondary_species_scores": [],
                    "secondary_family_list": [],
                    "secondary_family_scores": []
                }

                try:
                    image_path = os.path.join(self.folder, raw_file)
                    img = read_image(image_path)
                    if img is None:
                        raise RuntimeError("Image read returned None")

                    similarity = compute_image_similarity_akaze(previous_image, img)
                    if not similarity['similar']:
                        scene_count += 1
                    entry.update({
                        "feature_similarity": similarity['feature_similarity'],
                        "feature_confidence": similarity['feature_confidence'],
                        "color_similarity": similarity['color_similarity'],
                        "color_confidence": similarity['color_confidence'],
                        "scene_count": scene_count,
                        "similar": similarity['similar']
                    })
                    previous_image = img.copy()

                    # Save img early to reduce memory later
                    export_path = os.path.join(self.export_dir, f"{os.path.splitext(raw_file)[0]}_export.jpg")
                    img_small = cv2.resize(img, (1200, int(1200 * img.shape[0] / img.shape[1])))
                    cv2.imwrite(export_path, cv2.cvtColor(img_small, cv2.COLOR_RGB2BGR), [cv2.IMWRITE_JPEG_QUALITY, 70])
                    entry.update({"export_path": export_path})

                    masks, pred_boxes, pred_class, pred_score = mask_rcnn.get_prediction(img)
                    if masks is None:
                        # No detections: still export a downsized copy
                        self.status.emit(f"No detections in {raw_file}")
                        crop_path = os.path.join(self.crop_dir, f"{os.path.splitext(raw_file)[0]}_crop.jpg")
                        cv2.imwrite(crop_path, cv2.cvtColor(img_small, cv2.COLOR_RGB2BGR), [cv2.IMWRITE_JPEG_QUALITY, 85])
                        entry.update({"crop_path": crop_path})
                        # Persist and mark success
                        database = pd.concat([database, pd.DataFrame([entry])], ignore_index=True)
                        database.to_csv(db_path, index=False)
                        # Emit using file paths
                        export_q = load_qimage_from_path(export_path)
                        crop_q = load_qimage_from_path(crop_path)
                        self.image_processed.emit(entry, export_q, crop_q)
                        

                    wildlife_indices = [i for i, c in enumerate(pred_class) if c in WILDLIFE_CATEGORIES]
                    bird_indices = [i for i, c in enumerate(pred_class) if c == 'bird']
                    bird_indices = sorted(bird_indices, key=lambda i: pred_score[i], reverse=True)[:5]

                    def process_nonbird(primary_mask_i):
                        quality_crop, quality_mask = mask_rcnn.get_square_crop(masks[primary_mask_i], img, resize=True)
                        quality_score = quality_clf.classify(quality_crop, quality_mask)
                        return {
                            "species": pred_class[primary_mask_i],
                            "species_confidence": float(pred_score[primary_mask_i]),
                            "family": "N/A",
                            "family_confidence": 0.0,
                            "quality": quality_score,
                            "rating": quality_to_rating(quality_score),
                            "quality_crop": quality_crop
                        }

                    def process_bird(i):
                        if pred_class[i] == 'bird':
                            species_crop = mask_rcnn.get_species_crop(pred_boxes[i], img)
                            species_result = species_clf.classify(species_crop)
                            species_label = species_result['top_species_labels'][0] if len(species_result['top_species_labels']) else 'Unknown'
                            species_confidence = float(species_result['top_species_scores'][0]) if len(species_result['top_species_scores']) else 0.0
                            family_label = species_result['top_family_labels'][0] if len(species_result['top_family_labels']) else 'Unknown'
                            family_confidence = float(species_result['top_family_scores'][0]) if len(species_result['top_family_scores']) else 0.0
                        else:
                            species_label = pred_class[i]
                            species_confidence = float(pred_score[i])
                            family_label = "N/A"
                            family_confidence = 0.0
                        quality_crop, quality_mask = mask_rcnn.get_square_crop(masks[i], img, resize=True)
                        quality_score = quality_clf.classify(quality_crop, quality_mask)
                        return {
                            "species": species_label,
                            "species_confidence": species_confidence,
                            "family": family_label,
                            "family_confidence": family_confidence,
                            "quality": quality_score,
                            "rating": quality_to_rating(quality_score),
                            "quality_crop": quality_crop
                        }

                    if bird_indices:
                        bird_data = [process_bird(i) for i in bird_indices]
                        primary_bird = max(bird_data, key=lambda x: x['quality'])
                        entry.update({
                            "species": primary_bird['species'],
                            "species_confidence": primary_bird['species_confidence'],
                            "family": primary_bird['family'],
                            "family_confidence": primary_bird['family_confidence'],
                            "quality": primary_bird['quality'],
                            "rating": primary_bird['rating']
                        })
                        all_species = np.array([b['species'] for b in bird_data])
                        all_species_conf = np.array([b['species_confidence'] for b in bird_data])
                        all_families = np.array([b['family'] for b in bird_data])
                        all_family_conf = np.array([b['family_confidence'] for b in bird_data])
                        entry.update({
                            "secondary_species_list": all_species,
                            "secondary_species_scores": all_species_conf,
                            "secondary_family_list": all_families,
                            "secondary_family_scores": all_family_conf
                        })
                        crop_img = primary_bird['quality_crop']
                    else:
                        if wildlife_indices:
                            primary_index = wildlife_indices[np.argmax([pred_score[i] for i in wildlife_indices])]
                            result = process_nonbird(primary_index)
                            entry.update({
                                "species": result['species'],
                                "species_confidence": result['species_confidence'],
                                "family": result['family'],
                                "family_confidence": result['family_confidence'],
                                "quality": result['quality'],
                                "rating": result['rating']
                            })
                            crop_img = result['quality_crop']
                        else:
                            crop_img = img_small

                    crop_path = os.path.join(self.crop_dir, f"{os.path.splitext(raw_file)[0]}_crop.jpg")
                    cv2.imwrite(crop_path, cv2.cvtColor(crop_img, cv2.COLOR_RGB2BGR), [cv2.IMWRITE_JPEG_QUALITY, 85])
                    entry.update({"crop_path": crop_path})

                    database = pd.concat([database, pd.DataFrame([entry])], ignore_index=True)
                    database.to_csv(db_path, index=False)

                    export_q = load_qimage_from_path(export_path)
                    crop_q = load_qimage_from_path(crop_path)

                    masks, pred_boxes, pred_class, pred_score = None, None, None, None # Free memory
                    crop_img = None
                    img_small = None
                    bird_data = None
                    result = None
                    # Nothing else to free before next maskRCNN call...
                    
                    self.image_processed.emit(entry, export_q, crop_q)
                    self.status.emit(
                        f"Processed {raw_file}: {entry['species']} Q={entry['quality']:.3f} R={entry['rating']} ({idx}/{total})"
                    )
                except Exception as e:  # catch per-attempt failures
                    self.status.emit(f"Error {raw_file}: {e}")
                    print(f"Error {raw_file}: {e}")
                    entry['scene_count'] = scene_count
                    entry['species'] = 'Error'
                    entry['similar'] = False
                    # save current state to database.
                    database = pd.concat([database, pd.DataFrame([entry])], ignore_index=True)
                    database.to_csv(db_path, index=False)
                    time.sleep(2)

                # Progress always emitted
                self.progress.emit(idx, total)

            self.finished.emit()
        except Exception as e:
            self.status.emit(f"Fatal error: {e}")
            print(f"Fatal error: {e}")
            #self.finished.emit() # Finish will mask the error.


# -------------------- Main Window -------------------- #

class KestrelGUI(QWidget):
    def __init__(self):
        super().__init__()
        self.setWindowTitle("Kestrel Analyzer")
        self.setMinimumSize(1100, 700)

        self.folder: Optional[str] = None
        self.worker: Optional[ProcessingWorker] = None

        self._build_ui()

    def _build_ui(self):
        main_layout = QVBoxLayout()

        control_box = QGroupBox("Controls")
        control_layout = QHBoxLayout()
        self.btn_select = QPushButton("Select Folder")
        self.btn_start = QPushButton("Start")
        self.btn_pause = QPushButton("Pause")
        self.btn_resume = QPushButton("Resume")
        self.btn_pause.setEnabled(False)
        self.btn_resume.setEnabled(False)
        self.chk_gpu = QCheckBox("Use GPU (DirectML) for ONNX")
        self.chk_gpu.setChecked(True)
        control_layout.addWidget(self.btn_select)
        control_layout.addWidget(self.btn_start)
        control_layout.addWidget(self.btn_pause)
        control_layout.addWidget(self.btn_resume)
        control_layout.addWidget(self.chk_gpu)
        control_layout.addStretch(1)
        control_box.setLayout(control_layout)

        self.progress = QProgressBar()
        self.lbl_status = QLabel("Idle")
        self.lbl_status.setWordWrap(True)

        image_box = QGroupBox("Latest Images")
        img_layout = QHBoxLayout()
        self.lbl_export = QLabel("Export Image")
        self.lbl_crop = QLabel("Crop Image")
        for lbl in (self.lbl_export, self.lbl_crop):
            lbl.setAlignment(Qt.AlignCenter)
            lbl.setSizePolicy(QSizePolicy.Expanding, QSizePolicy.Expanding)
        img_layout.addWidget(self.lbl_export)
        img_layout.addWidget(self.lbl_crop)
        image_box.setLayout(img_layout)

        info_box = QGroupBox("Current Detection")
        grid = QGridLayout()
        self.info_labels: Dict[str, QLabel] = {}
        fields = [
            "filename",
            "species",
            "species_confidence",
            "family",
            "family_confidence",
            "quality",
            "rating",
            "scene_count",
            "feature_similarity",
            "feature_confidence",
            "color_similarity",
            "color_confidence",
            "similar",
            "secondary_species_list",
            "secondary_species_scores",
            "secondary_family_list",
            "secondary_family_scores"
        ]
        for row, field in enumerate(fields):
            grid.addWidget(QLabel(field.replace('_', ' ').title() + ':'), row, 0)
            val_label = QLabel('-')
            val_label.setTextInteractionFlags(Qt.TextSelectableByMouse)
            grid.addWidget(val_label, row, 1)
            self.info_labels[field] = val_label
        info_box.setLayout(grid)

        main_layout.addWidget(control_box)
        main_layout.addWidget(self.progress)
        main_layout.addWidget(self.lbl_status)
        main_layout.addWidget(image_box, stretch=2)
        main_layout.addWidget(info_box, stretch=1)
        self.setLayout(main_layout)

        self.btn_select.clicked.connect(self.select_folder)
        self.btn_start.clicked.connect(self.start_processing)
        self.btn_pause.clicked.connect(self.pause_processing)
        self.btn_resume.clicked.connect(self.resume_processing)

    def select_folder(self):
        folder = QFileDialog.getExistingDirectory(self, "Select Image Folder")
        if folder:
            self.folder = folder
            self.lbl_status.setText(f"Selected folder: {folder}")

    def start_processing(self):
        if not self.folder:
            QMessageBox.warning(self, "No Folder", "Please select a folder first.")
            return
        if self.worker and self.worker.isRunning():
            QMessageBox.information(self, "Running", "Processing already in progress.")
            return
        use_gpu = self.chk_gpu.isChecked()
        self.worker = ProcessingWorker(self.folder, use_gpu)
        self.worker.progress.connect(self.on_progress)
        self.worker.image_processed.connect(self.on_image_processed)
        self.worker.status.connect(self.on_status)
        self.worker.finished.connect(self.on_finished)
        self.progress.setValue(0)
        self.lbl_status.setText("Initializing...")
        self.btn_start.setEnabled(False)
        self.btn_pause.setEnabled(True)
        self.worker.start()

    def pause_processing(self):
        if self.worker and self.worker.isRunning():
            self.worker.pause()
            self.lbl_status.setText("Paused")
            self.btn_pause.setEnabled(False)
            self.btn_resume.setEnabled(True)

    def resume_processing(self):
        if self.worker and self.worker.isRunning():
            self.worker.resume()
            self.lbl_status.setText("Resumed")
            self.btn_pause.setEnabled(True)
            self.btn_resume.setEnabled(False)

    def on_progress(self, processed: int, total: int):
        if self.progress.maximum() != total:
            self.progress.setMaximum(total)
        self.progress.setValue(processed)

    def on_image_processed(self, entry: dict, export_img: QImage, crop_img: QImage):
        if export_img:
            self.lbl_export.setPixmap(QPixmap.fromImage(export_img).scaled(
                self.lbl_export.size(), Qt.KeepAspectRatio, Qt.SmoothTransformation))
        if crop_img:
            self.lbl_crop.setPixmap(QPixmap.fromImage(crop_img).scaled(
                self.lbl_crop.size(), Qt.KeepAspectRatio, Qt.SmoothTransformation))
        for k, v in entry.items():
            if k in self.info_labels:
                if isinstance(v, float):
                    self.info_labels[k].setText(f"{v:.4f}")
                else:
                    self.info_labels[k].setText(str(v))

    def resizeEvent(self, event):
        if self.lbl_export.pixmap():
            self.lbl_export.setPixmap(self.lbl_export.pixmap().scaled(
                self.lbl_export.size(), Qt.KeepAspectRatio, Qt.SmoothTransformation))
        if self.lbl_crop.pixmap():
            self.lbl_crop.setPixmap(self.lbl_crop.pixmap().scaled(
                self.lbl_crop.size(), Qt.KeepAspectRatio, Qt.SmoothTransformation))
        super().resizeEvent(event)

    def on_status(self, msg: str):
        self.lbl_status.setText(msg)

    def on_finished(self):
        self.lbl_status.setText("Finished")
        self.btn_start.setEnabled(True)
        self.btn_pause.setEnabled(False)
        self.btn_resume.setEnabled(False)


def main():
    app = QApplication(sys.argv)
    win = KestrelGUI()
    win.show()
    sys.exit(app.exec_())


if __name__ == "__main__":
    main()
