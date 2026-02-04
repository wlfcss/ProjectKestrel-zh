import torch as t
import onnxruntime as ort
import tensorflow as tf

import sys
import threading
from typing import Optional, Dict

from PyQt5.QtCore import Qt, pyqtSignal, QThread
from PyQt5.QtGui import QImage, QPixmap
from PyQt5.QtWidgets import (
    QApplication,
    QWidget,
    QPushButton,
    QLabel,
    QVBoxLayout,
    QHBoxLayout,
    QFileDialog,
    QProgressBar,
    QCheckBox,
    QMessageBox,
    QGroupBox,
    QGridLayout,
    QSizePolicy,
)

#from pathlib import Path

#sys.path.insert(0, str(Path(__file__).parent))

from kestrel_analyzer.pipeline import AnalysisPipeline
from kestrel_analyzer.logging_utils import get_log_path, log_event, log_exception
from gui_helpers import load_qimage_from_path


class ProcessingWorker(QThread):
    progress = pyqtSignal(int, int)
    image_processed = pyqtSignal(dict, QImage, QImage)
    status = pyqtSignal(str)
    finished = pyqtSignal()

    def __init__(self, folder: str, use_gpu: bool, parent=None):
        super().__init__(parent)
        self.folder = folder
        self.use_gpu = use_gpu
        self._pause_event = threading.Event()
        self._pause_event.set()

    def pause(self):
        self._pause_event.clear()

    def resume(self):
        self._pause_event.set()

    def run(self):
        pipeline = AnalysisPipeline(use_gpu=self.use_gpu)

        def on_status(msg: str):
            self.status.emit(msg)

        def on_progress(processed: int, total: int):
            self.progress.emit(processed, total)

        def on_image(entry: dict):
            export_q = load_qimage_from_path(entry.get("export_path"))
            crop_q = load_qimage_from_path(entry.get("crop_path"))
            self.image_processed.emit(entry, export_q, crop_q)

        pipeline.process_folder(
            self.folder,
            pause_event=self._pause_event,
            callbacks={
                "on_status": on_status,
                "on_progress": on_progress,
                "on_image": on_image,
            },
            analyzer_name="gui",
        )
        self.finished.emit()


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
            "secondary_family_scores",
        ]
        for row, field in enumerate(fields):
            grid.addWidget(QLabel(field.replace("_", " ").title() + ":"), row, 0)
            val_label = QLabel("-")
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
            self.lbl_export.setPixmap(
                QPixmap.fromImage(export_img).scaled(
                    self.lbl_export.size(), Qt.KeepAspectRatio, Qt.SmoothTransformation
                )
            )
        if crop_img:
            self.lbl_crop.setPixmap(
                QPixmap.fromImage(crop_img).scaled(
                    self.lbl_crop.size(), Qt.KeepAspectRatio, Qt.SmoothTransformation
                )
            )
        for k, v in entry.items():
            if k in self.info_labels:
                if isinstance(v, float):
                    self.info_labels[k].setText(f"{v:.4f}")
                else:
                    self.info_labels[k].setText(str(v))

    def resizeEvent(self, event):
        if self.lbl_export.pixmap():
            self.lbl_export.setPixmap(
                self.lbl_export.pixmap().scaled(
                    self.lbl_export.size(), Qt.KeepAspectRatio, Qt.SmoothTransformation
                )
            )
        if self.lbl_crop.pixmap():
            self.lbl_crop.setPixmap(
                self.lbl_crop.pixmap().scaled(
                    self.lbl_crop.size(), Qt.KeepAspectRatio, Qt.SmoothTransformation
                )
            )
        super().resizeEvent(event)

    def on_status(self, msg: str):
        self.lbl_status.setText(msg)

    def on_finished(self):
        self.lbl_status.setText("Finished")
        self.btn_start.setEnabled(True)
        self.btn_pause.setEnabled(False)
        self.btn_resume.setEnabled(False)


def main(app: Optional[QApplication] = None):
    log_path = get_log_path(None)
    try:
        log_event(
            log_path,
            {
                "level": "info",
                "event": "gui_start",
            },
        )
        owns_app = app is None
        app = app or QApplication(sys.argv)
        win = KestrelGUI()
        win.show()
        if owns_app:
            sys.exit(app.exec_())
        else:
            app.exec_()
    except Exception as e:
        log_exception(
            log_path,
            e,
            stage="startup",
            context={"analyzer": "gui"},
        )
        raise


if __name__ == "__main__":
    main()
