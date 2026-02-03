# Project Kestrel - Development & Packaging Guide

## Project Structure

```
ProjectKestrel/
├── analyzer/                    # Analyzer application (GUI + CLI)
│   ├── gui_app.py              # PyQt5 GUI entry point
│   ├── cli.py                  # CLI entry point (headless mode)
│   ├── main.py                 # Default GUI launcher
│   ├── gui_helpers.py          # GUI utilities (QImage conversion)
│   ├── models/                 # AI model files
│   │   ├── model.onnx          # Bird species classifier (ONNX)
│   │   ├── labels.txt          # Species labels
│   │   ├── quality.keras       # Quality assessment model
│   │   ├── labels_scispecies.csv
│   │   └── scispecies_dispname.csv
│   └── kestrel_analyzer/       # Core analysis pipeline (no GUI)
│       ├── __init__.py
│       ├── config.py           # Configuration and constants
│       ├── database.py         # Database operations
│       ├── pipeline.py         # Main analysis pipeline
│       ├── image_utils.py      # Image I/O utilities
│       ├── similarity.py       # Image similarity detection
│       ├── ratings.py          # Quality score to rating conversion
│       └── ml/                 # Machine learning model wrappers
│           ├── mask_rcnn.py    # Object detection (bird localization)
│           ├── bird_species.py # Bird species classification
│           └── quality.py      # Image quality assessment
│
├── visualizer/                  # Visualizer application (web-based)
│   ├── visualizer.py           # Local web server entry
│   └── visualizer.html         # Web UI
│
├── packaging/                   # PyInstaller specs for EXE builds
│   ├── analyzer/
│   │   └── kestrel_analyzer.spec
│   └── visualizer/
│       └── kestrel_visualizer.spec
│
├── requirements.txt            # Python dependencies
└── README.md
```

## Development Setup

### 1. Clone and Install Dependencies

```bash
git clone https://github.com/SanjaySoniLV/ProjectKestrel.git
cd ProjectKestrel
pip install -r requirements.txt
```

### 2. Running the Analyzer

**GUI Mode (default):**
```bash
python analyzer/gui_app.py
# or
python analyzer/main.py
```

**Model Files Required:**
All models must be in `analyzer/models/`:
- `model.onnx` (bird species classifier)
- `labels.txt`, `labels_scispecies.csv`, `scispecies_dispname.csv`
- `quality.keras` (quality assessment)
- `mask_rcnn_resnet50_fpn_v2.pth` (object detection)

**CLI Mode (headless):**
```bash
python analyzer/cli.py "C:\path\to\photos" --no-gpu
python analyzer/cli.py "C:\path\to\photos" --gpu
```

### 3. Running the Visualizer

```bash
python visualizer/visualizer.py --port 8765 --root "C:\path\to\analyzed\photos"
```

## Building Executables

### Prerequisites

```bash
pip install pyinstaller
```

### Build Analyzer EXE

```bash
cd ProjectKestrel
pyinstaller packaging/analyzer/kestrel_analyzer.spec
```

Output: `dist/kestrel_analyzer/kestrel_analyzer.exe`

### Build Visualizer EXE

```bash
cd ProjectKestrel
pyinstaller packaging/visualizer/kestrel_visualizer.spec
```

Output: `dist/kestrel_visualizer/kestrel_visualizer.exe`

## Code Organization

### Core Pipeline (Reusable)
The `analyzer/kestrel_analyzer/` package contains all business logic with **zero GUI dependencies**:
- **pipeline.py**: Main orchestration class
- **database.py**: CSV database operations
- **image_utils.py, similarity.py, ratings.py**: Utility functions
- **ml/*.py**: Model wrappers (ONNX, Keras, Torch)

This allows the pipeline to be:
- ✅ Used by GUI (PyQt5)
- ✅ Used by CLI (command-line)
- ✅ Used by web services (FastAPI, Flask)
- ✅ Used by third-party tools

### GUI Layer (PyQt5)
- **gui_app.py**: Main GUI window and worker thread
- **gui_helpers.py**: Qt-specific utilities
- **main.py**: Entry point that launches GUI

### CLI Layer
- **cli.py**: Argument parsing and CLI-specific formatting

### Visualizer (Standalone Web Service)
- **visualizer.py**: HTTP server that serves visualizer.html
- **visualizer.html**: Web UI for browsing results

## Deployment Strategy

### Single-File Distribution
Both applications can be packaged as single-file executables:
- `kestrel_analyzer.exe` (~500MB with all dependencies)
- `kestrel_visualizer.exe` (~50MB)

### Installation Options
1. **Portable ZIP**: Unzip and run executable
2. **MSI Installer**: Use WiX Toolset or similar
3. **Windows Store**: Package as MSIX

## Module Dependencies

**External Dependencies** (from requirements.txt):
- torch, torchvision (Mask R-CNN)
- tensorflow (Quality classifier)
- onnxruntime (Bird species classifier)
- opencv-python, pillow, wand (Image processing)
- pandas, numpy (Data handling)
- PyQt5 (GUI only)

**Internal Imports:**
- CLI and GUI both import from `kestrel_analyzer` package
- No circular dependencies
- All ML models loaded lazily in pipeline

## Testing

To test the CLI locally:
```bash
python analyzer/cli.py test_imgs --no-gpu
```

To test the GUI:
```bash
python analyzer/gui_app.py
```

Then select `test_imgs` folder and click Start.

## Migration Notes

This refactoring achieves:
- ✅ **Separation of Concerns**: Core logic separate from UI
- ✅ **Dual Interfaces**: GUI and CLI share same pipeline
- ✅ **Packaging Ready**: Clear structure for executables
- ✅ **No Duplication**: One code path for both interfaces
- ✅ **Extensibility**: Easy to add web API or other interfaces later
