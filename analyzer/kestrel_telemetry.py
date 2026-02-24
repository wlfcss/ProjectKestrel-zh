"""
Project Kestrel — Telemetry Module

Handles all outbound communication with the Cloudflare Worker API:
  - Feedback / bug reports
  - Crash reports
  - Anonymous per-folder usage analytics

DESIGN RULES:
  1. Every public function is **failsafe** — never raises, never blocks the UI.
  2. All HTTP calls run in daemon threads with a 10-second timeout.
  3. No personally identifiable data is ever sent (no filenames, paths, image data).
  4. Analytics are only sent when the user has explicitly opted in.
"""

import hashlib
import json
import os
import platform
import sys
import threading
import traceback
import uuid
from typing import Any, Dict, List, Optional

# Attempt to import urllib — should always succeed (stdlib)
try:
    import urllib.request
    import urllib.error
except ImportError:
    urllib = None  # type: ignore[assignment]

# ---------------------------------------------------------------------------
# Configuration — the shared secret and endpoint URL
# ---------------------------------------------------------------------------
KESTREL_API_URL = "https://kestrel-api-worker.projectkestrel.workers.dev"
KESTREL_SHARED_SECRET = "pk-kestrel-2026-shared-key"  # basic abuse-prevention

_TIMEOUT_SECONDS = 10
_MAX_LOG_ENTRIES = 50
_MAX_SCREENSHOT_BYTES = 2 * 1024 * 1024  # 2 MB cap for screenshot payloads


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------

def _read_version() -> str:
    """Read the version string from VERSION.txt (failsafe)."""
    try:
        # Check relative to this file, then one level up (repo root)
        for candidate in [
            os.path.join(os.path.dirname(__file__), 'VERSION.txt'),
            os.path.join(os.path.dirname(__file__), '..', 'VERSION.txt'),
        ]:
            if os.path.isfile(candidate):
                with open(candidate, 'r', encoding='utf-8') as f:
                    for line in f:
                        if line.strip().lower().startswith('version:'):
                            return line.strip().split(':', 1)[1].strip()
        return 'unknown'
    except Exception:
        return 'unknown'


def _get_os_info() -> str:
    """Return a short OS description (e.g. 'Windows-10-x86_64')."""
    try:
        return f"{platform.system()}-{platform.release()}-{platform.machine()}"
    except Exception:
        return 'unknown'


def get_machine_id(settings: dict) -> str:
    """Return a stable, random machine identifier.

    If ``machine_id`` already exists in *settings*, return it.
    Otherwise generate a new UUID4, store it in *settings*, and return it.

    The caller is responsible for persisting the settings dict to disk.
    """
    try:
        mid = settings.get('machine_id')
        if mid and isinstance(mid, str) and len(mid) > 8:
            return mid
        mid = str(uuid.uuid4())
        settings['machine_id'] = mid
        return mid
    except Exception:
        return 'unknown'


def _post_json(endpoint: str, payload: dict) -> None:
    """POST JSON to the Cloudflare Worker (fire-and-forget, failsafe)."""
    if urllib is None:
        return
    try:
        url = f"{KESTREL_API_URL}{endpoint}"
        data = json.dumps(payload).encode('utf-8')
        req = urllib.request.Request(
            url,
            data=data,
            headers={
                'Content-Type': 'application/json',
                'X-Kestrel-Key': KESTREL_SHARED_SECRET,
            },
            method='POST',
        )
        with urllib.request.urlopen(req, timeout=_TIMEOUT_SECONDS) as resp:
            _ = resp.read()  # drain response
    except Exception:
        # Silently swallow — no wifi, server down, etc.
        pass


def _post_json_async(endpoint: str, payload: dict) -> None:
    """Fire-and-forget POST in a daemon thread (never blocks the caller)."""
    try:
        t = threading.Thread(target=_post_json, args=(endpoint, payload), daemon=True)
        t.start()
    except Exception:
        pass


def _hash_folder_name(folder_path: str) -> str:
    """Return a one-way hash of the folder *name* (not full path) for analytics."""
    try:
        name = os.path.basename(folder_path.rstrip('/\\'))
        return hashlib.sha256(name.encode('utf-8')).hexdigest()[:12]
    except Exception:
        return ''


# ---------------------------------------------------------------------------
# Public API: Feedback
# ---------------------------------------------------------------------------

