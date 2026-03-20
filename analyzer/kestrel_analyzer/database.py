import json
import os
from datetime import datetime

import pandas as pd

from .config import DATABASE_NAME, METADATA_FILENAME, SCENEDATA_FILENAME, VERSION
from .logging_utils import log_warning

# 仅由分析流水线写入的列（不包含用户可编辑数据）。
BASE_COLUMNS = [
    "filename",
    "species",
    "species_confidence",
    "family",
    "family_confidence",
    "quality",
    "export_path",
    "crop_path",
    "scene_count",
    "feature_similarity",
    "feature_confidence",
    "color_similarity",
    "color_confidence",
    "similar",
    "secondary_species_list",
    "secondary_species_scores",
    "secondary_family_list",
    "secondary_family_scores",
    "exposure_correction",
    "detection_scores",
    "capture_time",
]

# 旧版中存放在 kestrel_database.csv 里的用户可编辑列。
# 首次升级时会迁移到 kestrel_scenedata.json，并从 CSV 中剥离。
LEGACY_USER_COLUMNS = ["rating", "normalized_rating", "scene_name", "rating_origin"]

# kestrel_scenedata.json 的 schema 版本
SCENEDATA_VERSION = "2.0"

REQUIRED_COLUMNS = [
    "family",
    "family_confidence",
    "secondary_family_list",
    "secondary_family_scores",
]


def load_database(kestrel_dir: str, analyzer_name: str, log_path: str = None):
    db_path = os.path.join(kestrel_dir, DATABASE_NAME)
    metadata_path = os.path.join(kestrel_dir, METADATA_FILENAME)

    if os.path.exists(db_path):
        database = pd.read_csv(db_path)
        # 升级旧数据库：把用户列迁移到 scenedata.json
        if _needs_upgrade(database, kestrel_dir):
            database = _perform_db_upgrade(database, kestrel_dir, db_path, log_path)
    else:
        database = pd.DataFrame(columns=BASE_COLUMNS)
        try:
            if not os.path.exists(metadata_path):
                metadata = {
                    "version": VERSION,
                    "analyzer": analyzer_name,
                    "created_utc": datetime.utcnow().isoformat() + "Z",
                    "database_file": DATABASE_NAME,
                }
                with open(metadata_path, "w", encoding="utf-8") as mf:
                    json.dump(metadata, mf, indent=2)
        except Exception as e:
            if log_path:
                log_warning(
                    log_path,
                    f"Failed to write metadata file: {e}",
                    category=type(e),
                    stage="metadata_write",
                    context={"metadata_path": metadata_path},
                )
            else:
                print(f"Warning: failed to write metadata file: {e}")

    database = ensure_columns(database)
    return database, db_path


def _needs_upgrade(database: pd.DataFrame, kestrel_dir: str) -> bool:
    """如果数据库仍含旧版用户列且 scenedata.json 尚不存在，则返回 True。"""
    has_legacy = any(col in database.columns for col in LEGACY_USER_COLUMNS)
    scenedata_exists = os.path.exists(os.path.join(kestrel_dir, SCENEDATA_FILENAME))
    return has_legacy and not scenedata_exists


