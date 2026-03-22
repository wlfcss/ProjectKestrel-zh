"""Project Kestrel 的分析队列管理器。

该模块提供线程安全的顺序分析队列 ``QueueManager``，
以及内部使用的 ``_QueueItem`` 数据结构。
"""

from __future__ import annotations

import os
import sys
import threading
import time as _time_mod

from settings_utils import load_persisted_settings, save_persisted_settings, log

# ---------------------------------------------------------------------------
# 可选依赖：同级 analyzer 模块中的 AnalysisPipeline。
# 导入阶段只做轻量目录检查，真正的流水线/模型导入推迟到首次请求分析时，
# 这样用户只浏览已分析照片时，可视化界面能更快启动。
# ---------------------------------------------------------------------------
_pipeline_import_error = ''
_AnalysisPipeline = None   # 首次使用时再惰性填充


def _ensure_pipeline_path() -> bool:
    """如果 analyzer 包目录存在，则把它加入 sys.path。"""
    script_dir = os.path.dirname(os.path.abspath(__file__))
    for candidate in [
        os.path.join(script_dir, '..', 'analyzer'),
        os.path.join(script_dir, 'analyzer'),
        script_dir,
        os.path.join(script_dir, '..'),
    ]:
        candidate = os.path.normpath(candidate)
        if os.path.isdir(os.path.join(candidate, 'kestrel_analyzer')):
            if candidate not in sys.path:
                sys.path.insert(0, candidate)
            return True
    return False


# 轻量检查：只确认 kestrel_analyzer 目录是否存在，不导入任何 ML 依赖
_PIPELINE_AVAILABLE = _ensure_pipeline_path()
if not _PIPELINE_AVAILABLE:
    _pipeline_import_error = 'kestrel_analyzer package not found alongside the visualizer (expected kestrel_analyzer in repo)'


def _get_pipeline_class():
    """首次调用时导入并缓存 AnalysisPipeline（延迟 ML 导入）。"""
    global _AnalysisPipeline, _PIPELINE_AVAILABLE, _pipeline_import_error
    log("_get_pipeline_class() called, available:", _PIPELINE_AVAILABLE)
    if _AnalysisPipeline is not None:
        return _AnalysisPipeline
    try:
        log("Importing AnalysisPipeline from kestrel_analyzer.pipeline...")
        from kestrel_analyzer.pipeline import AnalysisPipeline  # type: ignore  # noqa: PLC0415
        log("AnalysisPipeline imported successfully.")
        _AnalysisPipeline = AnalysisPipeline
        _PIPELINE_AVAILABLE = True
        return _AnalysisPipeline
    except Exception as exc:
        _pipeline_import_error = str(exc)
        _PIPELINE_AVAILABLE = False
        return None


def _quality_to_raw_rating(quality: float) -> int:
    """Map raw quality score to fixed-threshold stars (1-5, or 0 for invalid)."""
    try:
        q = float(quality)
    except (TypeError, ValueError):
        return 0
    if q < 0:
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


class _QueueItem:
    __slots__ = ('path', 'name', 'status', 'processed', 'total', 'error',
                 'start_time', 'end_time', 'paused_duration', 'pause_start_time',
                 'current_filename', 'current_export_path', 'current_status_msg',
                 'current_overlay_rel', 'current_crops_rel', 'current_detections',
                 'current_quality_results', 'current_species_results',
                 'initial_processed', 'backend')

    def __init__(self, path: str, name: str):
        self.path = path
        self.name = name
        self.status = 'pending'   # pending | running | done | error | cancelled
        self.processed = 0
        self.total = 0
        self.error = ''
        self.start_time: float | None = None
        self.end_time: float | None = None
        self.paused_duration: float = 0.0
        self.pause_start_time: float | None = None
        self.current_filename: str = ''
        self.current_export_path: str = ''
        self.current_status_msg: str = ''
        self.current_overlay_rel: str = ''
        self.current_crops_rel: list = []
        self.current_detections: list = []
        self.current_quality_results: list = []
        self.current_species_results: list = []
        self.initial_processed: int = 0  # 本轮开始前已经处理完成的文件数
        self.backend: str = ''

    def to_dict(self) -> dict:
        elapsed = 0.0
        if self.start_time is not None:
            end = self.end_time if self.end_time is not None else _time_mod.time()
            raw = end - self.start_time
            paused = self.paused_duration
            if self.pause_start_time is not None:
                paused += _time_mod.time() - self.pause_start_time
            elapsed = max(0.0, raw - paused)
        return {
            'path': self.path,
            'name': self.name,
            'status': self.status,
            'processed': self.processed,
            'total': self.total,
            'error': self.error,
            'elapsed_seconds': round(elapsed, 1),
            'is_paused': self.pause_start_time is not None,
            'current_filename': self.current_filename,
            'current_export_path': self.current_export_path,
            'current_status_msg': self.current_status_msg,
            'current_overlay_rel': self.current_overlay_rel,
            'current_crops_rel': list(self.current_crops_rel),
            'current_detections': list(self.current_detections),
            'current_quality_results': list(self.current_quality_results),
            'current_species_results': list(self.current_species_results),
            'backend': self.backend,
        }


