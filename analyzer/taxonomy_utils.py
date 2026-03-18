from __future__ import annotations

import json
from functools import lru_cache
from pathlib import Path


_TAXONOMY_PATH = Path(__file__).resolve().with_name("taxonomy_zh_cn.json")

_GENERIC_SPECIES = {
    "": "",
    "unknown": "未知",
    "no bird": "无鸟",
    "error": "错误",
}

_GENERIC_FAMILY = {
    "": "",
    "unknown": "未知",
    "unknown family": "未知科",
    "n/a": "不适用",
}


@lru_cache(maxsize=1)
def _load_taxonomy() -> dict:
    if not _TAXONOMY_PATH.exists():
        return {"species": {}, "family_display": {}, "family_scientific": {}}
    try:
        return json.loads(_TAXONOMY_PATH.read_text(encoding="utf-8"))
    except Exception:
        return {"species": {}, "family_display": {}, "family_scientific": {}}


def species_display_name(name: str | None) -> str:
    value = str(name or "").strip()
    generic = _GENERIC_SPECIES.get(value.lower())
    if generic is not None:
        return generic
    taxonomy = _load_taxonomy()
    return str(taxonomy.get("species", {}).get(value, value))


def family_display_name(name: str | None) -> str:
    value = str(name or "").strip()
    generic = _GENERIC_FAMILY.get(value.lower())
    if generic is not None:
        return generic
    taxonomy = _load_taxonomy()
    family_display = taxonomy.get("family_display", {})
    family_scientific = taxonomy.get("family_scientific", {})
    return str(family_display.get(value) or family_scientific.get(value) or value)