def _perform_db_upgrade(
    database: pd.DataFrame, kestrel_dir: str, db_path: str, log_path: str = None
) -> pd.DataFrame:
    """迁移旧数据库：抽取用户数据到 scenedata.json，并移除旧列。"""
    # 先从旧数据库构建并保存 scenedata
    try:
        scenedata = _build_scenedata_from_legacy_db(database)
        save_scenedata(scenedata, kestrel_dir)
        print(f"[database] Migrated legacy user data to {SCENEDATA_FILENAME}", flush=True)
    except Exception as e:
        if log_path:
            log_warning(
                log_path,
                f"Failed to migrate legacy database to {SCENEDATA_FILENAME}: {e}",
                category=type(e),
                stage="db_upgrade",
                context={"kestrel_dir": kestrel_dir},
            )
        else:
            print(f"Warning: failed to migrate legacy database: {e}", flush=True)

    # 先把去掉旧列的新文件写到临时路径，再备份旧文件，最后原子替换。
    # 这样即使进程在任意步骤崩溃，原始数据也不会丢失。
    try:
        timestamp = datetime.utcnow().strftime("%Y%m%d_%H%M%S")
        old_path = os.path.join(kestrel_dir, f"OLD_lingjian_database_{timestamp}.csv")
        tmp_path = db_path + ".new"
        cleaned = database.drop(
            columns=[c for c in LEGACY_USER_COLUMNS if c in database.columns],
            errors="ignore",
        )
        cleaned.to_csv(tmp_path, index=False)
        os.rename(db_path, old_path)
        os.replace(tmp_path, db_path)
        print(
            f"[database] Upgrade complete: backup at {os.path.basename(old_path)}, "
            f"new clean {DATABASE_NAME} saved.",
            flush=True,
        )
    except Exception as e:
        if log_path:
            log_warning(
                log_path,
                f"Failed to rename/save upgraded database: {e}",
                category=type(e),
                stage="db_upgrade",
                context={"kestrel_dir": kestrel_dir},
            )
        else:
            print(f"Warning: failed to save upgraded database: {e}", flush=True)

    return database.drop(
        columns=[c for c in LEGACY_USER_COLUMNS if c in database.columns],
        errors="ignore",
    )


def _build_scenedata_from_legacy_db(database: pd.DataFrame) -> dict:
    """从旧版数据库 DataFrame 构建新的 scenedata，并保留用户编辑内容。"""
    scenedata: dict = {
        "version": SCENEDATA_VERSION,
        "image_ratings": {},
        "scenes": {},
    }

    # 提取逐图的手动评分
    if "rating" in database.columns:
        has_origin = "rating_origin" in database.columns
        for _, row in database.iterrows():
            filename = str(row.get("filename", ""))
            if not filename:
                continue
            origin = str(row.get("rating_origin", "")).lower() if has_origin else ""
            rating_val = row.get("rating", None)
            try:
                r = int(float(rating_val))
            except (TypeError, ValueError):
                continue
            # 明确是 manual，或旧数据里无 origin 但评分非 0，都视为用户意图
            if origin == "manual" or (not has_origin and 1 <= r <= 5):
                if 1 <= r <= 5:
                    scenedata["image_ratings"][filename] = r

    # 按 scene_count 分组构建场景
    if "scene_count" in database.columns:
        groups: dict = {}
        for _, row in database.iterrows():
            sc = str(row.get("scene_count", "0"))
            if sc not in groups:
                groups[sc] = []
            fname = str(row.get("filename", ""))
            if fname:
                groups[sc].append(fname)

        for sc, filenames in groups.items():
            scene_name = ""
            if "scene_name" in database.columns:
                mask = database["scene_count"].astype(str) == sc
                for sn in database.loc[mask, "scene_name"]:
                    if str(sn).strip():
                        scene_name = str(sn).strip()
                        break
            scenedata["scenes"][sc] = {
                "scene_id": sc,
                "image_filenames": filenames,
                "name": scene_name,
                "status": "pending",
                "user_tags": {
                    "species": [],
                    "families": [],
                    "finalized": False,
                },
            }

    return scenedata


def build_scenedata_from_database(database: pd.DataFrame) -> dict:
    """从干净的非旧版数据库构建新的 scenedata。

    用于刚分析完成的新文件夹首次创建 kestrel_scenedata.json。
    """
    scenedata: dict = {
        "version": SCENEDATA_VERSION,
        "image_ratings": {},
        "scenes": {},
    }

    if "scene_count" not in database.columns or database.empty:
        return scenedata

    groups: dict = {}
    for _, row in database.iterrows():
        sc = str(row.get("scene_count", "0"))
        if sc not in groups:
            groups[sc] = []
        fname = str(row.get("filename", ""))
        if fname:
            groups[sc].append(fname)

    for sc, filenames in groups.items():
        scenedata["scenes"][sc] = {
            "scene_id": sc,
            "image_filenames": filenames,
            "name": "",
            "status": "pending",
            "user_tags": {
                "species": [],
                "families": [],
                "finalized": False,
            },
        }

    return scenedata


