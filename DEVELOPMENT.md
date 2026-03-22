# 翎鉴 — 开发与打包指南

## 项目结构

```
ProjectKestrel-zh/
├── analyzer/                    # 主应用
│   ├── visualizer.py            # PyWebView 桌面应用入口
│   ├── visualizer.html          # 主界面 HTML
│   ├── visualizer.js            # 主界面逻辑 (状态管理、渲染、交互)
│   ├── visualizer.css           # 主界面样式
│   ├── api_bridge.py            # Python↔JS API 桥接层
│   ├── queue_manager.py         # 分析队列管理器
│   ├── metadata_writer.py       # XMP 元数据写入
│   ├── folder_inspector.py      # 文件夹扫描与状态检测
│   ├── editor_launch.py         # 外部编辑器启动
│   ├── settings_utils.py        # 设置持久化 (JSON)
│   ├── taxonomy_utils.py        # 分类学工具 (IOC → 中文映射)
│   ├── taxonomy_zh_cn.json      # 中文鸟种名数据
│   ├── i18n.js                  # 前端国际化模块
│   ├── taxonomy.js              # 前端分类数据
│   ├── culling.html             # 筛片助手页面 (独立窗口)
│   ├── cli.py                   # CLI 入口 (无界面分析)
│   ├── main.py                  # 兼容入口 (转发至 visualizer.py)
│   ├── runtime_hook.py          # PyInstaller 运行时钩子
│   ├── _test_harness.html       # 前端状态管理测试工具
│   ├── VERSION.txt              # 版本号
│   ├── models/                  # AI 模型文件 (Git LFS)
│   │   ├── yolo26x-seg.pt       # YOLO26x 实例分割 (主模型, 136MB)
│   │   ├── yolo26l-seg.pt       # YOLO26l 实例分割 (61MB)
│   │   ├── yolo26m-seg.pt       # YOLO26m 实例分割 (52MB)
│   │   ├── yolo26s-seg.pt       # YOLO26s 实例分割 (22MB)
│   │   ├── yolo26x-seg.mlpackage/  # CoreML 版 (Apple Silicon)
│   │   ├── mask_rcnn_resnet50_fpn_v2.pth  # Mask R-CNN (legacy, 177MB)
│   │   ├── model.onnx           # 物种分类器 (ONNX, 45MB)
│   │   ├── quality.keras        # 画质评估模型 (Keras, 1.5MB)
│   │   ├── labels.txt           # 物种标签
│   │   ├── labels_scispecies.csv # 学名-科映射
│   │   ├── scispecies_dispname.csv # 科显示名
│   │   └── quality_normalization_data.csv  # 画质百分位映射
│   └── kestrel_analyzer/        # 核心分析管线 (无 GUI 依赖)
│       ├── config.py            # 配置常量 (路径、版本、扩展名)
│       ├── pipeline.py          # 主分析管线
│       ├── database.py          # CSV 数据库操作
│       ├── image_utils.py       # 图像 I/O (RAW/JPEG/PNG)
│       ├── similarity.py        # 图像相似度与场景分组
│       ├── ratings.py           # 评分归一化 (质量 → 星级)
│       ├── raw_exif.py          # RAW EXIF 读取
│       ├── device_utils.py      # GPU/MPS/CPU 设备检测
│       ├── logging_utils.py     # 结构化错误日志
│       └── ml/                  # ML 模型封装
│           ├── yolo_seg.py      # YOLO 实例分割 (MPS/CoreML/CPU)
│           ├── mask_rcnn.py     # Mask R-CNN 目标检测 (legacy)
│           ├── bird_species.py  # 物种分类 (ONNX)
│           └── quality.py       # 画质评估 (Keras)
│
├── packaging/                   # PyInstaller 打包配置
│   ├── ProjectKestrel-macos.spec # macOS 打包规格
│   ├── ProjectKestrel.spec      # Windows 打包规格
│   ├── build_app_headless.sh    # macOS 构建脚本
│   ├── build_installer.bat      # Windows 构建脚本
│   └── kestrel_installer.iss    # InnoSetup 安装程序 (Windows)
│
├── .github/workflows/
│   └── build-macos.yml          # macOS CI: 自动构建 DMG/ZIP
│
├── scripts/                     # 工具脚本
├── requirements.txt             # Python 依赖
└── README.md
```

## 开发环境搭建

### 1. 克隆并安装依赖

```bash
git clone https://github.com/wlfcss/ProjectKestrel-zh.git
cd ProjectKestrel-zh
git lfs pull          # 拉取模型文件 (~200MB)
pip install -r requirements.txt
```

### 2. 启动应用

**桌面模式 (默认):**
```bash
python analyzer/visualizer.py
```

**CLI 模式 (无界面):**
```bash
python analyzer/cli.py "/path/to/photos" --no-gpu
python analyzer/cli.py "/path/to/photos" --gpu
python analyzer/cli.py "/path/to/photos" --smoke   # 快速冒烟测试
```

### 3. 模型文件

所有模型位于 `analyzer/models/` 目录，通过 Git LFS 管理：

| 文件 | 用途 | 大小 |
|------|------|------|
| `yolo26x-seg.pt` | YOLO 实例分割 (主模型) | 136MB |
| `yolo26x-seg.mlpackage/` | CoreML 版 (Apple Silicon 回退) | — |
| `mask_rcnn_resnet50_fpn_v2.pth` | Mask R-CNN (legacy) | 177MB |
| `model.onnx` | 物种分类器 | 45MB |
| `quality.keras` | 画质评估 | 1.5MB |
| `labels.txt` | 物种标签 (1000+ 种) | — |
| `quality_normalization_data.csv` | 画质百分位映射 | — |

