# Project Kestrel 中文版 (翎鉴) | Project Kestrel Chinese Fork

基于 [Project Kestrel](https://github.com/SanjaySoniLV/ProjectKestrel) 的中文本地化分支。利用机器学习对鸟类摄影照片进行自动分组、画质排序和物种标注，将无序的照片集转化为可搜索、可筛选的智能图库。

A Chinese-localized fork of [Project Kestrel](https://github.com/SanjaySoniLV/ProjectKestrel). Uses machine learning to automatically group, rank by sharpness, and tag bird photos by species — turning your photo collection into a searchable, sortable smart library.

![Python](https://img.shields.io/badge/python-3.11+-blue.svg)
![License](https://img.shields.io/badge/license-GPLv3-green.svg)
![Platform](https://img.shields.io/badge/platform-Windows%20%7C%20macOS-lightgrey.svg)

---

## 功能概览 | Features

- **画质排序 | Quality Ranking** — 按锐度自动排序，跳过数小时的手动筛片 / Auto-sort by sharpness, skip hours of manual culling
- **物种搜索 | Species Search** — 通过鸟种或科名关键词即时检索 / Instantly search by species or family keywords
- **场景分组 | Scene Grouping** — 连拍自动归组，同场景并排比较 / Bursts auto-grouped for side-by-side comparison
- **星级评分 | Star Rating** — AI 自动评分 + 手动覆盖，支持按星级分文件夹导出 / AI auto-rating + manual override, export by star rating
- **XMP 元数据 | XMP Metadata** — 写入 .xmp 旁车文件，兼容 Lightroom/Capture One/darktable / Write .xmp sidecars for Lightroom/Capture One/darktable
- **100% 本地 | 100% Local** — 所有处理在本地完成，照片不上传 / All processing on-device, no uploads

## 与上游的差异 | Differences from Upstream

| 特性 Feature | 上游 Upstream | 本分支 This Fork |
|------|---------------------|-------------|
| 界面语言 Language | English | 中文 Chinese (i18n) |
| UI 布局 Layout | Sidebar | Top bar, culling-focused |
| 数据目录 Data Dir | `.kestrel` | `.lingjian` |
| 分类数据 Taxonomy | English species names | 中文鸟种名 Chinese (IOC 15.1) |
| 应用入口 Entry | Separate GUI + Visualizer | Unified PyWebView app |
| 检测模型 Detection | Mask R-CNN | YOLO26x-seg 实例分割 |
| 硬件加速 Acceleration | CPU / CUDA | MPS (Apple Silicon) / CUDA / CPU |
| 处理速度 Speed | ~4s/张 | ~1s/张 (Apple Silicon MPS) |
| 导出功能 Export | 无 | 按星级分文件夹导出 + XMP 写入 |
| 遥测 Telemetry | 匿名使用统计 Anonymous telemetry | 已移除 Removed |

> **关于遥测 | About Telemetry:**
> 本分支已完全移除上游的遥测功能（安装统计、分析计数等）。由于本分支对 UI、数据结构和工作流进行了大量修改，且后续计划替换物种分类模型，继续上报数据会污染原作者的统计结果，因此选择移除以避免干扰。如果你希望支持原作者的数据收集，请使用[上游版本](https://github.com/SanjaySoniLV/ProjectKestrel)。
>
> Telemetry (installation stats, analysis counts, etc.) has been fully removed in this fork. Since this fork significantly modifies the UI, data structures, and workflow — and plans to replace the species classification model — continuing to report data would pollute the original author's statistics. If you wish to support the original author's data collection, please use the [upstream version](https://github.com/SanjaySoniLV/ProjectKestrel).

---

## 快速开始 | Quick Start

### 环境要求 | Prerequisites
- Python 3.11+
- Git (含 Git LFS)

### 安装 | Installation

```bash
git clone https://github.com/wlfcss/ProjectKestrel-zh.git
cd ProjectKestrel-zh
git lfs pull          # 拉取模型文件 (~200MB)
pip install -r requirements.txt
```

### 启动 | Launch

```bash
python analyzer/visualizer.py
```

应用以 PyWebView 桌面窗口启动，集成分析与浏览功能。
The app launches as a PyWebView desktop window with integrated analysis and browsing.

### 工作流 | Workflow

1. **导入 Import** — 点击"导入"选择照片文件夹 / Click "Import" to select a photo folder
2. **分析 Analyze** — 点击"分析"加入队列，等待 AI 处理 / Click "Analyze" to queue folders for AI processing
3. **浏览 Browse** — 场景卡片按画质排序，点击查看详情 / Scene cards sorted by quality; click for details
4. **筛片 Cull** — 标记接受/拒绝，手动评分星级 / Mark accept/reject, assign star ratings
5. **导出 Export** — 按星级分文件夹导出、或写入 XMP 元数据 / Export by star rating or write XMP metadata

---

## 技术原理 | How It Works

### 鸟类检测 | Bird Detection
使用 YOLO26x-seg 实例分割模型检测并分割图像中的鸟类，生成精确的遮罩区域。在 Apple Silicon 上通过 MPS 加速推理，回退链为 MPS → CoreML → CPU。
Uses YOLO26x-seg instance segmentation to detect and segment birds, generating precise masks. On Apple Silicon, inference is accelerated via MPS, with fallback chain: MPS → CoreML → CPU.

### 物种分类 | Species Classification
基于 ONNX 的自定义模型进行鸟种识别，输出 Top-5 物种及科级预测。当前模型主要针对北美洲鸟类训练，对亚洲鸟类置信度较低。
Custom ONNX model for bird species identification, outputting top-5 species and family predictions. Currently trained on North American birds; lower confidence on Asian species.

### 画质评估 | Quality Assessment
Keras 模型综合评估噪点、运动模糊、失焦等因素，仅对鸟类区域打分，不受背景影响。评分经百分位归一化后映射为 1-5 星。
Keras model evaluates noise, motion blur, and focus — scoring only the bird region, not the background. Scores are percentile-normalized then mapped to 1-5 stars.

### 场景分组 | Scene Grouping
基于 AKAZE 特征匹配和颜色直方图比较的自定义相似度算法，结合 EXIF 时间戳，自动将连拍归组。
Custom similarity algorithm combining AKAZE feature matching, color histogram comparison, and EXIF timestamps to auto-group bursts.

---

## 项目结构 | Project Structure

```
ProjectKestrel-zh/
├── analyzer/                    # 主应用 Main app
│   ├── visualizer.py            # PyWebView 入口 Entry point
│   ├── visualizer.html/js/css   # 主界面 Main UI
│   ├── api_bridge.py            # Python↔JS API bridge
│   ├── queue_manager.py         # 分析队列 Analysis queue
│   ├── metadata_writer.py       # XMP 写入 XMP writer
│   ├── folder_inspector.py      # 文件夹扫描 Folder inspector
│   ├── settings_utils.py        # 设置持久化 Settings persistence
│   ├── editor_launch.py         # 外部编辑器 External editor
│   ├── i18n.js                  # 前端国际化 Frontend i18n
│   ├── taxonomy.js              # 前端分类数据 Taxonomy data
│   ├── taxonomy_zh_cn.json      # 中文鸟种名 Chinese bird names
│   ├── cli.py                   # CLI 入口 CLI entry
│   ├── models/                  # AI 模型 Model files
│   │   ├── yolo26x-seg.pt       # YOLO 实例分割 (主模型)
│   │   ├── model.onnx           # 物种分类器 Species classifier
│   │   ├── quality.keras        # 画质评估 Quality model
│   │   └── ...                  # 标签映射、归一化数据等
│   └── kestrel_analyzer/        # 核心管线 Core pipeline
│       ├── pipeline.py          # 主管线 Main pipeline
│       ├── database.py          # CSV 数据库 Database ops
│       ├── image_utils.py       # 图像 I/O Image utils
│       ├── similarity.py        # 相似度 Similarity
│       ├── ratings.py           # 评分归一化 Ratings
│       ├── device_utils.py      # 设备检测 Device detection
│       └── ml/                  # ML 封装 Model wrappers
│           ├── yolo_seg.py      # YOLO 分割 YOLO segmentation
│           ├── mask_rcnn.py     # Mask R-CNN (legacy)
│           ├── bird_species.py  # 物种分类 Species classifier
│           └── quality.py       # 画质评估 Quality model
├── packaging/                   # PyInstaller 打包 Packaging
├── requirements.txt             # Python 依赖 Dependencies
└── README.md
```

## 支持的文件格式 | Supported File Formats

画质模型基于 RAW 训练，对 JPG 精度可能略低。
Quality model is trained on RAW; may be less accurate on JPEGs.

**RAW 格式 (推荐 Preferred)**:
Canon `.cr2` `.cr3` | Nikon `.nef` | Sony `.arw` | Adobe `.dng` | Olympus `.orf` | Panasonic `.rw2` | Pentax `.pef` | Samsung `.sr2`

**标准格式 Standard**: `.jpg` `.jpeg` `.png` `.tiff`

> 如果你的 RAW 格式不在列表中，欢迎提交 Issue。
> If your RAW format is missing, please open an Issue.

## GPU 加速 | GPU Acceleration

| 平台 Platform | 检测模型 Detection | 物种分类 Species | 画质评估 Quality |
|------|------|------|------|
| **macOS (Apple Silicon)** | MPS → CoreML → CPU | CPU | CPU |
| **Windows (NVIDIA)** | CUDA | DirectML | CUDA |
| **CPU 模式** | CPU | CPU | CPU |

> macOS 上 YOLO 优先使用 MPS 加速（约 1s/张），自动回退至 CoreML 或 CPU。
> On macOS, YOLO uses MPS acceleration (~1s/image) with automatic fallback to CoreML or CPU.

## 输出结构 | Output Structure

```
your_photos/
├── .lingjian/
│   ├── lingjian_database.csv    # 分析结果 Analysis results
│   ├── lingjian_scenedata.json  # 场景分组与用户标签 Scene data & user edits
│   ├── lingjian_metadata.json   # 分析元数据 Analysis metadata
│   ├── export/                  # JPEG 预览 Resized previews
│   ├── crop/                    # 鸟类裁剪 Bird crops
│   └── preview_analysis/        # 检测覆层 Detection overlays
└── [原始照片 Original photos]
```

---

## 致谢与上游项目 | Acknowledgments & Upstream

本项目 fork 自 **Sanjay Soni** 的 [Project Kestrel](https://github.com/SanjaySoniLV/ProjectKestrel)。感谢原作者出色的工作——从鸟类检测、物种分类到画质评估的完整 AI 管线，以及精心设计的场景分组算法，为本项目奠定了坚实的基础。

This project is forked from **Sanjay Soni**'s [Project Kestrel](https://github.com/SanjaySoniLV/ProjectKestrel). Huge thanks to the original author for building the complete AI pipeline — bird detection, species classification, quality assessment, and the elegant scene grouping algorithm — which forms the foundation of this project.

**支持原作者 | Support the Original Author:**
- [Project Kestrel 官网 | Official Website](https://projectkestrel.org)
- [捐赠 | Donate via PayPal](https://www.paypal.com/donate/?hosted_button_id=CXH4FE5AKZD3A)
- [联系 | Contact](mailto:support@projectkestrel.org)

### 开源依赖 | Open Source Dependencies

- [Ultralytics](https://github.com/ultralytics/ultralytics) — YOLO 实例分割 / YOLO instance segmentation
- [rawpy](https://github.com/letmaik/rawpy) — RAW 图像处理 / RAW image processing
- [PyInstaller](https://pyinstaller.org) — Python 打包 / App packaging
- [PyWebView](https://pywebview.flowrl.com) — 桌面 WebView / Desktop WebView
- [Papa Parse](https://www.papaparse.com) — CSV 解析 / CSV parsing
- [IOC World Bird List](https://www.worldbirdnames.org) — 鸟类分类数据 / Bird taxonomy

## 许可证 | License

本项目继承上游的 GPL v3 许可证，附加 Commons Clause License Condition v1.0。详见 [LICENSE](LICENSE)。未经原作者明确许可，禁止商业使用。

This project inherits the upstream GPL v3 license with Commons Clause License Condition v1.0. See [LICENSE](LICENSE). Commercial use is prohibited without explicit permission from the original author.