def send_feedback(
    report_type: str,
    description: str,
    contact: str = '',
    screenshot_b64: str = '',
    log_tail: str = '',
    machine_id: str = '',
    version: str = '',
) -> None:
    """Send a feedback / bug report to the Cloudflare Worker (async, failsafe).

    Parameters
    ----------
    report_type : str
        One of 'bug', 'suggestion', 'liked', 'general'.
    description : str
        User-supplied description text.
    contact : str
        Optional email / contact info.
    screenshot_b64 : str
        Optional base64-encoded screenshot PNG.
    log_tail : str
        Optional stringified recent log entries.
    machine_id, version : str
        Machine identifier and app version.
    """
    try:
        # Enforce a size cap on large payloads
        if len(screenshot_b64) > _MAX_SCREENSHOT_BYTES:
            screenshot_b64 = ''  # silently drop oversized screenshots

        payload = {
            'type': report_type or 'general',
            'description': description or '',
            'contact': contact or '',
            'screenshot_b64': screenshot_b64,
            'log_tail': log_tail,
            'machine_id': machine_id,
            'version': version or _read_version(),
            'os': _get_os_info(),
        }
        _post_json_async('/api/feedback', payload)
    except Exception:
        pass  # failsafe


# ---------------------------------------------------------------------------
# Public API: Crash Reports
# ---------------------------------------------------------------------------

def send_crash_report(
    exc: Optional[Exception] = None,
    tb_str: str = '',
    log_tail: str = '',
    session_analytics: Optional[dict] = None,
    machine_id: str = '',
    version: str = '',
) -> None:
    """Send a crash report to the Cloudflare Worker (async, failsafe).

    Parameters
    ----------
    exc : Exception, optional
        The exception object.
    tb_str : str
        Pre-formatted traceback string.
    log_tail : str
        Optional recent log entries.
    session_analytics : dict, optional
        Any analytics data collected so far in this session.
    machine_id, version : str
        Machine identifier and app version.
    """
    try:
        exc_type = type(exc).__name__ if exc else 'Unknown'
        exc_msg = str(exc) if exc else ''
        if not tb_str:
            try:
                tb_str = traceback.format_exc()
            except Exception:
                tb_str = ''
        payload = {
            'exception_type': exc_type,
            'exception_message': exc_msg,
            'traceback': tb_str,
            'log_tail': log_tail,
            'session_analytics': session_analytics,
            'machine_id': machine_id,
            'version': version or _read_version(),
            'os': _get_os_info(),
        }
        _post_json_async('/api/crash', payload)
    except Exception:
        pass  # failsafe


# ---------------------------------------------------------------------------
# Public API: Analytics
# ---------------------------------------------------------------------------

def send_folder_analytics(
    folder_path: str,
    files_analyzed: int,
    total_files: int,
    active_compute_time_s: float,
    file_sizes_kb: List[float],
    file_formats: Dict[str, int],
    was_cancelled: bool = False,
    machine_id: str = '',
    version: str = '',
) -> None:
    """Send per-folder analytics after analysis completes (async, failsafe).

    Only called when the user has opted in.

    Parameters
    ----------
    folder_path : str
        Used only to create a one-way hash of the folder name.
    files_analyzed : int
        Number of NEW files analyzed in this session (not previously analyzed).
    total_files : int
        Total files in the folder.
    active_compute_time_s : float
        Wall-clock seconds of active analysis (excludes paused time).
    file_sizes_kb : list[float]
        Sizes of the analyzed files in KB.
    file_formats : dict[str, int]
        Extension -> count mapping (e.g. {'.CR3': 5, '.jpg': 3}).
    was_cancelled : bool
        Whether the analysis was cancelled before completion.
    machine_id, version : str
        Machine identifier and app version.
    """
    try:
        avg_size = sum(file_sizes_kb) / len(file_sizes_kb) if file_sizes_kb else 0
        avg_speed = (active_compute_time_s * 1000 / files_analyzed) if files_analyzed > 0 else 0

        payload = {
            'machine_id': machine_id,
            'version': version or _read_version(),
            'os': _get_os_info(),
            'folder_name_hash': _hash_folder_name(folder_path),
            'files_analyzed': files_analyzed,
            'avg_file_size_kb': round(avg_size, 1),
            'avg_analysis_speed_ms': round(avg_speed, 1),
            'file_formats': file_formats,
            'active_compute_time_s': round(active_compute_time_s, 1),
            'was_cancelled': was_cancelled,
        }
        _post_json_async('/api/analytics', payload)
    except Exception:
        pass  # failsafe


# ---------------------------------------------------------------------------
# Public API: Log Tail
# ---------------------------------------------------------------------------

