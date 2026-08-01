# ---------------------------------------------------------------------------------------------
# Copyright (c) unicbm. All rights reserved.
# Licensed under the PolyForm Noncommercial License 1.0.0. See LICENSE in the project root for license information.
# ---------------------------------------------------------------------------------------------

"""Map CosmeticsView replacements to skin-core batch items and display plan_json."""

from __future__ import annotations

import math
from typing import Any

_ALLOWED_TYPES = frozenset({"melee", "glove", "weapon"})
# Frontend uses "melee"; closed skin-core kind is knife. Mapper treats them as the same
# for replacement_definition_index (cross-model) awareness.
_CROSS_MODEL_TYPES = frozenset({"melee", "glove"})  # melee ≡ knife


class CosmeticsSkinPlanError(ValueError):
    """Whole-request failure: missing/invalid slot, type, or item_id."""


def _js_number(value: Any) -> int | float:
    """Mirror JS `Number(x) || 0` used by frontend slotKey."""
    try:
        num = float(value)
    except (TypeError, ValueError):
        return 0
    if not math.isfinite(num) or num == 0:
        return 0
    if num.is_integer():
        return int(num)
    return num


def _finite_item_id(item: Any) -> int | None:
    if not isinstance(item, dict):
        return None
    try:
        num = float(item.get("item_id"))
    except (TypeError, ValueError):
        return None
    if not math.isfinite(num) or num <= 0:
        return None
    return int(num) if num.is_integer() else None


def slot_key(item: Any) -> str:
    """Mirror frontend cosmeticsLayout.slotKey (id: / placeholder: / def:).

    Resolved rule: ``id:{item_id}`` when finite item_id > 0; else
    ``placeholder:{def_index}`` when ``is_placeholder``; else
    ``def:{def_index}:{paint_index}:{paint_seed}:{paint_wear}``.
    """
    item_id = _finite_item_id(item if isinstance(item, dict) else None)
    if item_id is not None:
        return f"id:{item_id}"
    data = item if isinstance(item, dict) else {}
    if data.get("is_placeholder"):
        return f"placeholder:{_js_number(data.get('def_index'))}"
    return (
        f"def:{_js_number(data.get('def_index'))}"
        f":{_js_number(data.get('paint_index'))}"
        f":{_js_number(data.get('paint_seed'))}"
        f":{_js_number(data.get('paint_wear'))}"
    )


def _require_int(value: Any, field: str) -> int:
    try:
        num = float(value)
    except (TypeError, ValueError) as exc:
        raise CosmeticsSkinPlanError(f"invalid {field}") from exc
    if not math.isfinite(num) or not float(num).is_integer():
        raise CosmeticsSkinPlanError(f"invalid {field}")
    return int(num)


def _require_float(value: Any, field: str) -> float:
    try:
        num = float(value)
    except (TypeError, ValueError) as exc:
        raise CosmeticsSkinPlanError(f"invalid {field}") from exc
    if not math.isfinite(num):
        raise CosmeticsSkinPlanError(f"invalid {field}")
    return float(num)


def _display_fields(row: dict[str, Any]) -> dict[str, Any]:
    """Copy display-relevant fields; omit nothing the UI needs for overlay."""
    out: dict[str, Any] = {}
    for key in (
        "catalog_id",
        "def_index",
        "paint_index",
        "paint_seed",
        "paint_wear",
        "item_id",
        "type",
        "model",
        "name_en",
        "name_zh",
        "alt_name",
        "image_url",
        "rarity",
        "observed_teams",
        "stickers",
        "custom_name",
    ):
        if key in row:
            out[key] = row[key]
    return out


