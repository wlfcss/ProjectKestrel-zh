"""Kestrel 可视化界面的设置持久化与通用工具函数。"""

from __future__ import annotations

import json
import os
import sys

SETTINGS_FILENAME = 'settings.json'

# 遥测模块，导入失败也不能阻塞启动
try:
    import kestrel_telemetry as _telemetry
except ImportError:
    try:
        from analyzer import kestrel_telemetry as _telemetry
    except ImportError:
        _telemetry = None  # type: ignore[assignment]


def _get_user_data_dir() -> str:
    # 为 Project Kestrel 统一使用固定的应用数据目录名
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
        
    # --- 用户同意后，补发此前暂存的分析遥测 ---
    if data.get('analytics_consent_shown', False) and 'pending_analytics' in data:
        pending = data.pop('pending_analytics')
        if data.get('analytics_opted_in', False) and _telemetry is not None:
            try:
                _telemetry.send_folder_analytics(**pending)
                log('[analytics] Flushed pending detailed analytics after opt-in.')
            except Exception as e:
                log(f'[analytics] Failed to flush pending analytics: {e}')
    # --------------------------------------

    path = _get_settings_path()
    os.makedirs(os.path.dirname(path), exist_ok=True)
    tmp = path + '.tmp'
    try:
        # 清理上次异常退出遗留的 .tmp 文件（Windows 下无法替换被锁定的文件）
        try:
            os.remove(tmp)
        except FileNotFoundError:
            pass
        with open(tmp, 'w', encoding='utf-8') as f:
            json.dump(data, f, indent=2, sort_keys=True)
        os.replace(tmp, path)
    except OSError:
        # 回退方案：直接写入；虽然不是原子操作，但对设置文件足够安全
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
