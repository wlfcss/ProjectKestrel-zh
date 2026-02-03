import os
import time
from typing import Callable, Dict, Optional

import cv2
import numpy as np
import pandas as pd

from .config import (
    JPEG_EXTENSIONS,
    RAW_EXTENSIONS,
    SPECIESCLASSIFIER_LABELS,
    SPECIESCLASSIFIER_PATH,
    QUALITYCLASSIFIER_PATH,
    WILDLIFE_CATEGORIES,
    MODELS_DIR,
)
from .database import load_database, save_database
from .image_utils import read_image
from .ratings import quality_to_rating
from .similarity import compute_image_similarity_akaze
from .ml.mask_rcnn import MaskRCNNWrapper
from .ml.bird_species import BirdSpeciesClassifier
from .ml.quality import QualityClassifier


class AnalysisPipeline:
    def __init__(self, use_gpu: bool):
        self.use_gpu = use_gpu
        self.mask_rcnn: Optional[MaskRCNNWrapper] = None
        self.species_clf: Optional[BirdSpeciesClassifier] = None
        self.quality_clf: Optional[QualityClassifier] = None

    def load_models(self, status_cb: Optional[Callable[[str], None]] = None) -> None:
        if self.mask_rcnn and self.species_clf and self.quality_clf:
            return
        if status_cb:
            status_cb("Loading models... This may take a while on first run.")
        self.mask_rcnn = MaskRCNNWrapper()
        self.species_clf = BirdSpeciesClassifier(
            str(SPECIESCLASSIFIER_PATH),
            str(SPECIESCLASSIFIER_LABELS),
            self.use_gpu,
            models_dir=str(MODELS_DIR),
        )
        self.quality_clf = QualityClassifier(str(QUALITYCLASSIFIER_PATH))
        if status_cb:
            status_cb("Models loaded. Processing started.")

    def process_folder(
        self,
        folder: str,
        pause_event=None,
        callbacks: Optional[Dict[str, Callable]] = None,
        analyzer_name: str = "pipeline",
    ) -> None:
        callbacks = callbacks or {}
        status_cb = callbacks.get("on_status")
        progress_cb = callbacks.get("on_progress")
        image_cb = callbacks.get("on_image")
        error_cb = callbacks.get("on_error")

        try:
            files = [
                f
                for f in os.listdir(folder)
                if os.path.isfile(os.path.join(folder, f))
                and os.path.splitext(f)[1].lower() in RAW_EXTENSIONS
            ]
            if not files:
                files = [
                    f
                    for f in os.listdir(folder)
                    if os.path.isfile(os.path.join(folder, f))
                    and os.path.splitext(f)[1].lower() in JPEG_EXTENSIONS
                ]
            files.sort()
            if not files:
                if status_cb:
                    status_cb("No supported image files found.")
                return

            kestrel_dir = os.path.join(folder, ".kestrel")
            export_dir = os.path.join(kestrel_dir, "export")
            crop_dir = os.path.join(kestrel_dir, "crop")
            os.makedirs(export_dir, exist_ok=True)
            os.makedirs(crop_dir, exist_ok=True)

            database, db_path = load_database(kestrel_dir, analyzer_name)

            processed_set = set(database["filename"].values)
            new_files = [f for f in files if f not in processed_set]
            if not new_files:
                if status_cb:
                    status_cb("No new files to process.")
                return
            total = len(new_files)

            self.load_models(status_cb=status_cb)

            previous_image = None
            if not database.empty:
                last_row = database.iloc[-1]
                last_filename = last_row["filename"]
                last_image_path = os.path.join(folder, last_filename)
                if os.path.exists(last_image_path):
                    img = read_image(last_image_path)
                    if img is not None:
                        previous_image = img
            scene_count = database["scene_count"].max() if not database.empty else 0

            for idx, raw_file in enumerate(new_files, start=1):
                if pause_event is not None:
                    pause_event.wait()

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
                    "secondary_family_scores": [],
                }

                try:
                    image_path = os.path.join(folder, raw_file)
                    img = read_image(image_path)
                    if img is None:
                        raise RuntimeError("Image read returned None")

                    similarity = compute_image_similarity_akaze(previous_image, img)
                    if not similarity["similar"]:
                        scene_count += 1
                    entry.update(
                        {
                            "feature_similarity": similarity["feature_similarity"],
                            "feature_confidence": similarity["feature_confidence"],
                            "color_similarity": similarity["color_similarity"],
                            "color_confidence": similarity["color_confidence"],
                            "scene_count": scene_count,
                            "similar": similarity["similar"],
                        }
                    )
                    previous_image = img.copy()

                    export_path = os.path.join(export_dir, f"{os.path.splitext(raw_file)[0]}_export.jpg")
                    img_small = cv2.resize(img, (1200, int(1200 * img.shape[0] / img.shape[1])))
                    cv2.imwrite(
                        export_path,
                        cv2.cvtColor(img_small, cv2.COLOR_RGB2BGR),
                        [cv2.IMWRITE_JPEG_QUALITY, 70],
                    )
                    entry.update({"export_path": export_path})

                    masks, pred_boxes, pred_class, pred_score = self.mask_rcnn.get_prediction(img)
                    if masks is None:
                        if status_cb:
                            status_cb(f"No detections in {raw_file}")
                        crop_path = os.path.join(crop_dir, f"{os.path.splitext(raw_file)[0]}_crop.jpg")
                        cv2.imwrite(
                            crop_path,
                            cv2.cvtColor(img_small, cv2.COLOR_RGB2BGR),
                            [cv2.IMWRITE_JPEG_QUALITY, 85],
                        )
                        entry.update({"crop_path": crop_path})
                        database = pd.concat([database, pd.DataFrame([entry])], ignore_index=True)
                        save_database(database, db_path)
                        if image_cb:
                            image_cb(entry)
                        if progress_cb:
                            progress_cb(idx, total)
                        continue

                    wildlife_indices = [i for i, c in enumerate(pred_class) if c in WILDLIFE_CATEGORIES]
                    bird_indices = [i for i, c in enumerate(pred_class) if c == "bird"]
                    bird_indices = sorted(bird_indices, key=lambda i: pred_score[i], reverse=True)[:5]

                    def process_nonbird(primary_mask_i):
                        quality_crop, quality_mask = self.mask_rcnn.get_square_crop(
                            masks[primary_mask_i], img, resize=True
                        )
                        quality_score = self.quality_clf.classify(quality_crop, quality_mask)
                        return {
                            "species": pred_class[primary_mask_i],
                            "species_confidence": float(pred_score[primary_mask_i]),
                            "family": "N/A",
                            "family_confidence": 0.0,
                            "quality": quality_score,
                            "rating": quality_to_rating(quality_score),
                            "quality_crop": quality_crop,
                        }

                    def process_bird(i):
                        if pred_class[i] == "bird":
                            species_crop = self.mask_rcnn.get_species_crop(pred_boxes[i], img)
                            species_result = self.species_clf.classify(species_crop)
                            species_label = (
                                species_result["top_species_labels"][0]
                                if len(species_result["top_species_labels"])
                                else "Unknown"
                            )
                            species_confidence = (
                                float(species_result["top_species_scores"][0])
                                if len(species_result["top_species_scores"])
                                else 0.0
                            )
                            family_label = (
                                species_result["top_family_labels"][0]
                                if len(species_result["top_family_labels"])
                                else "Unknown"
                            )
                            family_confidence = (
                                float(species_result["top_family_scores"][0])
                                if len(species_result["top_family_scores"])
                                else 0.0
                            )
                        else:
                            species_label = pred_class[i]
                            species_confidence = float(pred_score[i])
                            family_label = "N/A"
                            family_confidence = 0.0
                        quality_crop, quality_mask = self.mask_rcnn.get_square_crop(masks[i], img, resize=True)
                        quality_score = self.quality_clf.classify(quality_crop, quality_mask)
                        return {
                            "species": species_label,
                            "species_confidence": species_confidence,
                            "family": family_label,
                            "family_confidence": family_confidence,
                            "quality": quality_score,
                            "rating": quality_to_rating(quality_score),
                            "quality_crop": quality_crop,
                        }

                    if bird_indices:
                        bird_data = [process_bird(i) for i in bird_indices]
                        primary_bird = max(bird_data, key=lambda x: x["quality"])
                        entry.update(
                            {
                                "species": primary_bird["species"],
                                "species_confidence": primary_bird["species_confidence"],
                                "family": primary_bird["family"],
                                "family_confidence": primary_bird["family_confidence"],
                                "quality": primary_bird["quality"],
                                "rating": primary_bird["rating"],
                            }
                        )
                        all_species = np.array([b["species"] for b in bird_data])
                        all_species_conf = np.array([b["species_confidence"] for b in bird_data])
                        all_families = np.array([b["family"] for b in bird_data])
                        all_family_conf = np.array([b["family_confidence"] for b in bird_data])
                        entry.update(
                            {
                                "secondary_species_list": all_species,
                                "secondary_species_scores": all_species_conf,
                                "secondary_family_list": all_families,
                                "secondary_family_scores": all_family_conf,
                            }
                        )
                        crop_img = primary_bird["quality_crop"]
                    else:
                        if wildlife_indices:
                            primary_index = wildlife_indices[np.argmax([pred_score[i] for i in wildlife_indices])]
                            result = process_nonbird(primary_index)
                            entry.update(
                                {
                                    "species": result["species"],
                                    "species_confidence": result["species_confidence"],
                                    "family": result["family"],
                                    "family_confidence": result["family_confidence"],
                                    "quality": result["quality"],
                                    "rating": result["rating"],
                                }
                            )
                            crop_img = result["quality_crop"]
                        else:
                            crop_img = img_small

                    crop_path = os.path.join(crop_dir, f"{os.path.splitext(raw_file)[0]}_crop.jpg")
                    cv2.imwrite(
                        crop_path,
                        cv2.cvtColor(crop_img, cv2.COLOR_RGB2BGR),
                        [cv2.IMWRITE_JPEG_QUALITY, 85],
                    )
                    entry.update({"crop_path": crop_path})

                    database = pd.concat([database, pd.DataFrame([entry])], ignore_index=True)
                    save_database(database, db_path)

                    if image_cb:
                        image_cb(entry)

                    if status_cb:
                        status_cb(
                            f"Processed {raw_file}: {entry['species']} Q={entry['quality']:.3f} "
                            f"R={entry['rating']} ({idx}/{total})"
                        )
                except Exception as e:
                    if error_cb:
                        error_cb(raw_file, e)
                    if status_cb:
                        status_cb(f"Error {raw_file}: {e}")
                    entry["scene_count"] = scene_count
                    entry["species"] = "Error"
                    entry["similar"] = False
                    database = pd.concat([database, pd.DataFrame([entry])], ignore_index=True)
                    save_database(database, db_path)
                    time.sleep(2)

                if progress_cb:
                    progress_cb(idx, total)

        except Exception as e:
            if status_cb:
                status_cb(f"Fatal error: {e}")
            if error_cb:
                error_cb("fatal", e)
