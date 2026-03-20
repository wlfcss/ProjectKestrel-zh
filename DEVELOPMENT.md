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
│   ├── metadata_writer.py       # XMP/EXIF 元数据写入
│   ├── folder_inspector.py      # 文件夹扫描与状态检测
│   ├── editor_launch.py         # 外部编辑器启动
│   ├── settings_utils.py        # 设置持久化
│   ├── taxonomy_utils.py        # 分类学工具 (IOC → 中文映射)
│   ├── taxonomy_zh_cn.json      # 中文鸟种名数据
│   ├── i18n.js                  # 前端国际化模块
│   ├── taxonomy.js              # 前端分类数据
│   ├── culling.html             # 筛片助手页面 (独立)
│   ├── cli.py                   # CLI 入口 (无界面分析)
│   ├── main.py                  # 启动入口
│   ├── _test_harness.html       # 前端状态管理测试工具
│   ├── models/                  # AI 模型文件
│   │   ├── model.onnx           # 物种分类器 (ONNX)
│   │   ├── labels.txt           # 物种标签
│   │   ├── quality.keras        # 画质评估模型
│   │   ├── labels_scispecies.csv
│   │   └── scispecies_dispname.csv
│   └── kestrel_analyzer/        # 核心分析管线 (无 GUI 依赖)
│       ├── config.py            # 配置常量 (数据目录名等)
│       ├── pipeline.py          # 主分析管线
│       ├── database.py          # CSV 数据库操作
│       ├── image_utils.py       # 图像 I/O 工具
│       ├── similarity.py        # 图像相似度检测
│       ├── ratings.py           # 评分归一化
│       ├── raw_exif.py          # RAW EXIF 读取
│       ├── logging_utils.py     # 日志工具
│       └── ml/                  # ML 模型封装
│           ├── mask_rcnn.py     # 目标检测 (Mask R-CNN)
│           ├── bird_species.py  # 物种分类 (ONNX)
│           └── quality.py       # 画质评估 (Keras)
│
├── packaging/                   # PyInstaller 打包配置
│   ├── ProjectKestrel.spec      # Windows 打包规格
│   └── ProjectKestrel-macos.spec # macOS 打包规格
│
├── scripts/                     # 构建/工具脚本
├── requirements.txt             # Python 依赖
├── requirements-win.txt         # Windows 特定依赖
└── README.md
```

## 开发环境搭建

### 1. 克隆并安装依赖

```bash
git clone https://github.com/wlfcss/ProjectKestrel-zh.git
cd ProjectKestrel-zh
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
```

### 3. 模型文件

所有模型必须位于 `analyzer/models/` 目录：
- `model.onnx` — 物种分类器
- `labels.txt`, `labels_scispecies.csv`, `scispecies_dispname.csv` — 标签映射
- `quality.keras` — 画质评估模型
- `mask_rcnn_resnet50_fpn_v2.pth` — 目标检测模型 (约 177MB)

## 架构说明

### 核心管线 (`kestrel_analyzer/`)

核心分析管线完全独立于 GUI，零 UI 依赖：

- **pipeline.py** — 主编排：检测→分类→评分→分组
- **database.py** — CSV 数据库读写
- **similarity.py** — 场景分组算法
- **ml/*.py** — 各 ML 模型的封装层

可被以下方式复用：
- PyWebView 桌面应用 (当前)
- CLI 命令行
- Web 服务 (FastAPI/Flask)
- 第三方工具集成

### 前端架构

前端是单文件 JS 应用 (`visualizer.js`)，通过 `window.pywebview.api` 与 Python 后端通信。

关键状态变量：
- `rows` / `header` — CSV 数据行
- `scenes` — 聚合后的场景列表
- `rootPath` — 当前加载的根目录
- `_scenedata` — 场景元数据 (用户标签、合并信息等)
- `checkedFolderPaths` — 文件夹树中已勾选的路径
- `dirty` — 是否有未保存的修改

### 数据目录

分析结果存储在 `.lingjian` 目录中 (配置于 `config.py` 的 `KESTREL_DIR_NAME`)：
- `lingjian_database.csv` — 主数据库
- `export/` — 缩放预览图
- `crop/` — 鸟类裁剪图
- `scenedata.json` — 场景分组与用户标签

## 打包

### 前置要求

```bash
pip install pyinstaller
```

### 构建 macOS 应用

```bash
pyinstaller analyzer/ProjectKestrel-macos.spec
```

### 构建 Windows 应用

```bash
pyinstaller analyzer/ProjectKestrel.spec
```

## 测试

### 前端状态管理测试

使用 `_test_harness.html` 进行前端自动化测试。该文件注入了 mock PyWebView API，可在浏览器中模拟完整的用户操作流程：

```bash
# 启动本地服务器
cd analyzer && python -m http.server 8765
# 浏览器打开 http://localhost:8765/_test_harness.html
```

### 分析管线测试

```bash
python analyzer/cli.py test_imgs --no-gpu
```

## 主要依赖

| 库 | 用途 |
|---|------|
| torch, torchvision | Mask R-CNN 目标检测 |
| tensorflow | 画质评估模型 |
| onnxruntime | 物种分类模型 |
| opencv-python, pillow, rawpy | 图像处理 |
| pandas, numpy | 数据处理 |
| pywebview | 桌面 GUI |
| PyExifTool, exifread | EXIF 元数据 |
