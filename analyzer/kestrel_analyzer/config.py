from pathlib import Path

VERSION = "1.6.2"

ANALYZER_DIR = Path(__file__).resolve().parents[1]
MODELS_DIR = ANALYZER_DIR / "models"

SPECIESCLASSIFIER_PATH = MODELS_DIR / "model.onnx"
SPECIESCLASSIFIER_LABELS = MODELS_DIR / "labels.txt"
QUALITYCLASSIFIER_PATH = MODELS_DIR / "quality.keras"
QUALITY_NORMALIZATION_DATA_PATH = MODELS_DIR / "quality_normalization_data.csv"
MASK_RCNN_WEIGHTS_PATH = MODELS_DIR / "mask_rcnn_resnet50_fpn_v2.pth"
YOLO_SEG_WEIGHTS_PATH = MODELS_DIR / "yolo26x-seg.pt"

WILDLIFE_CATEGORIES = [
    "cat", "dog", "horse", "sheep", "cow", "elephant", "bear", "zebra", "giraffe", "bird"
]

RAW_EXTENSIONS = [".cr2", ".cr3", ".nef", ".arw", ".dng", ".orf", ".rw2", ".pef", ".sr2"]
JPEG_EXTENSIONS = [".jpg", ".jpeg", ".png", '.tiff', '.tif']

DATABASE_NAME = "lingjian_database.csv"
METADATA_FILENAME = "lingjian_metadata.json"
SCENEDATA_FILENAME = "lingjian_scenedata.json"
KESTREL_DIR_NAME = ".lingjian"
LOG_FILENAME_PREFIX = "lingjian_error"
LOG_FILE_EXTENSION = "json"