def build_batch_and_plan(
    steamid: str,
    inventory_rows: list[dict[str, Any]] | None,
    replacements: dict[str, Any] | None,
) -> tuple[list[dict[str, Any]], dict[str, Any]]:
    """Resolve frontend replacements against inventory into batch items + plan_json.

    Returns:
        batch_items: skin-core ``items[]`` (no custom_name / stickers).
        plan_json: ``{steamid, items:[{slot_key, original, replacement}, ...]}``.

    Raises:
        CosmeticsSkinPlanError: if replacements empty, any slot missing, item lacks
        positive item_id, or type not in {melee, glove, weapon}.
    """
    if not isinstance(replacements, dict) or not replacements:
        raise CosmeticsSkinPlanError("replacements must be a non-empty object")

    rows = list(inventory_rows or [])
    by_key: dict[str, dict[str, Any]] = {}
    for row in rows:
        if not isinstance(row, dict):
            continue
        by_key[slot_key(row)] = row

    batch_items: list[dict[str, Any]] = []
    plan_entries: list[dict[str, Any]] = []

    for key, repl in replacements.items():
        if not isinstance(repl, dict):
            raise CosmeticsSkinPlanError(f"invalid replacement for slot {key!r}")
        original = by_key.get(str(key))
        if original is None:
            raise CosmeticsSkinPlanError(f"slot not found in inventory: {key}")

        item_type = str(original.get("type") or "")
        if item_type not in _ALLOWED_TYPES:
            raise CosmeticsSkinPlanError(
                f"type not customizable for slot {key!r}: {item_type!r} "
                f"(allowed: melee|glove|weapon; melee maps to knife for batch kind)"
            )

        item_id = _finite_item_id(original)
        if item_id is None:
            raise CosmeticsSkinPlanError(f"item_id required for slot {key!r}")

        definition_index = _require_int(original.get("def_index"), "definition_index")
        paint_kit = _require_int(repl.get("paint_index"), "paint_kit")
        pattern_seed = _require_float(repl.get("paint_seed"), "pattern_seed")
        wear = _require_float(repl.get("paint_wear"), "wear")

        batch_item: dict[str, Any] = {
            "item_id64": str(item_id),
            "definition_index": definition_index,
            "paint_kit": paint_kit,
            "pattern_seed": pattern_seed,
            "wear": wear,
        }

        # melee → knife kind awareness: set replacement_definition_index only when
        # knife/glove model changes. Closed v1 may validate-bail on cross-model.
        if item_type in _CROSS_MODEL_TYPES:
            repl_def = _require_int(repl.get("def_index"), "replacement.def_index")
            if repl_def != definition_index:
                batch_item["replacement_definition_index"] = repl_def

        batch_items.append(batch_item)
        plan_entries.append(
            {
                "slot_key": str(key),
                "original": _display_fields(original),
                "replacement": _display_fields(repl),
            }
        )

    plan_json = {
        "steamid": str(steamid),
        "items": plan_entries,
    }
    return batch_items, plan_json


def filter_plan_by_succeeded_item_ids(
    plan_json: dict[str, Any],
    succeeded_item_ids: set[str],
) -> dict[str, Any]:
    """Keep only plan entries whose original item_id is in succeeded_item_ids."""
    items = plan_json.get("items") if isinstance(plan_json, dict) else None
    if not isinstance(items, list):
        return {"steamid": str((plan_json or {}).get("steamid") or ""), "items": []}
    kept: list[dict[str, Any]] = []
    for entry in items:
        if not isinstance(entry, dict):
            continue
        original = entry.get("original")
        if not isinstance(original, dict):
            continue
        item_id = _finite_item_id(original)
        if item_id is None:
            continue
        if str(item_id) in succeeded_item_ids:
            kept.append(entry)
    return {
        "steamid": str(plan_json.get("steamid") or ""),
        "items": kept,
    }


def map_item_statuses(
    plan_json: dict[str, Any],
    statuses: list[Any] | None,
) -> list[dict[str, Any]]:
    """Attach slot_key / display names from plan to skin-core item status rows."""
    by_id: dict[str, dict[str, Any]] = {}
    for entry in plan_json.get("items") or []:
        if not isinstance(entry, dict):
            continue
        original = entry.get("original") if isinstance(entry.get("original"), dict) else {}
        replacement = entry.get("replacement") if isinstance(entry.get("replacement"), dict) else {}
        item_id = _finite_item_id(original)
        if item_id is None:
            continue
        by_id[str(item_id)] = {
            "slot_key": str(entry.get("slot_key") or ""),
            "name_zh": replacement.get("name_zh") or original.get("name_zh"),
            "name_en": replacement.get("name_en") or original.get("name_en"),
            "type": original.get("type") or replacement.get("type"),
        }

    out: list[dict[str, Any]] = []
    for row in statuses or []:
        if not isinstance(row, dict):
            continue
        item_id64 = str(row.get("item_id64") or "").strip()
        meta = by_id.get(item_id64, {})
        mapped: dict[str, Any] = {
            "item_id64": item_id64,
            "definition_index": row.get("definition_index"),
            "slot_key": meta.get("slot_key"),
            "name_zh": meta.get("name_zh"),
            "name_en": meta.get("name_en"),
            "type": meta.get("type"),
        }
        err = row.get("error")
        if err is not None and str(err).strip():
            mapped["error"] = str(err).strip()
        out.append(mapped)
    return out