def update_scenedata_with_database(scenedata: dict, database: pd.DataFrame) -> dict:
    """Update existing scenedata by adding newly-analyzed images from database.

    New images are added to their correct scenes (by scene_count) without overwriting
    any user-edited data (ratings, names, tags, custom scene membership).
    Returns the mutated scenedata dict.
    """
    if (
        "filename" not in database.columns
        or "scene_count" not in database.columns
        or database.empty
    ):
        return scenedata

    # Build set of all filenames already tracked in scenedata
    known: set = set()
    for scene_entry in scenedata.get("scenes", {}).values():
        for fname in scene_entry.get("image_filenames", []):
            known.add(fname)

    scenes = scenedata.setdefault("scenes", {})
    for _, row in database.iterrows():
        fname = str(row.get("filename", ""))
        if not fname or fname in known:
            continue
        sc = str(row.get("scene_count", "0"))
        if sc not in scenes:
            scenes[sc] = {
                "scene_id": sc,
                "image_filenames": [],
                "name": "",
                "status": "pending",
                "user_tags": {"species": [], "families": [], "finalized": False},
            }
        scenes[sc]["image_filenames"].append(fname)
        known.add(fname)

    return scenedata


def load_scenedata(kestrel_dir: str) -> dict:
    """Load kestrel_scenedata.json. Returns an empty initialized dict if the file is missing."""
    scenedata_path = os.path.join(kestrel_dir, SCENEDATA_FILENAME)
    if os.path.exists(scenedata_path):
        try:
            with open(scenedata_path, "r", encoding="utf-8") as f:
                data = json.load(f)
            # Ensure required keys (forward compatibility)
            data.setdefault("version", SCENEDATA_VERSION)
            data.setdefault("image_ratings", {})
            data.setdefault("scenes", {})
            return data
        except Exception as e:
            print(f"Warning: failed to load {SCENEDATA_FILENAME}: {e}", flush=True)
    return {"version": SCENEDATA_VERSION, "image_ratings": {}, "scenes": {}}


def save_scenedata(scenedata: dict, kestrel_dir: str) -> None:
    """Save scenedata dict to kestrel_scenedata.json (atomic write)."""
    scenedata_path = os.path.join(kestrel_dir, SCENEDATA_FILENAME)
    tmp_path = scenedata_path + ".tmp"
    with open(tmp_path, "w", encoding="utf-8") as f:
        json.dump(scenedata, f, indent=2)
    os.replace(tmp_path, scenedata_path)


def ensure_columns(database: pd.DataFrame) -> pd.DataFrame:
    """Ensure required analysis columns exist with appropriate defaults."""
    for col in REQUIRED_COLUMNS:
        if col not in database.columns:
            if col.endswith("_list"):
                database[col] = [[] for _ in range(len(database))]
            elif col.endswith("_scores"):
                database[col] = [[] for _ in range(len(database))]
            else:
                database[col] = "Unknown" if "family" in col else 0.0
    if "exposure_correction" not in database.columns:
        database["exposure_correction"] = 0.0
    if "detection_scores" not in database.columns:
        database["detection_scores"] = [[] for _ in range(len(database))]
    if "capture_time" not in database.columns:
        database["capture_time"] = ""
    return database


def save_database(database: pd.DataFrame, db_path: str) -> None:
    """Save database to CSV, stripping any legacy user columns if accidentally present."""
    cols_to_drop = [c for c in LEGACY_USER_COLUMNS if c in database.columns]
    if cols_to_drop:
        database = database.drop(columns=cols_to_drop)
    database.to_csv(db_path, index=False)
