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


def _glove_batch_team(inventory_row: dict[str, Any]) -> str | None:
    """Map inventory observed_teams to skin-core batch team (T/CT).

    Returns None when the side is unknown or mixed so skin-core can keep ANY
    for a single glove rule. Default glove defs 5028/5029 are side-fixed even
    when observed_teams was dropped from a UI snapshot.
    """
    raw = inventory_row.get("observed_teams")
    if isinstance(raw, (list, tuple)):
        teams: set[str] = set()
        for entry in raw:
            text = str(entry or "").strip().lower()
            if text in {"t", "2", "terrorist"}:
                teams.add("T")
            elif text in {"ct", "3", "counter-terrorist", "counterterrorist"}:
                teams.add("CT")
        if teams == {"T"}:
            return "T"
        if teams == {"CT"}:
            return "CT"
    try:
        def_index = int(float(inventory_row.get("def_index")))
    except (TypeError, ValueError):
        return None
    # CS2 default glove economy defs (UI placeholders).
    if def_index == 5028:
        return "T"
    if def_index == 5029:
        return "CT"
    return None


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
    originals: dict[str, Any] | None = None,
) -> tuple[list[dict[str, Any]], dict[str, Any]]:
    """Resolve frontend replacements against inventory into batch items + plan_json.

    Returns:
        batch_items: skin-core ``items[]`` (no custom_name / stickers).
        plan_json: ``{steamid, items:[{slot_key, original, replacement}, ...]}``.

    ``originals`` (optional) is the first-seen demo skin per slot from the UI. After a
    prior rewrite the live inventory may already be the new skin; prefer these
    snapshots for plan display so the UI keeps showing 原皮 → 新皮.

    Raises:
        CosmeticsSkinPlanError: if replacements empty, any slot missing, or type
        not in {melee, glove, weapon}. Vanilla / placeholder slots may omit a
        durable item_id (emitted as item_id64 \"0\").
    """
    if not isinstance(replacements, dict) or not replacements:
        raise CosmeticsSkinPlanError("replacements must be a non-empty object")

    rows = list(inventory_rows or [])
    by_key: dict[str, dict[str, Any]] = {}
    for row in rows:
        if not isinstance(row, dict):
            continue
        by_key[slot_key(row)] = row

    originals_by_key = {
        str(key): value
        for key, value in (originals or {}).items()
        if isinstance(value, dict)
    }

    batch_items: list[dict[str, Any]] = []
    plan_entries: list[dict[str, Any]] = []

    for key, repl in replacements.items():
        if not isinstance(repl, dict):
            raise CosmeticsSkinPlanError(f"invalid replacement for slot {key!r}")
        inventory_row = by_key.get(str(key))
        client_original = originals_by_key.get(str(key)) or {}
        if inventory_row is None and str(key).startswith("placeholder:"):
            try:
                source_def = int(
                    float(
                        client_original.get("def_index")
                        if "def_index" in client_original
                        else str(key).split(":", 1)[-1]
                    )
                )
            except (TypeError, ValueError):
                source_def = 0
            item_type = str(client_original.get("type") or repl.get("type") or "")
            inventory_row = {
                "def_index": source_def,
                "type": item_type,
                "item_id": None,
                "is_placeholder": True,
            }
            # Placeholders are UI-only; carry side from the client snapshot so
            # zero-id glove materialize can be T/CT scoped.
            observed = client_original.get("observed_teams")
            if isinstance(observed, (list, tuple)):
                inventory_row["observed_teams"] = list(observed)
        if inventory_row is None:
            raise CosmeticsSkinPlanError(f"slot not found in inventory: {key}")

        item_type = str(inventory_row.get("type") or "")
        if item_type not in _ALLOWED_TYPES:
            raise CosmeticsSkinPlanError(
                f"type not customizable for slot {key!r}: {item_type!r} "
                f"(allowed: melee|glove|weapon; melee maps to knife for batch kind)"
            )

        item_id = _finite_item_id(inventory_row)
        definition_index = _require_int(inventory_row.get("def_index"), "definition_index")
        # Vanilla / placeholder slots use item_id64 "0" for skin-core materialize.
        item_id64 = str(item_id) if item_id is not None else "0"

        paint_kit = _require_int(repl.get("paint_index"), "paint_kit")
        pattern_seed = _require_float(repl.get("paint_seed"), "pattern_seed")
        wear = _require_float(repl.get("paint_wear"), "wear")

        batch_item: dict[str, Any] = {
            "item_id64": item_id64,
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

        # Zero-id glove materialize is side-scoped: T and CT may coexist, but two
        # ANY (or same-side) rules collide on the pawn EconGloves state.
        if item_type == "glove":
            team = _glove_batch_team(inventory_row) or _glove_batch_team(client_original)
            if team:
                batch_item["team"] = team

        batch_items.append(batch_item)

        if client_original:
            plan_original = {
                **_display_fields(client_original),
            }
            if item_id is not None:
                plan_original["item_id"] = inventory_row.get("item_id")
            elif "item_id" not in plan_original:
                plan_original.pop("item_id", None)
        else:
            plan_original = _display_fields(inventory_row)

        plan_entries.append(
            {
                "slot_key": str(key),
                "original": plan_original,
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
    succeeded_item_ids: set[str] | None = None,
    *,
    succeeded_rows: list[Any] | None = None,
) -> dict[str, Any]:
    """Keep plan entries that match succeeded skin-core rows.

    Positive ``item_id`` rows match ``succeeded_item_ids``. Vanilla rows
    (no durable id) match a succeeded row with ``item_id64 == "0"`` and the
    same ``definition_index``.
    """
    items = plan_json.get("items") if isinstance(plan_json, dict) else None
    if not isinstance(items, list):
        return {"steamid": str((plan_json or {}).get("steamid") or ""), "items": []}

    id_set = {str(x) for x in (succeeded_item_ids or set()) if str(x)}
    zero_defs: set[int] = set()
    for row in succeeded_rows or []:
        if not isinstance(row, dict):
            continue
        if str(row.get("item_id64") or "").strip() != "0":
            continue
        try:
            zero_defs.add(int(float(row.get("definition_index"))))
        except (TypeError, ValueError):
            continue

    kept: list[dict[str, Any]] = []
    for entry in items:
        if not isinstance(entry, dict):
            continue
        original = entry.get("original")
        if not isinstance(original, dict):
            continue
        item_id = _finite_item_id(original)
        if item_id is not None:
            if str(item_id) in id_set:
                kept.append(entry)
            continue
        try:
            def_index = int(float(original.get("def_index")))
        except (TypeError, ValueError):
            continue
        if def_index in zero_defs:
            kept.append(entry)
        elif not zero_defs and "0" in id_set and not succeeded_rows:
            kept.append(entry)
    return {
        "steamid": str(plan_json.get("steamid") or ""),
        "items": kept,
    }


def map_item_statuses(
    plan_json: dict[str, Any],
    statuses: list[Any] | None,
) -> list[dict[str, Any]]:
    """Attach slot_key / original→replacement names from plan to status rows."""
    by_id: dict[str, dict[str, Any]] = {}
    by_zero_def: dict[int, dict[str, Any]] = {}

    def _meta(entry: dict[str, Any], original: dict[str, Any], replacement: dict[str, Any]) -> dict[str, Any]:
        return {
            "slot_key": str(entry.get("slot_key") or ""),
            "original_name_zh": original.get("name_zh"),
            "original_name_en": original.get("name_en"),
            "replacement_name_zh": replacement.get("name_zh"),
            "replacement_name_en": replacement.get("name_en"),
            "name_zh": replacement.get("name_zh") or original.get("name_zh"),
            "name_en": replacement.get("name_en") or original.get("name_en"),
            "type": original.get("type") or replacement.get("type"),
        }

    for entry in plan_json.get("items") or []:
        if not isinstance(entry, dict):
            continue
        original = entry.get("original") if isinstance(entry.get("original"), dict) else {}
        replacement = entry.get("replacement") if isinstance(entry.get("replacement"), dict) else {}
        meta = _meta(entry, original, replacement)
        item_id = _finite_item_id(original)
        if item_id is not None:
            by_id[str(item_id)] = meta
            continue
        try:
            def_index = int(float(original.get("def_index")))
        except (TypeError, ValueError):
            continue
        by_zero_def[def_index] = meta

    out: list[dict[str, Any]] = []
    for row in statuses or []:
        if not isinstance(row, dict):
            continue
        item_id64 = str(row.get("item_id64") or "").strip()
        if item_id64 == "0":
            try:
                def_index = int(float(row.get("definition_index")))
                meta = by_zero_def.get(def_index, {})
            except (TypeError, ValueError):
                meta = {}
        else:
            meta = by_id.get(item_id64, {})
        mapped: dict[str, Any] = {
            "item_id64": item_id64,
            "definition_index": row.get("definition_index"),
            "slot_key": meta.get("slot_key"),
            "original_name_zh": meta.get("original_name_zh"),
            "original_name_en": meta.get("original_name_en"),
            "replacement_name_zh": meta.get("replacement_name_zh"),
            "replacement_name_en": meta.get("replacement_name_en"),
            "name_zh": meta.get("name_zh"),
            "name_en": meta.get("name_en"),
            "type": meta.get("type"),
        }
        err = row.get("error")
        if err is not None and str(err).strip():
            mapped["error"] = str(err).strip()
        out.append(mapped)
    return out