def get_recent_log_tail(folder: Optional[str] = None, max_entries: int = _MAX_LOG_ENTRIES) -> str:
    """Read the most recent pipeline log file and return a truncated string.

    Completely failsafe — returns an empty string if anything goes wrong
    (missing file, parse error, permission denied, etc.).

    Parameters
    ----------
    folder : str or None
        Folder that was being analyzed (log files live in ``<folder>/.kestrel/``).
        If None, tries the user home ``~/.kestrel/`` directory.
    max_entries : int
        Maximum number of log entries to include (most recent first).

    Returns
    -------
    str
        JSON-formatted string of the last N log entries, or ''.
    """
    try:
        from kestrel_analyzer.config import KESTREL_DIR_NAME, LOG_FILENAME_PREFIX, LOG_FILE_EXTENSION
    except ImportError:
        try:
            # Fallback: import from relative path
            from analyzer.kestrel_analyzer.config import KESTREL_DIR_NAME, LOG_FILENAME_PREFIX, LOG_FILE_EXTENSION
        except ImportError:
            # Cannot import config — use defaults
            KESTREL_DIR_NAME = '.kestrel'
            LOG_FILENAME_PREFIX = 'kestrel_log'
            LOG_FILE_EXTENSION = 'json'

    try:
        # Build list of candidate log directories
        candidates = []
        if folder:
            candidates.append(os.path.join(folder, KESTREL_DIR_NAME))
        candidates.append(os.path.join(os.path.expanduser('~'), KESTREL_DIR_NAME))

        # Find the most recent log file across candidates
        best_path = None
        best_mtime = 0

        for log_dir in candidates:
            if not os.path.isdir(log_dir):
                continue
            try:
                for fname in os.listdir(log_dir):
                    if fname.startswith(LOG_FILENAME_PREFIX) and fname.endswith(f'.{LOG_FILE_EXTENSION}'):
                        fp = os.path.join(log_dir, fname)
                        try:
                            mt = os.path.getmtime(fp)
                            if mt > best_mtime:
                                best_mtime = mt
                                best_path = fp
                        except OSError:
                            continue
            except OSError:
                continue

        if not best_path:
            return ''

        with open(best_path, 'r', encoding='utf-8') as f:
            data = json.load(f)

        if not isinstance(data, list):
            return ''

        # Take the last N entries
        tail = data[-max_entries:]
        return json.dumps(tail, indent=2, default=str)

    except Exception:
        return ''  # failsafe — never raise


# ---------------------------------------------------------------------------
# Public API: Collect Per-Folder Stats from _QueueItem
# ---------------------------------------------------------------------------

def collect_folder_stats(item_path: str, files_this_session: int, total_files: int) -> Dict[str, Any]:
    """Collect file sizes and extension counts for a completed folder.

    This scans the raw image files in the folder to gather statistics.
    Completely failsafe — returns empty/default values on any error.

    Parameters
    ----------
    item_path : str
        Absolute path to the analyzed folder.
    files_this_session : int
        Number of NEW files analyzed in this session.
    total_files : int
        Total number of image files in the folder.

    Returns
    -------
    dict with keys: file_sizes_kb, file_formats
    """
    try:
        # Import known extensions
        try:
            from kestrel_analyzer.config import RAW_EXTENSIONS, JPEG_EXTENSIONS
        except ImportError:
            try:
                from analyzer.kestrel_analyzer.config import RAW_EXTENSIONS, JPEG_EXTENSIONS
            except ImportError:
                RAW_EXTENSIONS = {'.cr2', '.cr3', '.nef', '.arw', '.dng', '.orf', '.rw2', '.raf'}
                JPEG_EXTENSIONS = {'.jpg', '.jpeg', '.png', '.tiff', '.tif', '.bmp', '.webp'}

        file_sizes_kb: List[float] = []
        file_formats: Dict[str, int] = {}
        all_exts = RAW_EXTENSIONS | JPEG_EXTENSIONS

        for fname in os.listdir(item_path):
            fpath = os.path.join(item_path, fname)
            if not os.path.isfile(fpath):
                continue
            ext = os.path.splitext(fname)[1].lower()
            if ext not in all_exts:
                continue
            try:
                size_kb = os.path.getsize(fpath) / 1024.0
                file_sizes_kb.append(round(size_kb, 1))
            except OSError:
                pass
            file_formats[ext] = file_formats.get(ext, 0) + 1

        return {
            'file_sizes_kb': file_sizes_kb,
            'file_formats': file_formats,
        }
    except Exception:
        return {'file_sizes_kb': [], 'file_formats': {}}