class QueueManager:
    """Thread-safe manager for the sequential folder-analysis queue."""

    def __init__(self):
        self._lock = threading.Lock()
        self._items: list = []          # list[_QueueItem]
        self._pause_event = threading.Event()
        self._pause_event.set()         # set = NOT paused
        self._cancel_event = threading.Event()
        self._thread: threading.Thread | None = None
        self._pipeline = None
        self._use_gpu = True
        self._wildlife_enabled = True
        self._detection_threshold = 0.40
        self._scene_time_threshold = 1.0
        self._mask_threshold = 0.5

    # ---- 对外只读属性 ----

    @property
    def is_running(self) -> bool:
        return self._thread is not None and self._thread.is_alive()

    @property
    def is_paused(self) -> bool:
        return not self._pause_event.is_set()

    def get_status(self) -> dict:
        with self._lock:
            return {
                'available': _PIPELINE_AVAILABLE,
                'unavailable_reason': _pipeline_import_error if not _PIPELINE_AVAILABLE else '',
                'running': self.is_running,
                'paused': self.is_paused,
                'items': [it.to_dict() for it in self._items],
            }

    # ---- 队列控制 ----

    def enqueue(self, paths: list, use_gpu: bool = True, wildlife_enabled: bool = True, detection_threshold: float = 0.40, scene_time_threshold: float = 1.0, mask_threshold: float = 0.5) -> dict:
        if not _PIPELINE_AVAILABLE:
            return {'success': False, 'error': f'Analyzer unavailable: {_pipeline_import_error}'}
        with self._lock:
            path_to_item = {it.path: it for it in self._items}
            added = 0
            for p in paths:
                existing_item = path_to_item.get(p)
                if existing_item is not None:
                    if existing_item.status in ('done', 'error', 'cancelled'):
                        # 已完成条目重新入队时，重置状态以便再次分析
                        existing_item.status = 'pending'
                        existing_item.processed = 0
                        existing_item.total = 0
                        existing_item.error = ''
                        existing_item.start_time = None
                        existing_item.end_time = None
                        existing_item.paused_duration = 0.0
                        existing_item.pause_start_time = None
                        existing_item.current_filename = ''
                        existing_item.current_export_path = ''
                        existing_item.current_status_msg = ''
                        existing_item.current_overlay_rel = ''
                        existing_item.current_crops_rel = []
                        existing_item.current_detections = []
                        existing_item.current_quality_results = []
                        existing_item.current_species_results = []
                        existing_item.initial_processed = 0
                        existing_item.backend = ''
                        added += 1
                    # If already pending/running, leave it alone
                else:
                    name = os.path.basename(p.rstrip('/\\')) or p
                    new_item = _QueueItem(p, name)
                    self._items.append(new_item)
                    added += 1
            # 在持有锁的情况下检查并启动 worker，避免多线程并发 enqueue 时重复启动。
            if self._thread is None or not self._thread.is_alive():
                self._cancel_event.clear()
                self._pause_event.set()
                self._use_gpu = use_gpu
                self._wildlife_enabled = wildlife_enabled
                self._detection_threshold = float(detection_threshold)
                self._scene_time_threshold = float(scene_time_threshold)
                self._mask_threshold = float(mask_threshold)
                self._thread = threading.Thread(target=self._run, daemon=True, name='kestrel-queue')
                self._thread.start()
        return {'success': True, 'added': added}

    def pause(self) -> dict:
        with self._lock:
            self._pause_event.clear()
            running = next((it for it in self._items if it.status == 'running'), None)
            if running is not None and running.pause_start_time is None:
                running.pause_start_time = _time_mod.time()
        return {'success': True, 'paused': True}

    def resume(self) -> dict:
        with self._lock:
            running = next((it for it in self._items if it.status == 'running'), None)
            if running is not None and running.pause_start_time is not None:
                running.paused_duration += _time_mod.time() - running.pause_start_time
                running.pause_start_time = None
        self._pause_event.set()
        return {'success': True, 'paused': False}

    def cancel(self) -> dict:
        # 先在锁内更新所有 pending 条目状态，再设置事件。
        # 这样 worker 线程观察到 cancel 事件时，所有状态已经一致。
        with self._lock:
            for it in self._items:
                if it.status == 'pending':
                    it.status = 'cancelled'
            running = next((it for it in self._items if it.status == 'running'), None)
            if running is not None:
                running.current_status_msg = 'Cancelling\u2026'
        self._cancel_event.set()
        self._pause_event.set()  # 若处于暂停中则先解除暂停，让 worker 能响应 cancel
        return {'success': True}

    def clear_done(self) -> dict:
        with self._lock:
            self._items = [it for it in self._items if it.status not in ('done', 'error', 'cancelled')]
        return {'success': True}

    def remove_pending_item(self, path: str) -> dict:
        """Remove a single pending item from the queue by path."""
        with self._lock:
            idx = next((i for i, it in enumerate(self._items)
                        if it.path == path and it.status == 'pending'), None)
            if idx is None:
                return {'success': False, 'error': 'Item not found or not pending'}
            self._items.pop(idx)
        return {'success': True}

    def reorder_pending(self, ordered_paths: list) -> dict:
        """Reorder pending items to match the given path order."""
        with self._lock:
            pending = [it for it in self._items if it.status == 'pending']
            non_pending = [it for it in self._items if it.status != 'pending']
            path_to_item = {it.path: it for it in pending}
            reordered = []
            for p in ordered_paths:
                if p in path_to_item:
                    reordered.append(path_to_item.pop(p))
            for it in pending:
                if it.path in path_to_item:
                    reordered.append(it)
            self._items = non_pending + reordered
        return {'success': True}

    # ---- internal ----

    def _run(self):
        if self._pipeline is None:
            cls = _get_pipeline_class()
            if cls is None:
                with self._lock:
                    for it in self._items:
                        if it.status in ('pending', 'running'):
                            it.status = 'error'
                            it.error = f'Pipeline unavailable: {_pipeline_import_error}'
                log('[queue] Pipeline unavailable, aborting:', _pipeline_import_error)
                return
            try:
                self._pipeline = cls(use_gpu=self._use_gpu)
            except Exception as exc:
                with self._lock:
                    for it in self._items:
                        if it.status in ('pending', 'running'):
                            it.status = 'error'
                            it.error = f'Pipeline init failed: {exc}'
                log('[queue] Pipeline constructor raised:', exc)
                return

        while not self._cancel_event.is_set():
            with self._lock:
                item = next((it for it in self._items if it.status == 'pending'), None)
            if item is None:
                break

            with self._lock:
                item.status = 'running'
                item.start_time = _time_mod.time()
                item.initial_processed = 0

            try:
                current_settings = load_persisted_settings()
                if current_settings.get('active_analysis_path') != item.path:
                    current_settings['active_analysis_path'] = item.path
                    save_persisted_settings(current_settings)
            except Exception:
                pass

            try:
                def _on_progress(processed, total, _it=item):
                    with self._lock:
                        if _it.initial_processed == 0 and processed > 0 and _it.processed == 0:
                            _it.initial_processed = processed
                        _it.processed = processed
                        _it.total = total

                def _on_status(msg, _it=item):
                    with self._lock:
                        _it.current_status_msg = msg
                        # Set backend after models are loaded
                        if not _it.backend and self._pipeline is not None:
                            try:
                                _it.backend = self._pipeline.detector.backend
                            except Exception:
                                pass
                    log(f'[queue:{_it.name}]', msg)

                def _on_thumbnail(data, _it=item):
                    with self._lock:
                        _it.current_filename = data.get('filename', '')
                        export_rel = data.get('export_path', '')
                        _it.current_export_path = export_rel.replace('\\', '/')
                        _it.current_overlay_rel = ''
                        _it.current_crops_rel = []
                        _it.current_detections = []
                        _it.current_quality_results = []
                        _it.current_species_results = []

                def _on_detection(data, _it=item):
                    import cv2 as _cv2
                    overlay_np = data.get('overlay')
                    rel = ''
                    if overlay_np is not None:
                        overlay_path = os.path.join(_it.path, '.lingjian', 'export',
                                                     '__live_overlay.jpg')
                        try:
                            os.makedirs(os.path.dirname(overlay_path), exist_ok=True)
                            _cv2.imwrite(overlay_path,
                                         _cv2.cvtColor(overlay_np, _cv2.COLOR_RGB2BGR),
                                         [_cv2.IMWRITE_JPEG_QUALITY, 80])
                            rel = os.path.relpath(overlay_path, _it.path).replace('\\', '/')
                        except Exception:
                            pass
                    with self._lock:
                        _it.current_overlay_rel = rel

                def _on_crops(data, _it=item):
                    import cv2 as _cv2
                    crops = data.get('crops') or []
                    confidences = data.get('confidences') or []
                    saved_rels = []
                    export_dir = os.path.join(_it.path, '.lingjian', 'export')
                    try:
                        os.makedirs(export_dir, exist_ok=True)
                    except Exception:
                        pass
                    for idx, crop in enumerate(crops[:5]):
                        if crop is None:
                            continue
                        cp = os.path.join(export_dir, f'__live_crop_{idx}.jpg')
                        try:
                            _cv2.imwrite(cp,
                                         _cv2.cvtColor(crop, _cv2.COLOR_RGB2BGR),
                                         [_cv2.IMWRITE_JPEG_QUALITY, 85])
                            saved_rels.append(
                                os.path.relpath(cp, _it.path).replace('\\', '/'))
                        except Exception:
                            pass
                    with self._lock:
                        _it.current_crops_rel = saved_rels
                        _it.current_detections = [
                            {'confidence': float(c)} for c in confidences[:5]]

                def _on_quality(data, _it=item):
                    incoming = list(data.get('results') or [])
                    normalized = []
                    for entry in incoming:
                        if not isinstance(entry, dict):
                            continue
                        raw_quality = entry.get('quality', -1)
                        try:
                            quality = float(raw_quality)
                        except (TypeError, ValueError):
                            quality = -1.0
                        raw_rating = _quality_to_raw_rating(quality)
                        normalized.append({
                            'quality': quality,
                            'raw_rating': raw_rating,
                            # Keep legacy field for compatibility with existing UI readers.
                            'rating': raw_rating,
                        })
                    with self._lock:
                        _it.current_quality_results = normalized

                def _on_species(data, _it=item):
                    with self._lock:
                        _it.current_species_results = list(data.get('results') or [])

                self._pipeline.process_folder(
                    item.path,
                    pause_event=self._pause_event,
                    cancel_event=self._cancel_event,
                    callbacks={
                        'on_status': _on_status,
                        'on_progress': _on_progress,
                        'on_thumbnail': _on_thumbnail,
                        'on_detection': _on_detection,
                        'on_crops': _on_crops,
                        'on_quality': _on_quality,
                        'on_species': _on_species,
                    },
                    analyzer_name='visualizer-queue',
                    wildlife_enabled=self._wildlife_enabled,
                    detection_threshold=self._detection_threshold,
                    scene_time_threshold=self._scene_time_threshold,
                    mask_threshold=self._mask_threshold,
                )
                with self._lock:
                    if self._cancel_event.is_set():
                        item.status = 'cancelled'
                        item.end_time = _time_mod.time()
                    else:
                        item.status = 'done'
                        item.end_time = _time_mod.time()
                        if item.total > 0:
                            item.processed = item.total
            except Exception as exc:
                log(f'[queue] Error processing {item.path!r}:', exc)
                with self._lock:
                    item.status = 'error'
                    item.end_time = _time_mod.time()
                    item.error = str(exc)

        log('[queue] Run thread finished.')


# Module-level singleton — shared across Api and Handler
_queue_manager = QueueManager()
