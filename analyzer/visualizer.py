#!/usr/bin/env python3
"""Standalone local web server for the Project Kestrel visualizer (supersedes backend/editor_bridge.py).

Features:
 - Serves the existing visualizer.html (and any static assets in the folder).
 - Exposes the /open endpoint (same contract as backend/editor_bridge.py) so the
   web UI can open originals in the configured editor.
 - Intended to be frozen into a single executable with PyInstaller.

Usage (development):
    python visualizer/visualizer.py --port 8765 --root C:\Photos\Trip

After starting it will open the default browser at http://127.0.0.1:<port>/ .

Build single-file EXE (example):
    pyinstaller --onefile --name kestrel_viz visualizer/visualizer.py

Optionally set env vars (same as editor_bridge):
  KESTREL_ALLOWED_ROOT=C:\Photos\Trip  (restrict paths)
  KESTREL_BRIDGE_TOKEN=secret              (require auth header)
  KESTREL_ALLOWED_EXTENSIONS=.cr3,.jpg,... (override allowed list)
  KESTREL_ALLOW_ANY_EXTENSION=1            (disable extension filtering)

"""

from __future__ import annotations

WEBVIEW_IMPORT_SUCCESS = False
try:
    import webview  # type: ignore
    WEBVIEW_IMPORT_SUCCESS = True
except Exception:
    pass

import argparse
import base64
import json
import mimetypes
import os
import shutil
import sys
import subprocess
import webbrowser

import secrets
import time as _time_mod
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
import threading
from urllib.parse import urlparse
from typing import Set

# Telemetry — failsafe import (never blocks startup)
try:
    import kestrel_telemetry as _telemetry
except ImportError:
    try:
        from analyzer import kestrel_telemetry as _telemetry
    except ImportError:
        _telemetry = None  # type: ignore[assignment]

HOST = '127.0.0.1'

# ---------------------------------------------------------------------------
# Optional: AnalysisPipeline from the sibling analyzer module.
# We do a lightweight directory check at import time but defer the actual
# pipeline/ML import until analysis is first requested, so the visualizer
# starts quickly when the user only wants to browse already-analyzed photos.
# ---------------------------------------------------------------------------
_pipeline_import_error = ''
_AnalysisPipeline = None   # populated lazily on first use