## 架构说明

### 整体架构

```
┌──────────────────────────────────┐
│  PyWebView 桌面窗口               │
│  (visualizer.html + js + css)    │
└───────────┬──────────────────────┘
            │ window.pywebview.api
            ↓
┌──────────────────────────────────┐
│  api_bridge.py — API 桥接层       │
│  文件操作 / 设置 / 队列管理        │
└───────────┬──────────────────────┘
            │
    ┌───────┼───────────────┐
    ↓       ↓               ↓
  队列    CSV 读写     分析管线
 管理器   (database)   (pipeline)
    │       │               │
    └───────┴───────────────┘
            ↓
  ┌─────────────────────────┐
  │  kestrel_analyzer/       │
  │  pipeline.py → 编排      │
  │  ml/yolo_seg.py → 检测   │
  │  ml/bird_species.py → 分类│
  │  ml/quality.py → 画质    │
  │  similarity.py → 分组    │
  └─────────────────────────┘
```

### 核心管线 (`kestrel_analyzer/`)

核心分析管线完全独立于 GUI，零 UI 依赖：

- **pipeline.py** — 主编排：检测→分类→评分→分组
- **database.py** — CSV 数据库读写，支持版本升级迁移
- **similarity.py** — AKAZE 特征匹配 + 颜色直方图 + 时间戳的场景分组
- **ratings.py** — 质量分数 → 星级映射，支持 5 种严格度配置
- **device_utils.py** — 自动检测 MPS / CUDA / CPU，选择最优设备
- **ml/*.py** — 各 ML 模型的封装层

可被以下方式复用：
- PyWebView 桌面应用 (当前)
- CLI 命令行
- Web 服务 (FastAPI/Flask)
- 第三方工具集成

### 设备选择逻辑

YOLO 检测模型的设备选择优先级：

| 平台 | 优先级 |
|------|--------|
| macOS (Apple Silicon) | MPS → CoreML (.mlpackage) → CPU |
| Windows (NVIDIA) | CUDA → CPU |
| 其他 | CPU |

TensorFlow (画质模型) 在 macOS 上仅支持 CPU（Metal 支持已停止维护）。

### 前端架构

前端是单文件 JS 应用 (`visualizer.js`)，通过 `window.pywebview.api` 与 Python 后端通信。

关键状态变量：
- `rows` / `header` — CSV 数据行
- `scenes` — 聚合后的场景列表
- `rootPath` — 当前加载的根目录
- `_scenedata` — 场景元数据 (用户标签、评分、场景合并等)
- `checkedFolderPaths` — 文件夹树中已勾选的路径
- `dirty` — 是否有未保存的修改

### 数据目录

分析结果存储在 `.lingjian` 目录中 (配置于 `config.py` 的 `KESTREL_DIR_NAME`)：

```
.lingjian/
├── lingjian_database.csv       # 主数据库 (自动生成的分析结果)
├── lingjian_scenedata.json     # 用户编辑 (评分、场景标签、合并)
├── lingjian_metadata.json      # 分析元数据 (版本、时间戳、质量分布)
├── lingjian_error_*.json       # 结构化错误日志
├── export/                     # 缩放预览图 (max 1600px)
├── crop/                       # 鸟类区域裁剪
├── preview_analysis/           # 检测覆层图
└── culling_TMP/                # RAW 预览缓存 (临时)
```

### 评分系统

评分由两个来源组成，手动评分优先：

1. **手动评分** — 用户在 UI 中设置，存储在 `lingjian_scenedata.json` 的 `image_ratings` 字典
2. **自动评分** — 由 `apply_normalization()` 根据画质分数计算，存储在 CSV 的 `normalized_rating` 列

前端通过 `getRating(row)` 统一获取（优先手动 → 回退自动），`getOrigin(row)` 返回评分来源。

## 打包

### 前置要求

```bash
pip install pyinstaller
```

### 构建 macOS 应用

```bash
cd packaging
bash build_app_headless.sh
```

或使用 PyInstaller spec：
```bash
pyinstaller packaging/ProjectKestrel-macos.spec
```

### 构建 Windows 应用

```bash
pyinstaller packaging/ProjectKestrel.spec
```

### CI 自动构建

推送 `v*` 标签到 GitHub 会自动触发 `.github/workflows/build-macos.yml`，生成 DMG 和 ZIP 并发布到 GitHub Releases。

```bash
git tag v1.1.1
git push origin main --tags
```

## 测试

### 前端状态管理测试

使用 `_test_harness.html` 进行前端自动化测试。该文件注入了 mock PyWebView API，可在浏览器中模拟完整的用户操作流程：

```bash
cd analyzer && python -m http.server 8765
# 浏览器打开 http://localhost:8765/_test_harness.html
```

### 分析管线测试

```bash
python analyzer/cli.py test_imgs --no-gpu
python analyzer/cli.py test_imgs --smoke    # 快速冒烟测试
```

## 主要依赖

| 库 | 用途 |
|---|------|
| ultralytics | YOLO 实例分割 |
| torch, torchvision | YOLO 推理 + Mask R-CNN (legacy) |
| tensorflow | 画质评估模型 |
| onnxruntime | 物种分类模型 |
| coremltools | CoreML 模型转换 (macOS) |
| opencv-python, pillow, rawpy | 图像处理 |
| pandas, numpy | 数据处理 |
| pywebview | 桌面 GUI |
| PyExifTool, exifread | EXIF 元数据 |
| pyinstaller | 应用打包 |
