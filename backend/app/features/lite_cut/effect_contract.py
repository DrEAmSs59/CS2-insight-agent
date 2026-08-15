"""Shared LiteCut preview/export effect contract."""

from __future__ import annotations

import json
from functools import lru_cache
from typing import Any

from importlib.resources.abc import Traversable

from .contracts import contract_resource


def effect_contract_path() -> Traversable:
    return contract_resource("lite_cut_effect_contract.json")


@lru_cache(maxsize=1)
def load_effect_contract() -> dict[str, Any]:
    path = effect_contract_path()
    try:
        payload = json.loads(path.read_text(encoding="utf-8"))
    except Exception as exc:
        raise RuntimeError(f"LiteCut effect contract could not be loaded: {path}") from exc
    if not isinstance(payload, dict) or int(payload.get("schema_version") or 0) < 1:
        raise RuntimeError(f"LiteCut effect contract has an invalid schema: {path}")
    return payload


def filter_preset_ffmpeg_map() -> dict[str, str]:
    return {
        str(preset["id"]): str(preset.get("ffmpeg") or "")
        for preset in load_effect_contract().get("filter_presets", [])
        if isinstance(preset, dict) and preset.get("id") not in (None, "", "none")
    }
