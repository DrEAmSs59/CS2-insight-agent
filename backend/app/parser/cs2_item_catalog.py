"""Compact CS2 weapon/finish catalog generated from ianlucas/cs2-lib."""

from __future__ import annotations

import json
import logging
import re
from collections.abc import Mapping, Sequence
from functools import lru_cache
from pathlib import Path
from typing import Any

logger = logging.getLogger(__name__)

_CATALOG_PATH = Path(__file__).with_name("cs2_item_catalog.generated.json")
_ALIAS_SEPARATORS = re.compile(r"[\s-]+")
_ALIAS_PUNCTUATION = re.compile(r"[^\w]+", flags=re.UNICODE)


@lru_cache(maxsize=1)
def load_cs2_item_catalog() -> dict[str, Any]:
    payload = json.loads(_CATALOG_PATH.read_text(encoding="utf-8"))
    if not isinstance(payload, dict) or payload.get("schema_version") != 1:
        raise RuntimeError("Unsupported generated CS2 item catalog")
    return payload


def normalize_weapon_alias(value: object) -> str:
    text = str(value or "").strip().lower()
    if text.startswith("weapon_"):
        text = text[7:]
    text = _ALIAS_SEPARATORS.sub("_", text)
    text = _ALIAS_PUNCTUATION.sub("_", text)
    return re.sub(r"_+", "_", text).strip("_")


def resolve_weapon_model(value: object) -> str:
    alias = normalize_weapon_alias(value)
    if not alias:
        return ""
    catalog = load_cs2_item_catalog()
    aliases = catalog.get("aliases") or {}
    direct = aliases.get(alias)
    if direct:
        return str(direct)
    compact = alias.replace("_", "")
    for candidate, model in sorted(
        aliases.items(),
        key=lambda item: (-len(item[0]), item[0]),
    ):
        candidate_compact = candidate.replace("_", "")
        if (
            alias.startswith(f"{candidate}_")
            or alias.endswith(f"_{candidate}")
            or f"_{candidate}_" in alias
            or (candidate_compact and compact == candidate_compact)
            or (candidate_compact and compact.endswith(candidate_compact))
        ):
            return str(model)
    return ""


def cs2_weapon_translation_map() -> dict[str, str]:
    bases = load_cs2_item_catalog().get("bases") or {}
    return {
        str(item.get("model")): str(item.get("name_zh") or item.get("name_en") or item.get("model"))
        for item in bases.values()
        if isinstance(item, dict) and item.get("model")
    }


def resolve_cs2_item(def_index: object, paint_index: object) -> dict[str, Any] | None:
    try:
        definition = int(float(def_index))
        paint = int(float(paint_index or 0))
    except (TypeError, ValueError):
        return None
    catalog = load_cs2_item_catalog()
    raw = (catalog.get("items") or {}).get(f"{definition}:{paint}")
    if not isinstance(raw, dict):
        raw = (catalog.get("bases") or {}).get(str(definition))
    if not isinstance(raw, dict):
        return None
    item = dict(raw)
    item["def"] = definition
    item["paint"] = paint
    image_path = str(item.pop("image", "") or "")
    image_base = str(catalog.get("image_base_url") or "").rstrip("/")
    item["image_url"] = f"{image_base}{image_path}" if image_base and image_path.startswith("/") else ""
    item["catalog_version"] = str(catalog.get("source_version") or "")
    return item


def _records_from_columns(value: object) -> list[dict[str, Any]]:
    if isinstance(value, Sequence) and not isinstance(value, (str, bytes, bytearray)):
        return [dict(row) for row in value if isinstance(row, Mapping)]
    if isinstance(value, Mapping):
        columns = {
            str(key): list(column)
            for key, column in value.items()
            if isinstance(column, Sequence) and not isinstance(column, (str, bytes, bytearray))
        }
        row_count = max((len(column) for column in columns.values()), default=0)
        return [
            {
                key: column[index] if index < len(column) else None
                for key, column in columns.items()
            }
            for index in range(row_count)
        ]
    if hasattr(value, "to_dict"):
        try:
            records = value.to_dict(orient="records")
        except (TypeError, ValueError):
            records = None
        if isinstance(records, list):
            return [dict(row) for row in records if isinstance(row, Mapping)]
    return []


def _safe_text(value: object) -> str:
    text = str(value or "").strip()
    return "" if text.lower() in {"nan", "nat", "none", "null"} else text


def _safe_float(value: object) -> float | None:
    try:
        number = float(value)
    except (TypeError, ValueError):
        return None
    return round(number, 6)


def _skin_entry(row: Mapping[str, Any]) -> dict[str, Any] | None:
    item = resolve_cs2_item(row.get("def_index"), row.get("paint_index"))
    if not item or not item.get("model"):
        return None
    entry = {
        "def_index": int(item["def"]),
        "paint_index": int(item["paint"]),
        "model": str(item["model"]),
        "type": str(item.get("type") or ""),
        "name_en": str(item.get("name_en") or ""),
        "name_zh": str(item.get("name_zh") or item.get("name_en") or ""),
        "alt_name": str(item.get("alt_name") or ""),
        "image_url": str(item.get("image_url") or ""),
        "rarity": str(item.get("rarity") or ""),
        "catalog_version": str(item.get("catalog_version") or ""),
    }
    custom_name = _safe_text(row.get("custom_name"))
    if custom_name:
        entry["custom_name"] = custom_name
    wear = _safe_float(row.get("paint_wear"))
    if wear is not None:
        entry["paint_wear"] = wear
    try:
        entry["paint_seed"] = int(float(row.get("paint_seed")))
    except (TypeError, ValueError):
        pass
    return entry


def build_player_skin_loadouts(parser: object) -> dict[str, dict[str, dict[str, Any]]]:
    """Return unambiguous player+weapon finishes without guessing picked-up items."""
    parse_skins = getattr(parser, "parse_skins", None)
    if not callable(parse_skins):
        return {}
    try:
        rows = _records_from_columns(parse_skins())
    except Exception as exc:  # noqa: BLE001 - skins enrich replay but never block parsing
        logger.info("CS2 skin metadata unavailable: %s", exc)
        return {}

    grouped: dict[str, dict[str, dict[tuple[int, int], dict[str, Any]]]] = {}
    for row in rows:
        steamid = _safe_text(row.get("steamid"))
        entry = _skin_entry(row)
        if not steamid or not entry:
            continue
        model = entry["model"]
        signature = (entry["def_index"], entry["paint_index"])
        grouped.setdefault(steamid, {}).setdefault(model, {}).setdefault(signature, entry)

    result: dict[str, dict[str, dict[str, Any]]] = {}
    for steamid, by_model in grouped.items():
        for model, candidates in by_model.items():
            if len(candidates) != 1:
                continue
            result.setdefault(steamid, {})[model] = next(iter(candidates.values()))
    return result


def skin_for_player_weapon(
    loadouts: Mapping[str, Mapping[str, dict[str, Any]]] | None,
    steamid: object,
    weapon: object,
) -> dict[str, Any] | None:
    sid = _safe_text(steamid)
    model = resolve_weapon_model(weapon)
    if not sid or not model or not loadouts:
        return None
    entry = (loadouts.get(sid) or {}).get(model)
    return dict(entry) if isinstance(entry, dict) else None