def _ensure_pipeline_path() -> bool:
    """Insert the analyzer package directory into sys.path if present."""
    script_dir = os.path.dirname(os.path.abspath(__file__))
    for candidate in [
        # When visualizer.py lives in visualizer/ (old layout) the
        # ../analyzer candidate points to the analyzer package. When
        # visualizer.py lives in analyzer/ (merged layout) the
        # script_dir itself contains kestrel_analyzer. Include both.
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


# Lightweight check: just look for the kestrel_analyzer directory (no ML imports)
_PIPELINE_AVAILABLE = _ensure_pipeline_path()
if not _PIPELINE_AVAILABLE:
    _pipeline_import_error = 'kestrel_analyzer package not found alongside the visualizer (expected kestrel_analyzer in repo)'


def _get_pipeline_class():
    """Import and cache AnalysisPipeline on first call (deferred ML import)."""
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


# ---------------------------------------------------------------------------
# Analysis Queue
# ---------------------------------------------------------------------------
class _QueueItem:
    __slots__ = ('path', 'name', 'status', 'processed', 'total', 'error',
                 'start_time', 'end_time', 'paused_duration', 'pause_start_time',
                 'current_filename', 'current_export_path', 'current_status_msg',
                 'current_overlay_rel', 'current_crops_rel', 'current_detections',
                 'current_quality_results', 'current_species_results',
                 'initial_processed')

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
        self.initial_processed: int = 0  # files already done before this session

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

    # ---- public read-only properties ----

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

    # ---- control ----

    def enqueue(self, paths: list, use_gpu: bool = True) -> dict:
        if not _PIPELINE_AVAILABLE:
            return {'success': False, 'error': f'Analyzer unavailable: {_pipeline_import_error}'}
        with self._lock:
            path_to_item = {it.path: it for it in self._items}
            added = 0
            for p in paths:
                existing_item = path_to_item.get(p)
                if existing_item is not None:
                    if existing_item.status in ('done', 'error', 'cancelled'):
                        # Reset finalized item so it can be re-processed
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
                        added += 1
                    # If already pending/running, leave it alone
                else:
                    name = os.path.basename(p.rstrip('/\\')) or p
                    new_item = _QueueItem(p, name)
                    self._items.append(new_item)
                    added += 1
        if not self.is_running:
            self._cancel_event.clear()
            self._pause_event.set()
            self._use_gpu = use_gpu
            self._thread = threading.Thread(target=self._run, daemon=True, name='kestrel-queue')
            self._thread.start()
        return {'success': True, 'added': added}

    def pause(self) -> dict:
        self._pause_event.clear()
        with self._lock:
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
        # Request cancellation of remaining work. Wake any paused worker so it
        # can observe the cancel event and exit before starting the next image.
        self._cancel_event.set()
        self._pause_event.set()  # unblock any pause-wait so thread can observe cancel
        with self._lock:
            for it in self._items:
                if it.status == 'pending':
                    it.status = 'cancelled'
            # Mark running item as cancelling so UI updates immediately
            running = next((it for it in self._items if it.status == 'running'), None)
            if running is not None:
                running.current_status_msg = 'Cancelling…'
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
        """Reorder pending items to match the given path order.
        Non-pending items keep their positions; pending items are
        rearranged in the order specified by *ordered_paths*."""
        with self._lock:
            pending = [it for it in self._items if it.status == 'pending']
            non_pending = [it for it in self._items if it.status != 'pending']
            path_to_item = {it.path: it for it in pending}
            reordered = []
            for p in ordered_paths:
                if p in path_to_item:
                    reordered.append(path_to_item.pop(p))
            # Append any pending items not in ordered_paths at the end
            for it in pending:
                if it.path in path_to_item:
                    reordered.append(it)
            # Rebuild: non-pending first (running, done, etc.), then reordered pending
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
            self._pipeline = cls(use_gpu=self._use_gpu)

        while not self._cancel_event.is_set():
            with self._lock:
                item = next((it for it in self._items if it.status == 'pending'), None)
            if item is None:
                break

            with self._lock:
                item.status = 'running'
                item.start_time = _time_mod.time()
                item.initial_processed = 0  # will be set by first progress callback

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
                        # Capture the initial processed count on the very first
                        # progress callback — this represents files already
                        # analyzed in previous sessions that were skipped.
                        if _it.initial_processed == 0 and processed > 0 and _it.processed == 0:
                            _it.initial_processed = processed
                        _it.processed = processed
                        _it.total = total

                def _on_status(msg, _it=item):
                    with self._lock:
                        _it.current_status_msg = msg
                    log(f'[queue:{_it.name}]', msg)

                def _on_thumbnail(data, _it=item):
                    with self._lock:
                        _it.current_filename = data.get('filename', '')
                        export_rel = data.get('export_path', '')
                        _it.current_export_path = export_rel.replace('\\', '/')
                        # Reset per-image live fields when a new image starts
                        _it.current_overlay_rel = ''
                        _it.current_crops_rel = []
                        _it.current_detections = []
                        _it.current_quality_results = []
                        _it.current_species_results = []

                def _on_detection(data, _it=item):
                    import cv2 as _cv2  # available: kestrel_analyzer loaded successfully
                    overlay_np = data.get('overlay')
                    rel = ''
                    if overlay_np is not None:
                        overlay_path = os.path.join(_it.path, '.kestrel', 'export',
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
                    export_dir = os.path.join(_it.path, '.kestrel', 'export')
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
                    with self._lock:
                        _it.current_quality_results = list(data.get('results') or [])

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
                # Send per-folder analytics (failsafe, non-blocking)
                self._send_folder_analytics(item)
            except Exception as exc:
                log(f'[queue] Error processing {item.path!r}:', exc)
                with self._lock:
                    item.status = 'error'
                    item.end_time = _time_mod.time()
                    item.error = str(exc)
                # Still send analytics for errored folders
                self._send_folder_analytics(item)

        log('[queue] Run thread finished.')

    def _send_folder_analytics(self, item):
        """Send per-folder analytics (if opted-in) and completion telemetry (non-optional)."""
        try:
            if _telemetry is None:
                return
            settings = load_persisted_settings()
            machine_id = _telemetry.get_machine_id(settings)
            version = _telemetry._read_version()

            # 1. Non-optional basic completion telemetry (total photos analyzed)
            files_this_session = max(0, item.processed - item.initial_processed)

            # Compute active time excluding pauses (used in both telemetry and analytics)
            elapsed = 0.0
            if item.start_time is not None:
                end = item.end_time if item.end_time is not None else _time_mod.time()
                elapsed = max(0.0, (end - item.start_time) - item.paused_duration)

            avg_time_per_file_s = elapsed / files_this_session if files_this_session > 0 else 0.0
            _telemetry.send_analysis_completion_telemetry(
                files_analyzed=files_this_session,
                machine_id=machine_id,
                version=version,
                avg_time_per_file_s=avg_time_per_file_s,
            )

            # Update Kestrel Impact cumulative stats in persisted settings
            settings['kestrel_impact_total_files'] = settings.get('kestrel_impact_total_files', 0) + files_this_session
            settings['kestrel_impact_total_seconds'] = round(
                settings.get('kestrel_impact_total_seconds', 0.0) + elapsed, 1
            )
            save_persisted_settings(settings)
            print(f"[impact] total_files={settings['kestrel_impact_total_files']} total_hours={round(settings['kestrel_impact_total_seconds']/3600,2)}", flush=True)

            # 2. Optional detailed analytics
            was_cancelled = (item.status == 'cancelled')

            # Gather file stats from disk
            stats = _telemetry.collect_folder_stats(
                item.path, files_this_session, item.total
            )

            analytics_payload = {
                'folder_path': item.path,
                'files_analyzed': files_this_session,
                'total_files': item.total,
                'active_compute_time_s': elapsed,
                'file_sizes_kb': stats.get('file_sizes_kb', []),
                'file_formats': stats.get('file_formats', {}),
                'was_cancelled': was_cancelled,
                'machine_id': machine_id,
                'version': version
            }

            if not settings.get('analytics_consent_shown', False):
                settings['pending_analytics'] = analytics_payload
                save_persisted_settings(settings)
                print("[analytics] Consent not yet shown; cached analytics payload.", flush=True)
            elif settings.get('analytics_opted_in', False):
                print("[analytics] Sending folder analytics for", item.path, "files_analyzed:", files_this_session, "elapsed_s:", round(elapsed, 1), flush=True)
                _telemetry.send_folder_analytics(**analytics_payload)
        except Exception:
            pass  # failsafe — never disrupt queue operation


_queue_manager = QueueManager()

# --- Security / behavior configuration (env override matches editor_bridge) ---
ALLOWED_ROOT = os.environ.get('KESTREL_ALLOWED_ROOT')
if ALLOWED_ROOT:
    ALLOWED_ROOT = os.path.abspath(os.path.expanduser(ALLOWED_ROOT))

AUTH_TOKEN = os.environ.get('KESTREL_BRIDGE_TOKEN')
if not AUTH_TOKEN:
    # Generate an ephemeral token per run; injected into served page via /bridge_config.js
    AUTH_TOKEN = secrets.token_urlsafe(32)
MAX_REQUEST_BYTES = int(os.environ.get('KESTREL_MAX_REQUEST_BYTES', '4096'))
ALLOWED_EDITORS: Set[str] = {'system', 'darktable', 'lightroom'}
_default_exts = ['.cr3', '.cr2', '.nef', '.arw', '.dng', '.raf', '.orf', '.rw2', '.sr2', '.jpg', '.jpeg', '.png', '.tif', '.tiff']
ALLOWED_EXTENSIONS: Set[str] = set(os.environ.get('KESTREL_ALLOWED_EXTENSIONS', ','.join(_default_exts)).lower().split(','))
ALLOW_ANY_EXTENSION = os.environ.get('KESTREL_ALLOW_ANY_EXTENSION') == '1'

# Cache for discovered darktable executable on Windows
_DARKTABLE_EXE = None

SETTINGS_FILENAME = 'settings.json'

def _find_darktable_exe() -> str:
    """Best-effort discovery of darktable.exe on Windows.

    Many installs place darktable in one of:
      C:\\Program Files\\darktable\\bin\\darktable.exe
      C:\\Program Files\\darktable\\darktable.exe
      C:\\Program Files (x86)\\darktable\\bin\\darktable.exe
    We also scan PATH entries. Falls back to 'darktable.exe'.
    """
    global _DARKTABLE_EXE
    if _DARKTABLE_EXE and os.path.exists(_DARKTABLE_EXE):
        return _DARKTABLE_EXE
    candidates = [
        os.path.join(os.environ.get('ProgramFiles', ''), 'darktable', 'bin', 'darktable.exe'),
        os.path.join(os.environ.get('ProgramFiles', ''), 'darktable', 'darktable.exe'),
        os.path.join(os.environ.get('ProgramFiles(x86)', ''), 'darktable', 'bin', 'darktable.exe'),
    ]
    # Add PATH search
    for p in os.environ.get('PATH', '').split(os.pathsep):
        if not p:
            continue
        exe = os.path.join(p, 'darktable.exe')
        candidates.append(exe)
    for exe in candidates:
        if exe and os.path.exists(exe):
            _DARKTABLE_EXE = exe
            return exe
    return 'darktable.exe'


def _get_user_data_dir() -> str:
    # Use a unified application folder name for Project Kestrel
    if sys.platform.startswith('win'):
        base = os.environ.get('LOCALAPPDATA') or os.environ.get('APPDATA') or os.path.expanduser('~')
        return os.path.join(base, 'ProjectKestrel')
    if sys.platform == 'darwin':
        return os.path.join(os.path.expanduser('~'), 'Library', 'Application Support', 'ProjectKestrel')
    base = os.environ.get('XDG_DATA_HOME') or os.path.join(os.path.expanduser('~'), '.local', 'share')
    return os.path.join(base, 'project-kestrel')


def _get_settings_path() -> str:
    return os.path.join(_get_user_data_dir(), SETTINGS_FILENAME)


def load_persisted_settings() -> dict:
    path = _get_settings_path()
    try:
        with open(path, 'r', encoding='utf-8') as f:
            data = json.load(f)
            return data if isinstance(data, dict) else {}
    except FileNotFoundError:
        return {}
    except Exception:
        return {}


def save_persisted_settings(data: dict) -> None:
    if not isinstance(data, dict):
        raise ValueError('Settings payload must be an object')
        
    # --- Flush pending analytics on consent ---
    if data.get('analytics_consent_shown', False) and 'pending_analytics' in data:
        pending = data.pop('pending_analytics')
        if data.get('analytics_opted_in', False) and _telemetry is not None:
            try:
                _telemetry.send_folder_analytics(**pending)
                log('[analytics] Flushed pending detailed analytics after opt-in.')
            except Exception as e:
                log(f'[analytics] Failed to flush pending analytics: {e}')
    # ------------------------------------------

    path = _get_settings_path()
    os.makedirs(os.path.dirname(path), exist_ok=True)
    tmp = path + '.tmp'
    try:
        # Remove any stale .tmp from a previous crash (Windows can't replace a locked file)
        try:
            os.remove(tmp)
        except FileNotFoundError:
            pass
        with open(tmp, 'w', encoding='utf-8') as f:
            json.dump(data, f, indent=2, sort_keys=True)
        os.replace(tmp, path)
    except OSError:
        # Fallback: write directly — non-atomic but safe for settings
        try:
            with open(path, 'w', encoding='utf-8') as f:
                json.dump(data, f, indent=2, sort_keys=True)
        except OSError as e:
            print(f'[settings] Failed to save settings: {e}', file=sys.stderr)


def log(*args):
    print('[serve]', *args, file=sys.stderr)


def _normalize(p: str) -> str:
    if not p:
        return ''
    p = os.path.expanduser(p)
    if (p.startswith('"') and p.endswith('"')) or (p.startswith("'") and p.endswith("'")):
        p = p[1:-1]
    return os.path.normpath(p)


def build_original_path(root: str, rel: str) -> str:
    if ALLOWED_ROOT:
        root = ALLOWED_ROOT
    else:
        root = _normalize(root) if root else ''
    rel = _normalize(rel) if rel else ''
    if not rel or os.path.isabs(rel):
        return ''
    base = os.path.join(root, rel) if root else rel
    return os.path.abspath(base)


def _is_within_root(path: str) -> bool:
    if not path:
        return False
    if not ALLOWED_ROOT:
        return True
    try:
        common = os.path.commonpath([os.path.realpath(path), os.path.realpath(ALLOWED_ROOT)])
        return common == os.path.realpath(ALLOWED_ROOT)
    except Exception:
        return False


def _extension_allowed(path: str) -> bool:
    if ALLOW_ANY_EXTENSION:
        return True
    _, ext = os.path.splitext(path)
    return ext.lower() in ALLOWED_EXTENSIONS


def launch(path: str, editor: str):
    path = os.path.abspath(path)
    print(f"[LAUNCH] requested path={path!r} editor={editor!r} platform={sys.platform}", flush=True)
    if not os.path.exists(path):
        print(f"[LAUNCH] ERROR: path does not exist: {path}", flush=True)
        raise FileNotFoundError(path)
    # Windows
    if sys.platform.startswith('win'):
        if editor == 'darktable':
            dt = _find_darktable_exe()
            try:
                subprocess.Popen([dt, path]); return
            except FileNotFoundError:
                log('darktable not found at', dt, 'falling back to system default')
        if editor == 'lightroom':
            # Common Lightroom Classic executable names/locations
            lr_candidates = [
                os.path.join(os.environ.get('ProgramFiles', ''), 'Adobe', 'Adobe Lightroom Classic', 'Lightroom.exe'),
                os.path.join(os.environ.get('ProgramFiles', ''), 'Adobe', 'Lightroom', 'Lightroom.exe'),
                'lightroom.exe',
                'Lightroom.exe'
            ]
            for exe in lr_candidates:
                if exe and os.path.exists(exe):
                    try:
                        subprocess.Popen([exe, path]); return
                    except Exception:
                        continue
            # Fallback to system default if Lightroom not found
        os.startfile(path)  # type: ignore[attr-defined]
        return
    # macOS
    if sys.platform == 'darwin':
        # Try editor-specific bundles first
        if editor == 'darktable':
            try:
                cmd = ['open', '-a', 'darktable', path]
                print(f"[LAUNCH] macOS: running: {cmd}", flush=True)
                subprocess.Popen(cmd)
                return
            except Exception as e:
                print(f"[LAUNCH] macOS darktable launch failed: {e}", flush=True)
        if editor == 'lightroom':
            try:
                cmd = ['open', '-a', 'Adobe Lightroom Classic', path]
                print(f"[LAUNCH] macOS: running: {cmd}", flush=True)
                subprocess.Popen(cmd)
                return
            except Exception as e:
                print(f"[LAUNCH] macOS lightroom launch failed: {e}", flush=True)

        # System default: try a couple of strategies and log results
        try:
            cmd = ['open', path]
            print(f"[LAUNCH] macOS: trying system open: {cmd}", flush=True)
            p = subprocess.run(cmd, check=False)
            print(f"[LAUNCH] macOS: open returned code {p.returncode}", flush=True)
            if p.returncode == 0:
                return
        except Exception as e:
            print(f"[LAUNCH] macOS: open() raised: {e}", flush=True)

        # Fallback: try AppleScript via osascript to make Finder open the file (sometimes works when 'open' prompts)
        try:
            script = f'tell application "Finder" to open (POSIX file "{path}")'
            print(f"[LAUNCH] macOS: trying osascript: {script}", flush=True)
            p = subprocess.run(['osascript', '-e', script], capture_output=True, text=True)
            print(f"[LAUNCH] macOS: osascript rc={p.returncode} stdout={p.stdout!r} stderr={p.stderr!r}", flush=True)
            if p.returncode == 0:
                return
        except Exception as e:
            print(f"[LAUNCH] macOS: osascript failed: {e}", flush=True)

        # Last resort: reveal the file in Finder
        try:
            cmd = ['open', '-R', path]
            print(f"[LAUNCH] macOS: fallback reveal: {cmd}", flush=True)
            subprocess.Popen(cmd)
            return
        except Exception as e:
            print(f"[LAUNCH] macOS: reveal fallback failed: {e}", flush=True)
        return
    # Linux / other
    if editor == 'darktable':
        try: subprocess.Popen(['flatpak', 'run', 'org.darktable.Darktable', path]); return
        except FileNotFoundError: pass
    if editor == 'lightroom':
        # Linux users may have a wrapper script named lightroom; attempt it
        try: subprocess.Popen(['lightroom', path]); return
        except FileNotFoundError: pass
    subprocess.Popen(['xdg-open', path])
class Api:
    """JavaScript API exposed to webview for native file/folder operations."""

    # Extension → MIME type map used by read_image_file (avoids mimetypes.guess_type overhead)
    _MIME_MAP: dict = {
        '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg',
        '.png': 'image/png',  '.gif': 'image/gif',
        '.webp': 'image/webp',
        '.tif': 'image/tiff', '.tiff': 'image/tiff',
    }

    def __init__(self):
        # Cache os.path.realpath(root_path) — root_path is constant for the session
        # but realpath() does a GetFinalPathNameByHandle syscall on Windows each time.
        self._realpath_cache: dict = {}

    def _root_realpath(self, root_path: str) -> str:
        """Return os.path.realpath(root_path), cached for the lifetime of this Api."""
        if root_path not in self._realpath_cache:
            self._realpath_cache[root_path] = os.path.realpath(root_path)
        return self._realpath_cache[root_path]

    def get_legal_status(self) -> dict:
        """Check if the user has agreed to the terms and if install telemetry was sent."""
        settings = load_persisted_settings()
        agreed = settings.get('legal_agreed_version', '') != ''
        install_sent = settings.get('installed_telemetry_sent', False)
        log(f'[legal] get_legal_status: agreed={agreed}, install_sent={install_sent}')
        return {
            'agreed': agreed,
            'install_sent': install_sent
        }

    def agree_to_legal(self):
        """Mark legal agreement as accepted and trigger installation telemetry if needed."""
        settings = load_persisted_settings()
        version = _telemetry._read_version() if _telemetry else 'unknown'
        settings['legal_agreed_version'] = version
        log(f'[legal] User agreed to terms (version {version})')
        
        # Trigger installation telemetry on first agreement
        if not settings.get('installed_telemetry_sent', False):
            if _telemetry:
                mid = _telemetry.get_machine_id(settings)
                _telemetry.send_installation_telemetry(mid, version=version)
                settings['installed_telemetry_sent'] = True
                log('[legal] Initial installation telemetry triggered.')
        
        save_persisted_settings(settings)
        return {'success': True}
    
    def choose_directory(self):
        """Open native folder picker dialog.
        Returns: absolute path to selected folder, or None if cancelled.
        """
        print(f"[API] choose_directory() called (platform: {sys.platform})", flush=True)
        try:
            if sys.platform == 'darwin':
                # macOS: Use AppleScript to show folder picker
                import subprocess
                script = 'POSIX path of (choose folder with prompt "Select folder containing analyzed photos")'
                result = subprocess.run(
                    ['osascript', '-e', script],
                    capture_output=True,
                    text=True,
                    timeout=120
                )
                if result.returncode == 0 and result.stdout.strip():
                    selected_path = result.stdout.strip()
                    print(f"[API] choose_directory() -> Success: {selected_path}", flush=True)
                    return selected_path
                print("[API] choose_directory() -> Cancelled by user", flush=True)
                return None
            elif sys.platform.startswith('win'):
                # Windows: Use tkinter folder dialog
                import tkinter as tk
                from tkinter import filedialog
                root = tk.Tk()
                root.withdraw()  # Hide the root window
                root.attributes('-topmost', True)  # Bring dialog to front
                folder = filedialog.askdirectory(title="Select folder containing analyzed photos")
                root.destroy()
                if folder:
                    print(f"[API] choose_directory() -> Success: {folder}", flush=True)
                    return folder
                else:
                    print("[API] choose_directory() -> Cancelled by user", flush=True)
                    return None
            else:
                # Linux: Use tkinter as well
                import tkinter as tk
                from tkinter import filedialog
                root = tk.Tk()
                root.withdraw()
                folder = filedialog.askdirectory(title="Select folder containing analyzed photos")
                root.destroy()
                if folder:
                    print(f"[API] choose_directory() -> Success: {folder}", flush=True)
                    return folder
                else:
                    print("[API] choose_directory() -> Cancelled by user", flush=True)
                    return None
        except Exception as e:
            print(f"[API] choose_directory() -> Error: {e}", flush=True)
            log(f"Error in choose_directory: {e}")
            return None
    
    def read_kestrel_csv(self, folder_path):
        """Read the kestrel_database.csv from the given folder path.
        
        Args:
            folder_path: Absolute path to folder (may be parent folder or .kestrel folder itself)
            
        Returns:
            dict with 'success': bool, 'data': str (CSV content), 'error': str, 'path': str, 'root': str
        """
        print(f"[API] read_kestrel_csv() called with folder_path: {folder_path}", flush=True)
        try:
            import os
            
            # Normalize path: remove trailing separators to ensure reliable basename detection
            folder_path = folder_path.strip()
            while folder_path and folder_path[-1] in ('/', '\\'):
                folder_path = folder_path[:-1]
            
            if not folder_path:
                raise ValueError("Empty folder path")
            
            print(f"[API] Normalized folder_path: {folder_path}", flush=True)
            
            # Determine if this IS the .kestrel folder or contains one
            folder_name = os.path.basename(folder_path)
            print(f"[API] Folder name: '{folder_name}'", flush=True)
            
            is_kestrel_folder = (folder_name == '.kestrel')
            print(f"[API] Is .kestrel folder: {is_kestrel_folder}", flush=True)
            
            if is_kestrel_folder:
                # User selected the .kestrel folder directly
                csv_path = os.path.join(folder_path, 'kestrel_database.csv')
                parent_folder = os.path.dirname(folder_path)
                print(f"[API] Selected .kestrel folder directly. Parent: {parent_folder}", flush=True)
            else:
                # User selected a parent folder; look for .kestrel subfolder
                csv_path = os.path.join(folder_path, '.kestrel', 'kestrel_database.csv')
                parent_folder = folder_path
                print(f"[API] Selected parent folder. Will look for .kestrel subfolder.", flush=True)
            
            if not os.path.exists(csv_path):
                print(f"[API] read_kestrel_csv() -> CSV not found at: {csv_path}", flush=True)
                return {
                    'success': False,
                    'error': f'Could not find kestrel_database.csv at: {csv_path}',
                    'path': csv_path,
                    'data': ''
                }
            
            with open(csv_path, 'r', encoding='utf-8') as f:
                data = f.read()
            
            print(f"[API] read_kestrel_csv() -> Success: Read {len(data)} bytes from {csv_path}", flush=True)
            return {
                'success': True,
                'data': data,
                'error': '',
                'path': csv_path,
                'root': parent_folder
            }
        except Exception as e:
            print(f"[API] read_kestrel_csv() -> Error: {e}", flush=True)
            return {
                'success': False,
                'error': str(e),
                'path': '',
                'data': ''
            }

    def inspect_folder(self, folder_path: str):
        """Return lightweight folder summary (total images, processed count).

        This defers importing heavy modules until explicitly requested.
        """
        try:
            import importlib
            inspector = None
            try:
                inspector = importlib.import_module('analyzer.folder_inspector')
            except Exception:
                try:
                    inspector = importlib.import_module('folder_inspector')
                except Exception:
                    inspector = None
            if inspector is None or not hasattr(inspector, 'inspect_folder'):
                return {'success': False, 'error': 'Inspector unavailable'}
            info = inspector.inspect_folder(folder_path)
            return {'success': True, 'info': info}
        except Exception as e:
            print(f"[API] inspect_folder() -> Error: {e}", flush=True)
            return {'success': False, 'error': str(e)}

    def inspect_folders(self, paths):
        """Batch-inspect multiple folders. Expects a list of absolute paths."""
        try:
            import importlib
            inspector = None
            try:
                inspector = importlib.import_module('analyzer.folder_inspector')
            except Exception:
                try:
                    inspector = importlib.import_module('folder_inspector')
                except Exception:
                    inspector = None
            if inspector is None or not hasattr(inspector, 'inspect_folders'):
                return {'success': False, 'error': 'Inspector unavailable', 'results': {}}
            if isinstance(paths, str):
                import json
                try:
                    paths = json.loads(paths)
                except Exception:
                    paths = [paths]
            results = inspector.inspect_folders(list(paths))
            return {'success': True, 'results': results}
        except Exception as e:
            print(f"[API] inspect_folders() -> Error: {e}", flush=True)
            return {'success': False, 'error': str(e), 'results': {}}
    
    def read_image_file(self, relative_path, root_path):
        """Read an image file and return it as base64-encoded data.
        
        Args:
            relative_path: Path relative to root (e.g., ".kestrel/export/photo.jpg") 
                          OR absolute path (for backward compatibility with old databases)
            root_path: Absolute path to root folder
            
        Returns:
            dict with 'success': bool, 'data': str (base64), 'mime': str, 'error': str
        """
        try:
            # Normalize separators
            root_path = root_path.rstrip('/\\')
            relative_path = relative_path.replace('\\', '/')

            # Resolve to full path
            if os.path.isabs(relative_path):
                full_path = relative_path
            else:
                relative_path = relative_path.lstrip('/\\')
                full_path = os.path.join(root_path, relative_path)

            # Security check — fast path: no '..' means path cannot escape root.
            # Slow path: resolve symlinks only when traversal sequences are present.
            if '..' in relative_path or os.path.isabs(relative_path):
                root_path_real = self._root_realpath(root_path)
                if not os.path.realpath(full_path).startswith(root_path_real):
                    return {'success': False, 'error': 'Path escapes root directory', 'data': '', 'mime': ''}

            # Read — let open() raise FileNotFoundError rather than a separate stat call
            try:
                with open(full_path, 'rb') as f:
                    data = f.read()
            except FileNotFoundError:
                return {'success': False, 'error': f'File not found: {full_path}', 'data': '', 'mime': ''}

            ext = os.path.splitext(full_path)[1].lower()
            mime_type = self._MIME_MAP.get(ext, 'image/jpeg')

            return {
                'success': True,
                'data': base64.b64encode(data).decode('ascii'),
                'mime': mime_type,
                'error': ''
            }
        except Exception as e:
            print(f"[API] read_image_file() -> Error: {e}", flush=True)
            return {'success': False, 'error': str(e), 'data': '', 'mime': ''}

    def list_subfolders(self, root_path: str, max_depth: int = 3):
        """Recursively list subfolders under root_path, flagging those with .kestrel.

        Args:
            root_path: Absolute path to the root folder to scan.
            max_depth:  How many directory levels to descend (1 = direct children only).

        Returns:
            dict with 'success': bool, 'tree': list[node], 'error': str
            Each node: {name, path, has_kestrel, children: [...]}
        """
        print(f"[API] list_subfolders() called: root='{root_path}' max_depth={max_depth}", flush=True)
        try:
            root_path = root_path.strip().rstrip('/\\')
            if not root_path or not os.path.isdir(root_path):
                return {'success': False, 'tree': [], 'error': f'Not a directory: {root_path}'}

            # Safety caps
            max_depth = max(1, min(int(max_depth), 6))
            # Total node limit to avoid huge trees. Make configurable via
            # env var KESTREL_TREE_NODE_LIMIT (defaults to 2000).
            try:
                MAX_NODES = max(100, int(os.environ.get('KESTREL_TREE_NODE_LIMIT', '2000')))
            except Exception:
                MAX_NODES = 2000
            node_count = [0]
            limit_reached = [False]

            def _scan(dir_path: str, depth: int) -> list:
                if depth < 1 or node_count[0] >= MAX_NODES:
                    return []
                result = []
                try:
                    entries = sorted(os.scandir(dir_path), key=lambda e: e.name.lower())
                except PermissionError:
                    return []
                for entry in entries:
                    # If we've already reached the node cap, stop scanning further
                    if node_count[0] >= MAX_NODES:
                        limit_reached[0] = True
                        break
                    if not entry.is_dir(follow_symlinks=False):
                        continue
                    name = entry.name
                    # Skip hidden and common system/tool folders
                    if name.startswith('.') or name in ('__pycache__', '$RECYCLE.BIN', 'System Volume Information'):
                        continue
                    node_count[0] += 1
                    full = entry.path
                    has_kestrel = os.path.isfile(os.path.join(full, '.kestrel', 'kestrel_database.csv'))
                    children = _scan(full, depth - 1)
                    result.append({
                        'name': name,
                        'path': full,
                        'has_kestrel': has_kestrel,
                        'children': children,
                    })
                return result

            tree = _scan(root_path, max_depth)
            root_has_kestrel = os.path.isfile(os.path.join(root_path, '.kestrel', 'kestrel_database.csv'))
            if limit_reached[0]:
                print(f"[API] list_subfolders() -> Node limit reached ({MAX_NODES}); scan truncated at {node_count[0]} nodes", flush=True)
            else:
                print(f"[API] list_subfolders() -> {node_count[0]} nodes found, root_has_kestrel={root_has_kestrel}", flush=True)
            return {
                'success': True,
                'tree': tree,
                'root_has_kestrel': root_has_kestrel,
                'error': '',
                'nodes': node_count[0],
                'truncated': bool(limit_reached[0]),
            }
        except Exception as e:
            print(f"[API] list_subfolders() -> Error: {e}", flush=True)
            return {'success': False, 'tree': [], 'error': str(e)}

    def write_kestrel_csv(self, folder_path: str, csv_content: str):
        """Write CSV content back to .kestrel/kestrel_database.csv for the given folder."""
        try:
            folder_name = os.path.basename(folder_path)
            if folder_name == '.kestrel':
                csv_path = os.path.join(folder_path, 'kestrel_database.csv')
            else:
                csv_path = os.path.join(folder_path, '.kestrel', 'kestrel_database.csv')
            if not os.path.exists(csv_path):
                print(f'[API] write_kestrel_csv({folder_path!r}) -> CSV not found: {csv_path}', flush=True)
                return {'success': False, 'error': f'CSV not found: {csv_path}'}
            with open(csv_path, 'w', encoding='utf-8', newline='') as f:
                f.write(csv_content)
            print(f'[API] write_kestrel_csv({folder_path!r}) -> {len(csv_content)} bytes written to {csv_path}', flush=True)
            return {'success': True, 'path': csv_path}
        except Exception as e:
            print(f'[API] write_kestrel_csv({folder_path!r}) -> Error: {e}', flush=True)
            return {'success': False, 'error': str(e)}

    def open_folder(self, path: str):
        """Open a folder in the system file browser (pywebview desktop mode)."""
        try:
            import platform as _platform
            p = _platform.system()
            if p == 'Windows':
                subprocess.Popen(['explorer', os.path.normpath(path)])
            elif p == 'Darwin':
                subprocess.Popen(['open', path])
            else:
                subprocess.Popen(['xdg-open', path])
            print(f'[API] open_folder({path!r}) -> success', flush=True)
            return {'success': True}
        except Exception as e:
            print(f'[API] open_folder({path!r}) -> Error: {e}', flush=True)
            return {'success': False, 'error': str(e)}

    def open_url(self, url: str):
        """Open a URL in the system default browser (pywebview desktop mode)."""
        try:
            webbrowser.open(url)
            print(f'[API] open_url({url!r}) -> success', flush=True)
            return {'success': True}
        except Exception as e:
            print(f'[API] open_url({url!r}) -> Error: {e}', flush=True)
            return {'success': False, 'error': str(e)}

    # ------------------------------------------------------------------ #
    #  Telemetry / Feedback API                                            #
    # ------------------------------------------------------------------ #

    def send_feedback(self, data):
        """Send feedback / bug report (async, failsafe). Called from JS."""
        try:
            if _telemetry is None:
                print('[API] send_feedback() -> telemetry unavailable', flush=True)
                return {'success': False, 'error': 'Telemetry module not available'}
            if not isinstance(data, dict):
                return {'success': False, 'error': 'Invalid data'}
            settings = load_persisted_settings()
            machine_id = _telemetry.get_machine_id(settings)
            # Try to include recent logs for bug reports
            log_tail = ''
            if data.get('include_logs', False):
                log_tail = _telemetry.get_recent_log_tail()
            _telemetry.send_feedback(
                report_type=data.get('type', 'general'),
                description=data.get('description', ''),
                contact=data.get('contact', ''),
                screenshot_b64=data.get('screenshot_b64', ''),
                log_tail=log_tail,
                machine_id=machine_id,
                version=_telemetry._read_version(),
            )
            print(f'[API] send_feedback() -> queued ({data.get("type", "general")})', flush=True)
            return {'success': True}
        except Exception as e:
            print(f'[API] send_feedback() -> Error: {e}', flush=True)
            return {'success': False, 'error': str(e)}

    def get_settings(self):
        """Return persisted settings, ensuring machine_id and version exist."""
        try:
            settings = load_persisted_settings()
            # Ensure machine_id exists
            if _telemetry is not None:
                _telemetry.get_machine_id(settings)
            # Ensure version is current
            if _telemetry is not None:
                settings['version'] = _telemetry._read_version()
            save_persisted_settings(settings)
            return {'success': True, 'settings': settings}
        except Exception as e:
            print(f'[API] get_settings() -> Error: {e}', flush=True)
            return {'success': False, 'error': str(e), 'settings': {}}

    def save_settings_data(self, settings_dict):
        """Persist settings from JavaScript (wraps save_persisted_settings)."""
        try:
            if not isinstance(settings_dict, dict):
                return {'success': False, 'error': 'Invalid settings'}
            save_persisted_settings(settings_dict)
            return {'success': True}
        except Exception as e:
            print(f'[API] save_settings_data() -> Error: {e}', flush=True)
            return {'success': False, 'error': str(e)}

    # ------------------------------------------------------------------ #
    #  Sample Sets API                                                     #
    # ------------------------------------------------------------------ #

    def get_sample_sets_paths(self):
        """Return absolute paths to bundled sample bird-photo sets.

        Works both during development (sample_sets/ next to the repo root)
        and in PyInstaller frozen builds (bundled via _MEIPASS).
        """
        try:
            candidates = []
            debug_info = []
            
            # 1) Frozen build: look inside several likely locations.
            #    PyInstaller may set sys._MEIPASS (a temp extraction dir) which
            #    doesn't contain the installer-installed _internal folder. When
            #    installed under Program Files we bundle sample_sets under
            #    <exe_dir>/_internal/sample_sets — so check both the _MEIPASS
            #    path and the real executable directory and its _internal subdir.
            is_frozen = getattr(sys, 'frozen', False)
            debug_info.append(f'[init] sys.frozen={is_frozen}')
            
            if is_frozen:
                debug_info.append('[frozen] Checking frozen build paths...')
                meipass = getattr(sys, '_MEIPASS', None)
                exe_dir = os.path.dirname(sys.executable) if hasattr(sys, 'executable') else None
                debug_info.append(f'[frozen] sys._MEIPASS={meipass}')
                debug_info.append(f'[frozen] sys.executable={sys.executable}')
                debug_info.append(f'[frozen] exe_dir={exe_dir}')
                
                candidates_checked = []
                bases = []
                
                # Build list of bases to check
                if meipass:
                    bases.append(meipass)
                    bases.append(os.path.join(meipass, '_internal'))
                if exe_dir:
                    bases.append(exe_dir)
                    bases.append(os.path.join(exe_dir, '_internal'))
                    # Also check parent of exe_dir (in case exe is in a subdir)
                    parent_exe = os.path.dirname(exe_dir)
                    if parent_exe and parent_exe != exe_dir:
                        bases.append(parent_exe)
                        bases.append(os.path.join(parent_exe, '_internal'))
                
                # Also consider analyzer/ subfolder as a fallback
                sources_internal = os.path.normpath(os.path.join(os.path.dirname(os.path.abspath(__file__)), '..', '_internal'))
                bases.append(sources_internal)
                
                debug_info.append(f'[frozen] Will check {len(bases)} base paths')
                for base in bases:
                    if not base or base in candidates_checked:
                        continue
                    candidates_checked.append(base)
                    d = os.path.join(base, 'sample_sets')
                    exists = os.path.isdir(d)
                    debug_info.append(f'[frozen] Checking {d}: exists={exists}')
                    if exists:
                        debug_info.append(f'[frozen] Found sample_sets at: {d}')
                        candidates.append(d)
                        break
                
                # If still not found, do an exhaustive search from exe_dir
                if not candidates and exe_dir:
                    debug_info.append(f'[frozen-fallback] Exhaustive search starting from {exe_dir}')
                    try:
                        start_dir = os.path.abspath(os.path.join(exe_dir, '..', '..'))
                        if not os.path.isdir(start_dir):
                            start_dir = exe_dir
                        for root, dirs, files in os.walk(start_dir):
                            # Limit depth to avoid searching too deep
                            depth = root[len(exe_dir):].count(os.sep)
                            if depth > 5:
                                del dirs[:]  # Don't recurse deeper
                                continue
                            if 'sample_sets' in dirs:
                                found = os.path.join(root, 'sample_sets')
                                debug_info.append(f'[frozen-fallback] Found sample_sets at: {found}')
                                candidates.append(found)
                                break
                    except Exception as e:
                        debug_info.append(f'[frozen-fallback] Exhaustive search failed: {e}')
            else:
                debug_info.append('[dev] Not a frozen build')
            
            # 2) Development: relative to CWD (repo root)
            cwd_candidate = os.path.join(os.getcwd(), 'sample_sets')
            cwd_exists = os.path.isdir(cwd_candidate)
            debug_info.append(f'[dev-cwd] {cwd_candidate}: exists={cwd_exists}')
            if cwd_exists and cwd_candidate not in candidates:
                candidates.append(cwd_candidate)
            
            # 3) Development: relative to this file
            file_candidate = os.path.join(os.path.dirname(os.path.abspath(__file__)), '..', 'sample_sets')
            file_candidate = os.path.normpath(file_candidate)
            file_exists = os.path.isdir(file_candidate)
            debug_info.append(f'[dev-file] {file_candidate}: exists={file_exists}')
            if file_exists and file_candidate not in candidates:
                candidates.append(file_candidate)
            
            # 4) If still nothing, do a last-resort search in common Windows Program Files locations
            if not candidates and sys.platform.startswith('win'):
                debug_info.append('[fallback] Starting Program Files search...')
                pf_paths = [
                    os.environ.get('ProgramFiles'),
                    os.environ.get('ProgramFiles(x86)'),
                    'C:\\Program Files',
                    'C:\\Program Files (x86)',
                ]
                for pf_base in pf_paths:
                    if not pf_base or not os.path.isdir(pf_base):
                        continue
                    # Look for Project Kestrel installations
                    for dirname in os.listdir(pf_base):
                        if 'kestrel' in dirname.lower():
                            kestrel_dir = os.path.join(pf_base, dirname)
                            # Check for sample_sets directly
                            direct = os.path.join(kestrel_dir, 'sample_sets')
                            if os.path.isdir(direct):
                                debug_info.append(f'[fallback] Found sample_sets at: {direct}')
                                candidates.append(direct)
                                break
                            # Check for _internal/sample_sets
                            internal = os.path.join(kestrel_dir, '_internal', 'sample_sets')
                            if os.path.isdir(internal):
                                debug_info.append(f'[fallback] Found sample_sets at: {internal}')
                                candidates.append(internal)
                                break
                    if candidates:
                        break

            debug_info.append(f'[collect] Found {len(candidates)} candidate roots')
            for idx, cand in enumerate(candidates):
                debug_info.append(f'[collect]   [{idx}] {cand}')

            if not candidates:
                error_msg = 'sample_sets folder not found'
                for line in debug_info:
                    print(line, flush=True)
                print(f'[API] get_sample_sets_paths() -> Error: {error_msg}', flush=True)
                return {'success': False, 'error': error_msg, 'paths': []}

            sample_root = candidates[0]
            debug_info.append(f'[api] Using root: {sample_root}')
            
            # List all items in sample_root
            try:
                items = os.listdir(sample_root)
                debug_info.append(f'[api] Root contains {len(items)} items: {items}')
            except Exception as e:
                debug_info.append(f'[api] Failed to list {sample_root}: {e}')
                items = []
            
            paths = []
            for name in sorted(items):
                full = os.path.join(sample_root, name)
                is_dir = os.path.isdir(full)
                kestrel_dir = os.path.join(full, '.kestrel')
                kestrel_exists = os.path.isdir(kestrel_dir)
                debug_info.append(f'[api]   Item "{name}": is_dir={is_dir}, has .kestrel={kestrel_exists}')
                
                if is_dir and kestrel_exists:
                    # Restore the read-only snapshot so tutorial changes don't persist
                    readonly_src = os.path.join(kestrel_dir, 'kestrel_database_readonly.csv')
                    db_dst       = os.path.join(kestrel_dir, 'kestrel_database.csv')
                    readonly_exists = os.path.isfile(readonly_src)
                    debug_info.append(f'[api]     readonly_src: {readonly_src} exists={readonly_exists}')
                    
                    if readonly_exists:
                        try:
                            import shutil
                            shutil.copy2(readonly_src, db_dst)
                            debug_info.append(f'[api]     Restored sample DB: {db_dst}')
                        except Exception as e:
                            debug_info.append(f'[api]     Failed to restore DB: {e}')
                    else:
                        debug_info.append(f'[api]     No readonly DB found at {readonly_src}')
                    
                    paths.append(full)
                    debug_info.append(f'[api]     Added path: {full}')
            
            # Print all debug info
            for line in debug_info:
                print(line, flush=True)
            print(f'[API] get_sample_sets_paths() -> {len(paths)} sets from {sample_root}', flush=True)
            return {'success': True, 'paths': paths}
        except Exception as e:
            import traceback
            print(f'[API] get_sample_sets_paths() -> Error: {e}', flush=True)
            print(f'[API] Traceback: {traceback.format_exc()}', flush=True)
            return {'success': False, 'error': str(e), 'paths': []}

    # ------------------------------------------------------------------ #
    #  Analysis Queue API (called from JavaScript in pywebview mode)       #
    # ------------------------------------------------------------------ #

    def start_analysis_queue(self, paths, use_gpu=True):
        """Enqueue folders for analysis. ``paths`` may be a JSON string or list."""
        try:
            if isinstance(paths, str):
                paths = json.loads(paths)
            if not isinstance(paths, list):
                return {'success': False, 'error': 'paths must be a list'}
            paths = [str(p).strip() for p in paths if p]
            return _queue_manager.enqueue(paths, use_gpu=bool(use_gpu))
        except Exception as e:
            print(f'[API] start_analysis_queue() -> Error: {e}', flush=True)
            return {'success': False, 'error': str(e)}

    def pause_analysis_queue(self):
        """Pause the running analysis queue."""
        return _queue_manager.pause()

    def resume_analysis_queue(self):
        """Resume a paused analysis queue."""
        return _queue_manager.resume()

    def cancel_analysis_queue(self):
        """Cancel the analysis queue (marks pending items as cancelled)."""
        return _queue_manager.cancel()

    def get_queue_status(self):
        """Return the current state of the analysis queue."""
        return _queue_manager.get_status()

    def clear_queue_done(self):
        """Remove finished/errored/cancelled items from the queue list."""
        return _queue_manager.clear_done()

    def remove_queue_item(self, path: str):
        """Remove a single pending item from the queue by path."""
        try:
            return _queue_manager.remove_pending_item(str(path))
        except Exception as e:
            return {'success': False, 'error': str(e)}

    def reorder_queue(self, ordered_paths):
        """Reorder pending queue items. ordered_paths is a JSON string or list of paths."""
        try:
            if isinstance(ordered_paths, str):
                ordered_paths = json.loads(ordered_paths)
            if not isinstance(ordered_paths, list):
                return {'success': False, 'error': 'ordered_paths must be a list'}
            return _queue_manager.reorder_pending(ordered_paths)
        except Exception as e:
            return {'success': False, 'error': str(e)}

    def is_analysis_running(self):
        """Return True if the analysis queue is actively running."""
        return {'running': _queue_manager.is_running}

    # ------------------------------------------------------------------ #
    #  Culling Assistant API                                               #
    # ------------------------------------------------------------------ #

    _main_window = None
    _culling_window = None
    _server_port = None

    def open_culling_window(self, root_path: str):
        """Open a new pywebview window for the Culling Assistant."""
        try:
            if not WEBVIEW_IMPORT_SUCCESS:
                return {'success': False, 'error': 'pywebview not available'}
            import webview as _wv
            folder_name = os.path.basename(root_path) if root_path else 'Unknown'
            port = self._server_port or 8765
            from urllib.parse import quote
            culling_url = f'http://{HOST}:{port}/culling.html?root={quote(root_path, safe="")}'
            
            # Debug: log available methods
            methods = [m for m in dir(self) if not m.startswith('_') and callable(getattr(self, m))]
            log(f'[culling] Creating window with Api instance')
            log(f'[culling] Available public methods (first 10): {methods[:10]}')
            log(f'[culling] read_kestrel_csv available: {"read_kestrel_csv" in methods}')
            
            win = _wv.create_window(
                f'Culling Assistant — {folder_name}',
                culling_url,
                js_api=self,
                width=1400,
                height=900,
            )
            self._culling_window = win
            log(f'[culling] Culling window created successfully')
            return {'success': True}
        except Exception as e:
            log(f'open_culling_window error: {e}')
            import traceback
            log(f'[culling] Traceback: {traceback.format_exc()}')
            return {'success': False, 'error': str(e)}

    def move_rejects_to_folder(self, root_path: str, filenames):
        """Move original photo files into _KESTREL_Rejects subfolder."""
        try:
            if not root_path or not os.path.isdir(root_path):
                return {'success': False, 'error': 'Invalid root path'}
            reject_dir = os.path.join(root_path, '_KESTREL_Rejects')
            os.makedirs(reject_dir, exist_ok=True)
            moved = []
            errors = []
            for fn in (filenames or []):
                src = os.path.join(root_path, fn)
                dst = os.path.join(reject_dir, fn)
                try:
                    if os.path.exists(src):
                        shutil.move(src, dst)
                        moved.append(fn)
                    else:
                        errors.append(f'{fn}: file not found')
                except Exception as e:
                    errors.append(f'{fn}: {e}')
            log(f'move_rejects: moved {len(moved)}, errors {len(errors)}')
            return {'success': True, 'moved': len(moved), 'errors': errors, 'reject_folder': reject_dir}
        except Exception as e:
            log(f'move_rejects_to_folder error: {e}')
            return {'success': False, 'error': str(e)}

    def write_xmp_metadata(self, root_path: str, image_data, overwrite_external: bool = False):
        """Write XMP sidecar files for each image, embedding star rating and culling label.

        Each entry in ``image_data`` is expected to be a dict with:
            filename  – bare filename (e.g. "IMG_0001.jpg")
            rating    – integer 0-5
            culled    – "accept" or "reject"

        XMP sidecar files are written as ``<basename>.xmp`` alongside the
        original in ``root_path``.

        Safety rules:
          - If a ``.xmp`` file already exists and was written by Kestrel
            (detected by the presence of the ``kestrel:`` namespace URI), it is
            safe to overwrite and will always be updated.
          - If a ``.xmp`` file already exists but was written by external
            software (Lightroom, darktable, Capture One, etc.) AND
            ``overwrite_external`` is False, the file is skipped and its
            filename is added to ``skipped_conflicts`` in the response so the
            caller can ask the user for confirmation.
          - If ``overwrite_external`` is True, external XMP files are also
            overwritten.

        Returns:
            { success, written, skipped_conflicts: [filenames], errors }

        TODO: Finalise the XMP schema / sidecar format once the research phase
        is complete.  The current template is minimal but valid.
        """
        _KESTREL_NS = 'http://ns.projectkestrel.app/xmp/1.0/'

        def _is_kestrel_xmp(path: str) -> bool:
            """Return True if the file appears to have been written by Kestrel."""
            try:
                with open(path, 'r', encoding='utf-8', errors='replace') as f:
                    content = f.read(4096)  # Only need the header/namespace section
                return _KESTREL_NS in content
            except Exception:
                return False

        try:
            if not root_path or not os.path.isdir(root_path):
                return {'success': False, 'error': 'Invalid root path'}

            written = 0
            skipped_conflicts = []
            errors = []

            for entry in (image_data or []):
                try:
                    filename = str(entry.get('filename', '')).strip()
                    if not filename:
                        errors.append('(blank filename): skipped')
                        continue

                    rating = int(entry.get('rating', 0) or 0)
                    rating = max(0, min(5, rating))

                    cull_status = str(entry.get('culled', 'accept')).lower()
                    adobe_label = 'Green' if cull_status == 'accept' else 'Red'

                    # Derive sidecar path: same directory, extension replaced with .xmp
                    base, _ext = os.path.splitext(filename)
                    xmp_filename = base + '.xmp'
                    xmp_path = os.path.join(root_path, xmp_filename)

                    # Safety check: if XMP already exists, verify origin
                    if os.path.exists(xmp_path):
                        if not _is_kestrel_xmp(xmp_path):
                            if not overwrite_external:
                                skipped_conflicts.append(xmp_filename)
                                log(f'write_xmp: skipping external XMP {xmp_path}')
                                continue
                            else:
                                log(f'write_xmp: overwriting external XMP {xmp_path} (user confirmed)')

                    # Minimal XMP sidecar template
                    # TODO: extend with full dc:, exif:, and Lightroom lr: namespaces
                    #       once the exact schema is confirmed.
                    xmp_content = (
                        '<?xpacket begin="\xef\xbb\xbf" id="W5M0MpCehiHzreSzNTczkc9d"?>\n'
                        '<x:xmpmeta xmlns:x="adobe:ns:meta/">\n'
                        '  <rdf:RDF xmlns:rdf="http://www.w3.org/1999/02/22-rdf-syntax-ns#">\n'
                        '    <rdf:Description rdf:about=""\n'
                        '        xmlns:xmp="http://ns.adobe.com/xap/1.0/"\n'
                        '        xmlns:xmpMM="http://ns.adobe.com/xap/1.0/mm/"\n'
                        f'        xmlns:kestrel="{_KESTREL_NS}">\n'
                        f'      <xmp:Rating>{rating}</xmp:Rating>\n'
                        f'      <xmp:Label>{adobe_label}</xmp:Label>\n'
                        f'      <kestrel:CullStatus>{cull_status}</kestrel:CullStatus>\n'
                        f'      <kestrel:SourceFile>{filename}</kestrel:SourceFile>\n'
                        '    </rdf:Description>\n'
                        '  </rdf:RDF>\n'
                        '</x:xmpmeta>\n'
                        '<?xpacket end="w"?>\n'
                    )

                    with open(xmp_path, 'w', encoding='utf-8') as f:
                        f.write(xmp_content)

                    written += 1
                    log(f'write_xmp: wrote {xmp_path}')

                except Exception as entry_err:
                    errors.append(f'{entry.get("filename", "?")}: {entry_err}')

            log(f'write_xmp_metadata: written={written}, conflicts={len(skipped_conflicts)}, errors={len(errors)}')
            return {
                'success': True,
                'written': written,
                'skipped_conflicts': skipped_conflicts,
                'errors': errors,
            }

        except Exception as e:
            log(f'write_xmp_metadata error: {e}')
            return {'success': False, 'error': str(e)}

    def undo_reject_move(self, root_path: str, filenames):
        """Move files back from _KESTREL_Rejects to the root folder."""
        try:
            reject_dir = os.path.join(root_path, '_KESTREL_Rejects')
            if not os.path.isdir(reject_dir):
                return {'success': False, 'error': '_KESTREL_Rejects folder not found'}
            restored = []
            errors = []
            for fn in (filenames or []):
                src = os.path.join(reject_dir, fn)
                dst = os.path.join(root_path, fn)
                try:
                    if os.path.exists(src):
                        shutil.move(src, dst)
                        restored.append(fn)
                    else:
                        errors.append(f'{fn}: not found in rejects')
                except Exception as e:
                    errors.append(f'{fn}: {e}')
            log(f'undo_reject_move: restored {len(restored)}, errors {len(errors)}')
            return {'success': True, 'restored': len(restored), 'errors': errors}
        except Exception as e:
            log(f'undo_reject_move error: {e}')
            return {'success': False, 'error': str(e)}

    def backup_kestrel_csv(self, root_path: str):
        """Copy kestrel_database.csv to kestrel_database_old.csv as backup."""
        try:
            kestrel_dir = os.path.join(root_path, '.kestrel')
            csv_path = os.path.join(kestrel_dir, 'kestrel_database.csv')
            backup_path = os.path.join(kestrel_dir, 'kestrel_database_old.csv')
            if not os.path.exists(csv_path):
                return {'success': False, 'error': 'kestrel_database.csv not found'}
            shutil.copy2(csv_path, backup_path)
            log(f'backup_kestrel_csv: backed up to {backup_path}')
            return {'success': True, 'backup_path': backup_path}
        except Exception as e:
            log(f'backup_kestrel_csv error: {e}')
            return {'success': False, 'error': str(e)}

    def restore_kestrel_csv_backup(self, root_path: str):
        """Restore kestrel_database_old.csv back to kestrel_database.csv."""
        try:
            kestrel_dir = os.path.join(root_path, '.kestrel')
            csv_path = os.path.join(kestrel_dir, 'kestrel_database.csv')
            backup_path = os.path.join(kestrel_dir, 'kestrel_database_old.csv')
            if not os.path.exists(backup_path):
                return {'success': False, 'error': 'kestrel_database_old.csv not found'}
            shutil.copy2(backup_path, csv_path)
            log(f'restore_kestrel_csv_backup: restored from {backup_path}')
            return {'success': True}
        except Exception as e:
            log(f'restore_kestrel_csv_backup error: {e}')
            return {'success': False, 'error': str(e)}

    def open_reject_folder(self, root_path: str):
        """Open the _KESTREL_Rejects folder in the system file browser."""
        reject_dir = os.path.join(root_path, '_KESTREL_Rejects')
        if os.path.isdir(reject_dir):
            return self.open_folder(reject_dir)
        return {'success': False, 'error': '_KESTREL_Rejects folder not found'}

    def notify_main_window_refresh(self):
        """Tell the main visualizer window to reload its data."""
        try:
            if not WEBVIEW_IMPORT_SUCCESS:
                return {'success': False, 'error': 'pywebview not available'}
            import webview as _wv
            if _wv.windows and len(_wv.windows) > 0:
                main_win = _wv.windows[0]
                main_win.evaluate_js('if(window.reloadCurrentFolders) window.reloadCurrentFolders();')
                return {'success': True}
            return {'success': False, 'error': 'No main window found'}
        except Exception as e:
            log(f'notify_main_window_refresh error: {e}')
            return {'success': False, 'error': str(e)}

    def read_raw_full(self, filename: str, root_path: str):
        """Process a RAW file and return full-resolution JPEG as base64.
        Results are cached in {root}/.kestrel/culling_TMP/ for fast subsequent loads.
        Falls back to read_image_file for non-RAW formats."""
        import os
        import base64
        from io import BytesIO

        try:
            # Resolve and security-check path
            full_path = os.path.join(root_path, filename)
            full_path_real = os.path.realpath(full_path)
            root_path_real = os.path.realpath(root_path)
            if not full_path_real.startswith(root_path_real):
                return {'success': False, 'error': 'Path escapes root directory'}
            if not os.path.exists(full_path):
                return {'success': False, 'error': f'File not found: {filename}'}

            raw_extensions = {'.cr2', '.cr3', '.nef', '.arw', '.dng', '.raf', '.orf', '.rw2', '.srw'}
            ext = os.path.splitext(filename)[1].lower()

            if ext not in raw_extensions:
                # Not RAW — use existing image reader
                return self.read_image_file(filename, root_path)

            # Check disk cache first
            cache_dir = os.path.join(root_path, '.kestrel', 'culling_TMP')
            cache_name = os.path.splitext(os.path.basename(filename))[0] + '_preview.jpg'
            cache_path = os.path.join(cache_dir, cache_name)

            if os.path.exists(cache_path):
                log(f'read_raw_full: Cache hit for {filename}')
                with open(cache_path, 'rb') as f:
                    b64 = base64.b64encode(f.read()).decode('ascii')
                return {'success': True, 'data': b64}

            # Process RAW with rawpy
            import rawpy
            from PIL import Image

            log(f'read_raw_full: Processing RAW file {filename}')
            with rawpy.imread(full_path) as raw:
                rgb = raw.postprocess(
                    use_camera_wb=True,
                    no_auto_bright=False,
                    output_bps=8,
                    fbdd_noise_reduction=rawpy.FBDDNoiseReductionMode.Off,
                )

            img = Image.fromarray(rgb)

            # Save to disk cache
            os.makedirs(cache_dir, exist_ok=True)
            buf = BytesIO()
            img.save(buf, format='JPEG', quality=82, optimize=False, progressive=False)
            jpg_bytes = buf.getvalue()
            with open(cache_path, 'wb') as f:
                f.write(jpg_bytes)

            b64 = base64.b64encode(jpg_bytes).decode('ascii')
            log(f'read_raw_full: Done, {len(jpg_bytes)//1024}KB JPEG ({img.width}x{img.height}), cached as {cache_name}')
            return {'success': True, 'data': b64}
        except Exception as e:
            log(f'read_raw_full error: {e}')
            return {'success': False, 'error': str(e)}

    def cleanup_culling_cache(self, root_path: str):
        """Remove the .kestrel/culling_TMP folder to free up space."""
        import os
        import shutil

        try:
            cache_dir = os.path.join(root_path, '.kestrel', 'culling_TMP')
            if os.path.exists(cache_dir):
                shutil.rmtree(cache_dir)
                log(f'cleanup_culling_cache: Removed {cache_dir}')
                return {'success': True}
            return {'success': True}  # Already doesn't exist
        except Exception as e:
            log(f'cleanup_culling_cache error: {e}')
            return {'success': False, 'error': str(e)}


class Handler(SimpleHTTPRequestHandler):
    # Serve from directory of this script (project root) by default.
    def translate_path(self, path: str) -> str:  # type: ignore[override]
        """Resolve file paths robustly across dev, frozen, and installed builds.
        
        Checks multiple locations:
        1. Normal CWD-relative translation (for dev mode)
        2. analyzer/ subfolder (for files like culling.html)
        3. _internal/analyzer/ (for PyInstaller frozen install in Program Files)
        """
        # Try the normal translation first
        resolved = super().translate_path(path)
        if os.path.exists(resolved):
            return resolved
        
        # If not found and path doesn't already contain /analyzer, try analyzer/ prefix
        if not path.startswith('/analyzer'):
            alt = super().translate_path('/analyzer' + path)
            if os.path.exists(alt):
                return alt
        
        # For frozen builds, also check _internal subdirectories
        if getattr(sys, 'frozen', False):
            # Try <exe_dir>/_internal/analyzer/<file>
            try:
                exe_dir = os.path.dirname(sys.executable)
                internal_dir = os.path.join(exe_dir, '_internal')
                alt_path = path.lstrip('/')
                alt = os.path.join(internal_dir, alt_path)
                if os.path.exists(alt):
                    return alt
                # If path already has /analyzer, also check _internal/analyzer/<file>
                if path.startswith('/analyzer'):
                    alt_path = path[1:]  # Strip leading /
                    alt = os.path.join(internal_dir, alt_path)
                    if os.path.exists(alt):
                        return alt
            except Exception:
                pass
            
            # Try _MEIPASS (PyInstaller temp extraction)
            meipass = getattr(sys, '_MEIPASS', None)
            if meipass:
                alt_path = path.lstrip('/')
                alt = os.path.join(meipass, alt_path)
                if os.path.exists(alt):
                    return alt
        
        # Return the original resolution (will 404 if file doesn't exist)
        return resolved

    def end_headers(self):  # Inject basic headers (no wildcard CORS; same-origin only)
        self.send_header('Cache-Control', 'no-store')
        super().end_headers()

    def do_GET(self):  # type: ignore[override]
        # Dynamic token/config injection script
        if self.path == '/bridge_config.js':
            body = (
                f"// Generated at runtime\n"
                f"window.__BRIDGE_TOKEN='{AUTH_TOKEN}';\n"
                f"window.__BRIDGE_ORIGIN=window.location.origin;\n"
            ).encode('utf-8')
            self.send_response(200)
            self.send_header('Content-Type', 'application/javascript')
            self.send_header('Cache-Control', 'no-store')
            self.end_headers()
            self.wfile.write(body)
            return
        if self.path == '/settings':
            self._json(200, {'ok': True, 'settings': load_persisted_settings()})
            return
        if self.path == '/queue/status':
            self._json(200, _queue_manager.get_status())
            return
        if self.path in ('/', '/index.html'):
            # Prefer analyzer/visualizer.html when present (merged layout).
            # Check multiple locations across dev, frozen, and installed builds.
            def _find_visualizer():
                # List of relative paths to try (from various base dirs)
                candidates = [
                    'analyzer/visualizer.html',
                    'visualizer.html',
                ]
                
                # Check from CWD
                for rel in candidates:
                    full = os.path.join(os.getcwd(), rel)
                    if os.path.exists(full):
                        return '/' + rel
                
                # Check from exe dir (frozen/installed)
                try:
                    exe_dir = os.path.dirname(sys.executable)
                    internal_dir = os.path.join(exe_dir, '_internal')
                    for rel in candidates:
                        full = os.path.join(internal_dir, rel)
                        if os.path.exists(full):
                            return '/' + rel
                except Exception:
                    pass
                
                # Check PyInstaller _MEIPASS
                meipass = getattr(sys, '_MEIPASS', None)
                if meipass:
                    for rel in candidates:
                        full = os.path.join(meipass, rel)
                        if os.path.exists(full):
                            return '/' + rel
                
                # Default fallback
                return '/analyzer/visualizer.html'
            
            self.path = _find_visualizer()
        return super().do_GET()

    def do_OPTIONS(self):  # Minimal preflight (only allow same-origin JS; token still required)
        origin = self.headers.get('Origin')
        if origin and origin != f'http://{HOST}:{self.server.server_port}':  # type: ignore[attr-defined]
            self.send_response(403); self.end_headers(); return
        self.send_response(204)
        self.send_header('Access-Control-Allow-Origin', origin or f'http://{HOST}:{self.server.server_port}')  # type: ignore[attr-defined]
        self.send_header('Access-Control-Allow-Headers', 'Content-Type,X-Bridge-Token')
        self.send_header('Access-Control-Allow-Methods', 'POST, OPTIONS')
        self.end_headers()

    def do_POST(self):  # type: ignore[override]
        parsed = urlparse(self.path)
        if parsed.path == '/open':
            self.handle_open()
        elif parsed.path == '/settings':
            self.handle_settings()
        elif parsed.path == '/feedback':
            self.handle_feedback()
        elif parsed.path == '/shutdown':
            self.handle_shutdown()
        elif parsed.path == '/queue/start':
            self.handle_queue_start()
        elif parsed.path in ('/queue/pause', '/queue/resume', '/queue/cancel', '/queue/clear'):
            self.handle_queue_control(parsed.path)
        else:
            self.send_response(404); self.end_headers(); self.wfile.write(b'{}')

    def _read_json(self):
        length = int(self.headers.get('Content-Length', 0))
        if length > MAX_REQUEST_BYTES:
            raise ValueError('Request too large')
        raw = self.rfile.read(length) if length else b''
        if not raw:
            return {}
        return json.loads(raw.decode('utf-8'))

    def _json(self, status: int, obj):
        body = json.dumps(obj).encode('utf-8')
        self.send_response(status)
        self.send_header('Content-Type', 'application/json')
        # Only echo same-origin to mitigate unsolicited cross-origin token use
        self.send_header('Access-Control-Allow-Origin', f'http://{HOST}:{self.server.server_port}')  # type: ignore[attr-defined]
        self.end_headers()
        self.wfile.write(body)

    def handle_open(self):
        if AUTH_TOKEN:
            token = self.headers.get('X-Bridge-Token') or ''
            if token != AUTH_TOKEN:
                self._json(401, {'ok': False, 'error': 'Unauthorized'}); return
        # Basic origin check (best-effort; Origin may be absent for some requests)
        origin = self.headers.get('Origin')
        expected_origin = f'http://{HOST}:{self.server.server_port}'  # type: ignore[attr-defined]
        if origin and origin != expected_origin:
            self._json(403, {'ok': False, 'error': 'Origin mismatch'}); return
        try:
            payload = self._read_json()
        except Exception as e:
            self._json(400, {'ok': False, 'error': str(e)}); return
        log('payload', payload)
        root = payload.get('root')
        rel = payload.get('relative')
        editor = (payload.get('editor') or 'system')
        if isinstance(editor, str):
            editor = editor.strip().lower()
        else:
            editor = 'system'
        if editor not in ALLOWED_EDITORS:
            editor = 'system'
        target = build_original_path(root, rel)
        log('open', editor, root, rel, '->', target)
        if not target:
            self._json(400, {'ok': False, 'error': 'Invalid path'}); return
        if not _is_within_root(target):
            self._json(403, {'ok': False, 'error': 'Path escapes allowed root'}); return
        if not os.path.exists(target):
            self._json(404, {
                'ok': False,
                'error': 'File not found',
                'target': target,
                'hint': 'Ensure Settings -> Local Root points to the folder containing your RAW files.'
            }); return
        if not _extension_allowed(target):
            self._json(415, {'ok': False, 'error': 'Extension not allowed', 'target': target, 'allowed': sorted(ALLOWED_EXTENSIONS)}); return
        try:
            launch(target, editor)
            self._json(200, {'ok': True, 'path': target})
        except Exception as e:
            self._json(500, {'ok': False, 'error': str(e)})

    def handle_shutdown(self):
        # Require token (always) to prevent CSRF/drive-by shutdown
        if AUTH_TOKEN:
            token = self.headers.get('X-Bridge-Token') or ''
            if token != AUTH_TOKEN:
                self._json(401, {'ok': False, 'error': 'Unauthorized'}); return
        log('Received shutdown request from client; scheduling server shutdown.')
        # Respond first, then shutdown asynchronously so reply is delivered
        self._json(200, {'ok': True, 'message': 'Shutting down'})
        def _shutdown():
            try:
                # slight delay to let response flush
                import time; time.sleep(0.25)
                self.server.shutdown()
            except Exception as e:  # noqa: BLE001
                log('Error during shutdown:', e)
        threading.Thread(target=_shutdown, daemon=True).start()

    def handle_settings(self):
        if AUTH_TOKEN:
            token = self.headers.get('X-Bridge-Token') or ''
            if token != AUTH_TOKEN:
                self._json(401, {'ok': False, 'error': 'Unauthorized'}); return
        origin = self.headers.get('Origin')
        expected_origin = f'http://{HOST}:{self.server.server_port}'  # type: ignore[attr-defined]
        if origin and origin != expected_origin:
            self._json(403, {'ok': False, 'error': 'Origin mismatch'}); return
        try:
            payload = self._read_json()
            settings = payload.get('settings') if isinstance(payload, dict) else None
            if not isinstance(settings, dict):
                raise ValueError('Invalid settings payload')
            save_persisted_settings(settings)
            self._json(200, {'ok': True})
        except Exception as e:
            self._json(400, {'ok': False, 'error': str(e)})

    def _check_auth(self) -> bool:
        """Return True if authenticated (or no token required). Sends 401 and returns False on failure."""
        if AUTH_TOKEN:
            token = self.headers.get('X-Bridge-Token') or ''
            if token != AUTH_TOKEN:
                self._json(401, {'ok': False, 'error': 'Unauthorized'})
                return False
        return True
    def handle_feedback(self):
        """Accept feedback/bug report submissions (browser-mode fallback)."""
        if not self._check_auth():
            return
        try:
            payload = self._read_json()
            if not isinstance(payload, dict):
                self._json(400, {'ok': False, 'error': 'Invalid payload'}); return
            if _telemetry is None:
                self._json(200, {'ok': True, 'note': 'Telemetry unavailable'}); return
            settings = load_persisted_settings()
            machine_id = _telemetry.get_machine_id(settings)
            log_tail = ''
            if payload.get('include_logs', False):
                log_tail = _telemetry.get_recent_log_tail()
            _telemetry.send_feedback(
                report_type=payload.get('type', 'general'),
                description=payload.get('description', ''),
                contact=payload.get('contact', ''),
                screenshot_b64=payload.get('screenshot_b64', ''),
                log_tail=log_tail,
                machine_id=machine_id,
                version=_telemetry._read_version(),
            )
            self._json(200, {'ok': True})
        except Exception as e:
            self._json(400, {'ok': False, 'error': str(e)})

    def handle_queue_start(self):
        if not self._check_auth():
            return
        try:
            payload = self._read_json()
            paths = payload.get('paths', []) if isinstance(payload, dict) else []
            use_gpu = bool(payload.get('use_gpu', True)) if isinstance(payload, dict) else True
            if not isinstance(paths, list):
                self._json(400, {'ok': False, 'error': '"paths" must be a list'}); return
            result = _queue_manager.enqueue(paths, use_gpu=use_gpu)
            self._json(200, {'ok': result['success'], **result})
        except Exception as e:
            self._json(400, {'ok': False, 'error': str(e)})

    def handle_queue_control(self, path: str):
        if not self._check_auth():
            return
        if path == '/queue/pause':
            self._json(200, {'ok': True, **_queue_manager.pause()})
        elif path == '/queue/resume':
            self._json(200, {'ok': True, **_queue_manager.resume()})
        elif path == '/queue/cancel':
            self._json(200, {'ok': True, **_queue_manager.cancel()})
        elif path == '/queue/clear':
            self._json(200, {'ok': True, **_queue_manager.clear_done()})
        else:
            self._json(404, {'ok': False, 'error': 'Not found'})


def parse_args():
    ap = argparse.ArgumentParser(description='Serve Project Kestrel visualizer with local /open bridge.')
    ap.add_argument('--port', type=int, default=8765, help='Port to listen on (default 8765)')
    ap.add_argument('--no-browser', action='store_true', help='Do not auto-open a browser window')
    ap.add_argument('--windowed', action='store_true', help='Open in a desktop window (requires pywebview) [default]')
    ap.add_argument('--no-windowed', action='store_true', help='Disable windowed mode and use the system browser')
    ap.add_argument('--root', default='', help='Default root folder for RAW originals (client can override unless KESTREL_ALLOWED_ROOT set)')
    return ap.parse_args()


def main():
    args = parse_args()
    # When visualizer.py is run from inside analyzer/ (merged layout) set
    # the working directory to the repository root so assets and shared
    # files (assets/, visualizer files) are served correctly.
    # If frozen by PyInstaller (onedir), prefer the bundled _internal folder
    # inside the distribution so static assets (visualizer.html, logos) are
    # served from the on-disk bundle.
    if getattr(sys, 'frozen', False):
        meipass = getattr(sys, '_MEIPASS', None) or os.path.dirname(sys.executable)
        candidate = os.path.join(meipass, '_internal')
        if os.path.isdir(candidate):
            os.chdir(candidate)
        elif meipass and os.path.isdir(meipass):
            os.chdir(meipass)
        else:
            # Fallback to repo-root relative when running unpacked
            os.chdir(os.path.join(os.path.dirname(os.path.abspath(__file__)), '..') or '.')
    else:
        os.chdir(os.path.join(os.path.dirname(os.path.abspath(__file__)), '..') or '.')
    server = ThreadingHTTPServer((HOST, args.port), Handler)
    log(f'Serving visualizer at http://{HOST}:{args.port}/  (Press Ctrl+C to stop)')
    log('Ephemeral bridge token (auto-injected):', AUTH_TOKEN[:8] + '…')

    # ── Settings init: ensure machine_id and version are persisted ──
    try:
        if _telemetry is not None:
            _init_settings = load_persisted_settings()
            _telemetry.get_machine_id(_init_settings)
            _init_settings['version'] = _telemetry._read_version()
            save_persisted_settings(_init_settings)
    except Exception:
        pass  # failsafe

    if args.root:
        log('Default root (client-supplied):', args.root)
    url = f'http://{HOST}:{args.port}/'
    if args.no_windowed:
        args.windowed = False
    else:
        args.windowed = True
    if args.windowed and not WEBVIEW_IMPORT_SUCCESS:
        log('pywebview not available; falling back to system browser')
        args.windowed = False
    else:
        log('Windowed mode enabled; using pywebview' if args.windowed else 'Windowed mode disabled; using system browser')
    if args.windowed:
        def _serve():
            try:
                server.serve_forever()
            except Exception:
                pass
        t = threading.Thread(target=_serve, daemon=True)
        t.start()
        try:
            log('Starting windowed UI via pywebview...')
            api = Api() # start maximized
            api._server_port = args.port
            win = webview.create_window('Project Kestrel', url, js_api=api, maximized=True)
            api._main_window = win

            # When the analysis queue is running, intercept the close event so the
            # window minimizes to the taskbar instead of killing mid-analysis.
            def _on_closing():
                # When an analysis is running or paused, prompt the user with
                # options to Minimize, Exit (cancel) or Cancel the close.
                if _queue_manager.is_running or _queue_manager.is_paused:
                    try:
                        # Use native Windows MessageBox if available for a simple
                        # three-button prompt. Fallback to tkinter dialog when not.
                        if sys.platform.startswith('win'):
                            import ctypes
                            MB_YESNOCANCEL = 0x00000003
                            MB_ICONQUESTION = 0x00000020
                            title = 'Analysis in progress'
                            if _queue_manager.is_paused:
                                msg = 'Analysis is paused. Exit Project Kestrel? You can re-open later to resume.'
                            else:
                                msg = 'Analysis is in progress. Cancel analysis and exit?'
                            resp = ctypes.windll.user32.MessageBoxW(0, msg, title, MB_YESNOCANCEL | MB_ICONQUESTION)
                            # IDYES=6 -> Exit (cancel analysis and close)
                            # IDNO=7  -> Minimize instead of closing
                            # IDCANCEL=2 -> Do not close
                            if resp == 6:
                                try:
                                    _queue_manager.cancel()
                                except Exception:
                                    pass
                                return True
                            if resp == 7:
                                try:
                                    win.minimize()
                                except Exception:
                                    pass
                                return False
                            return False
                        else:
                            # Tkinter fallback
                            import tkinter as _tk
                            from tkinter import messagebox as _mb
                            root = _tk.Tk()
                            root.withdraw()
                            if _queue_manager.is_paused:
                                msg = 'Analysis is paused. Exit Project Kestrel? You can re-open later to resume.'
                            else:
                                msg = 'Analysis is in progress. Cancel analysis and exit?'
                            res = _mb.askyesnocancel('Analysis in progress', msg)
                            root.destroy()
                            # askyesnocancel returns True=Yes, False=No, None=Cancel
                            if res is True:
                                try:
                                    _queue_manager.cancel()
                                except Exception:
                                    pass
                                return True
                            if res is False:
                                try:
                                    win.minimize()
                                except Exception:
                                    pass
                                return False
                            return False
                    except Exception:
                        # If the prompt fails, fall back to minimizing when running
                        try:
                            win.minimize()
                        except Exception:
                            pass
                        return False
                return True  # allow normal close

            try:
                win.events.closing += _on_closing
            except Exception:
                pass  # older pywebview versions may not support this event

            webview.start()
        except Exception as e:
            log('Windowed mode failed at runtime; falling back to browser:', repr(e))
            try:
                webbrowser.open(url)
            except Exception:
                pass
        finally:
            server.shutdown()
            server.server_close()
            log('Server stopped.')
    else:
        if not args.no_browser:
            try:
                webbrowser.open(url)
            except Exception:
                pass
        try:
            server.serve_forever()
        except KeyboardInterrupt:
            pass
        finally:
            server.server_close()
            log('Server stopped.')


if __name__ == '__main__':
    try:
        main()
    except KeyboardInterrupt:
        pass
    except Exception as _main_exc:
        # Top-level crash handler — send crash report before re-raising
        try:
            import traceback as _tb
            if _telemetry is not None:
                _crash_settings = load_persisted_settings()
                _crash_mid = _telemetry.get_machine_id(_crash_settings)
                
                # Fetch recent log tail, passing the active folder's log if available
                _folder_path = _crash_settings.get('active_analysis_path', '')
                if _folder_path:
                    _log_tail = _telemetry.get_recent_log_tail(folder_path=_folder_path)
                else:
                    _log_tail = _telemetry.get_recent_log_tail()
                
                _telemetry.send_crash_report(
                    exc=_main_exc,
                    tb_str=_tb.format_exc(),
                    log_tail=_log_tail,
                    machine_id=_crash_mid,
                    version=_telemetry._read_version(),
                )
                # Give daemon thread a moment to fire off the HTTP request
                import time as _t
                _t.sleep(2)
        except Exception:
            pass  # crash handler itself must never hide the real error
        raise
