# 翎鉴 (ProjectKestrel-zh) — Claude Code 项目指南

## 项目概述

鸟类摄影智能分析桌面应用，基于 ML 自动分组、画质排序、物种标注。
- **后端:** Python 3.11+ (PyWebView + torch/ultralytics/onnxruntime/tensorflow)
- **前端:** 单文件 JS (visualizer.js) + HTML/CSS，无框架
- **打包:** PyInstaller (Windows/macOS)
- **入口:** `python analyzer/visualizer.py`

## 项目结构

- `analyzer/` — 主应用目录
  - `visualizer.py` — PyWebView 桌面应用入口
  - `visualizer.js` — 前端逻辑 (状态管理、渲染、交互)
  - `api_bridge.py` — Python↔JS API 桥接层
  - `queue_manager.py` — 分析队列管理器
  - `kestrel_analyzer/` — 核心分析管线 (无 GUI 依赖)
    - `pipeline.py` — 主分析管线
    - `ml/` — ML 模型封装 (YOLO, ONNX, Keras)
- `packaging/` — PyInstaller 打包配置
- `scripts/` — 工具脚本
- `.github/workflows/` — CI (macOS + Windows 自动构建)

## 开发规范

- 界面语言：中文优先，代码注释中英均可
- 数据目录：`.lingjian`（非上游的 `.kestrel`）
- commit message 使用中文前缀 (如 `fix:`, `feat:`, `docs:`, `chore:`, `release:`)
- 分支策略：main 分支直接开发

## 常用命令

```bash
# 启动应用
python analyzer/visualizer.py

# CLI 模式分析
python analyzer/cli.py <folder>

# 打包 (Windows)
packaging/build_installer.bat

# 打包 (macOS)
packaging/build_app_headless.sh
```

## 注意事项

- 模型文件通过 Git LFS 管理，位于 `analyzer/models/`
- 不要修改 `.venv/` 目录下的文件
- 前端为单文件架构，修改 `visualizer.js` 时注意函数间依赖
- 测试流程参见 `TESTING.md`
