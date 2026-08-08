# ---------------------------------------------------------------------------------------------
# Copyright (c) unicbm. All rights reserved.
# Licensed under the PolyForm Noncommercial License 1.0.0. See LICENSE in the project root for license information.
# ---------------------------------------------------------------------------------------------

"""Map CosmeticsView replacements to skin-core batch items and display plan_json."""

from __future__ import annotations

import logging
import math
from typing import Any

from .parser.cs2_item_catalog import resolve_cs2_item, resolve_cs2_item_by_catalog_id

logger = logging.getLogger(__name__)

_ALLOWED_TYPES = frozenset({"melee", "glove", "weapon"})
# Frontend uses "melee"; closed skin-core kind is knife. Mapper treats them as the same
# for replacement_definition_index (cross-model) awareness.
_CROSS_MODEL_TYPES = frozenset({"melee", "glove"})  # melee ≡ knife
_WEAR_MIN = 0.0
_WEAR_MAX = 1.0


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


def _require_catalog_wear(value: Any, definition_index: int, paint_kit: int) -> float:
    wear = _require_float(value, "wear")
    if wear < _WEAR_MIN or wear > _WEAR_MAX:
        raise CosmeticsSkinPlanError("wear must be between 0.000000 and 1.000000")

    catalog_item = resolve_cs2_item(definition_index, paint_kit)
    if not catalog_item or not catalog_item.get("catalog_exact"):
        return wear
    try:
        wear_min = float(catalog_item.get("wear_min"))
        wear_max = float(catalog_item.get("wear_max"))
    except (TypeError, ValueError):
        return wear
    if not math.isfinite(wear_min) or not math.isfinite(wear_max) or wear_min > wear_max:
        return wear
    if wear < wear_min or wear > wear_max:
        raise CosmeticsSkinPlanError(
            f"wear {wear:.6f} outside catalog range {wear_min:.6f}..{wear_max:.6f} "
            f"for definition_index={definition_index} paint_kit={paint_kit}"
        )
    return wear


def _require_replacement_definition(
    repl: dict[str, Any],
    *,
    item_type: str,
    source_definition_index: int,
    paint_kit: int,
) -> int:
    """Resolve a knife/glove target from redundant catalog identity fields.

    ``catalog_id`` is the stable identity emitted by the picker.  Treat it as
    authoritative when present so a stale/merged frontend ``def_index`` cannot
    pair (for example) a Specialist Gloves paint kit with the Sport Gloves
    model.  Legacy payloads without a catalog id remain accepted only when the
    requested definition+paint pair is exact in the generated catalog.
    """

    catalog_id = repl.get("catalog_id")
    catalog_target = resolve_cs2_item_by_catalog_id(catalog_id)
    if catalog_target is not None:
        try:
            requested_definition: int | None = _require_int(
                repl.get("def_index"), "replacement.def_index"
            )
        except CosmeticsSkinPlanError:
            requested_definition = None
        target_type = str(catalog_target.get("type") or "")
        target_paint = _require_int(catalog_target.get("paint"), "catalog.paint")
        target_definition = _require_int(catalog_target.get("def"), "catalog.def")
        if target_type != item_type or target_paint != paint_kit:
            raise CosmeticsSkinPlanError(
                f"replacement catalog_id={catalog_id} does not match "
                f"type={item_type} paint_kit={paint_kit}"
            )
        if target_definition != requested_definition:
            logger.warning(
                "Corrected replacement definition drift for %s catalog_id=%s "
                "(source=%s): %s -> %s",
                item_type,
                catalog_id,
                source_definition_index,
                requested_definition,
                target_definition,
            )
        return target_definition

    requested_definition = _require_int(repl.get("def_index"), "replacement.def_index")
    requested_target = resolve_cs2_item(requested_definition, paint_kit)
    exact = bool(requested_target and requested_target.get("catalog_exact"))
    target_type = str((requested_target or {}).get("type") or "")
    if not exact or target_type != item_type:
        raise CosmeticsSkinPlanError(
            f"replacement definition_index={requested_definition} paint_kit={paint_kit} "
            f"is not an exact {item_type} catalog item"
        )
    return requested_definition


def _batch_team(inventory_row: dict[str, Any]) -> str | None:
    """Map a uniquely observed inventory side to skin-core batch team (T/CT).

    Returns None when the side is unknown or mixed so legacy unscoped plans can
    keep ANY. Default glove defs 5028/5029 are side-fixed even when
    observed_teams was dropped from a UI snapshot.
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


def _split_team_slot_key(value: Any) -> tuple[str | None, str]:
    """Return (skin-core team, base slot key) for ``t:...`` / ``ct:...`` keys."""
    key = str(value or "").strip()
    lowered = key.lower()
    if lowered.startswith("t:"):
        return "T", key[2:]
    if lowered.startswith("ct:"):
        return "CT", key[3:]
    return None, key


def _trusted_scoped_slot_keys(plan_json: dict[str, Any] | None) -> frozenset[str]:
    """Return normalized T/CT slot keys backed by a server-persisted plan.

    A rewritten demo can leave the original owned entity in inventory with an
    empty ``observed_teams`` list while the replacement entity carries the
    side.  The persisted plan is the durable provenance for that original
    slot.  Only exact scoped keys are trusted; callers must never pass an
    untrusted request body as ``trusted_plan``.
    """
    if not isinstance(plan_json, dict):
        return frozenset()
    items = plan_json.get("items")
    if not isinstance(items, list):
        return frozenset()
    keys: set[str] = set()
    for entry in items:
        if not isinstance(entry, dict):
            continue
        key = str(entry.get("slot_key") or "").strip().lower()
        scoped_team, base_key = _split_team_slot_key(key)
        if scoped_team and base_key:
            keys.add(key)
    return frozenset(keys)


def _normalized_team(value: Any) -> str | None:
    text = str(value or "").strip().lower()
    if text in {"t", "2", "terrorist"}:
        return "T"
    if text in {"ct", "3", "counter-terrorist", "counterterrorist"}:
        return "CT"
    return None


def _entry_team(entry: dict[str, Any], original: dict[str, Any]) -> str | None:
    scoped, _ = _split_team_slot_key(entry.get("slot_key"))
    return scoped or _batch_team(original)


def _display_fields(row: dict[str, Any]) -> dict[str, Any]:
    """Copy display-relevant fields; omit nothing the UI needs for overlay."""
    out: dict[str, Any] = {}
    for key in (
        "catalog_id",
        "def_index",
        "paint_index",
        "paint_seed",
        "paint_wear",
        "wear_min",
        "wear_max",
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
    *,
    trusted_plan: dict[str, Any] | None = None,
) -> tuple[list[dict[str, Any]], dict[str, Any]]:
    """Resolve frontend replacements against inventory into batch items + plan_json.

    Returns:
        batch_items: skin-core ``items[]`` (no custom_name / stickers).
        plan_json: ``{steamid, items:[{slot_key, original, replacement}, ...]}``.

    ``originals`` (optional) is the first-seen demo skin per slot from the UI. After a
    prior rewrite the live inventory may already be the new skin; prefer these
    snapshots for plan display so the UI keeps showing 原皮 → 新皮.

    ``trusted_plan`` may only be a plan loaded from server persistence. Its exact
    scoped slot keys retain their prior T/CT provenance when re-analysis of a
    rewritten demo leaves the original owned inventory row with no observed side.

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
    trusted_scoped_keys = _trusted_scoped_slot_keys(trusted_plan)

    batch_items: list[dict[str, Any]] = []
    plan_entries: list[dict[str, Any]] = []

    for key, repl in replacements.items():
        if not isinstance(repl, dict):
            raise CosmeticsSkinPlanError(f"invalid replacement for slot {key!r}")
        scoped_team, base_key = _split_team_slot_key(key)
        inventory_row = by_key.get(base_key)
        client_original = (
            originals_by_key.get(str(key))
            or originals_by_key.get(base_key)
            or {}
        )
        if inventory_row is None and base_key.startswith("placeholder:"):
            try:
                source_def = int(
                    float(
                        client_original.get("def_index")
                        if "def_index" in client_original
                        else base_key.split(":", 1)[-1]
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
        inventory_row = dict(inventory_row)
        if scoped_team:
            side = scoped_team.lower()
            observed = inventory_row.get("observed_teams")
            if isinstance(observed, (list, tuple)):
                normalized = {
                    str(entry or "").strip().lower()
                    for entry in observed
                }
                # A prior successful rewrite can move the observed side onto a
                # synthetic replacement entity and leave this original owned
                # item with [].  Preserve only exact server-persisted slot
                # provenance; new/untrusted slots still fail closed here.
                trusted_after_rewrite = str(key).strip().lower() in trusted_scoped_keys
                if side not in normalized and not trusted_after_rewrite:
                    raise CosmeticsSkinPlanError(
                        f"slot {key!r} was not observed for team {scoped_team}"
                    )
            inventory_row["observed_teams"] = [side]
            if client_original:
                client_original = {
                    **client_original,
                    "observed_teams": [side],
                }

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
        replacement_definition_index = definition_index
        if item_type in _CROSS_MODEL_TYPES:
            replacement_definition_index = _require_replacement_definition(
                repl,
                item_type=item_type,
                source_definition_index=definition_index,
                paint_kit=paint_kit,
            )
        wear = _require_catalog_wear(
            repl.get("paint_wear"), replacement_definition_index, paint_kit
        )

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
            if replacement_definition_index != definition_index:
                batch_item["replacement_definition_index"] = replacement_definition_index

        # Every UI slot is Pawn-side scoped. For legacy unscoped plans, retain
        # unique observed-side inference; ambiguous rows remain ANY.
        team = scoped_team or _batch_team(inventory_row) or _batch_team(client_original)
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

        plan_replacement = _display_fields(repl)
        if item_type in _CROSS_MODEL_TYPES:
            # Persist the catalog-resolved identity, not a stale frontend def,
            # so later plan replays remain canonical without another repair.
            plan_replacement["def_index"] = replacement_definition_index

        plan_entries.append(
            {
                "slot_key": str(key),
                "original": plan_original,
                "replacement": plan_replacement,
            }
        )

    plan_json = {
        "steamid": str(steamid),
        "items": plan_entries,
    }
    return _dedupe_zero_id_weapon_batch_items(batch_items), plan_json


def _dedupe_zero_id_weapon_batch_items(
    batch_items: list[dict[str, Any]],
) -> list[dict[str, Any]]:
    """Collapse duplicate vanilla gun rules that only differ by T/CT team.

    Cosmetics UI can show the same zero-id weapon on both sides; skin-core binds
    one provenance entity. Keep the first paint and drop ``team`` when multiple
    sides were requested so resolve matches whichever entity exists. Knife/glove
    zero-id rules stay team-scoped (defs >= 500).
    """
    seen_def_index: dict[int, int] = {}
    out: list[dict[str, Any]] = []
    for item in batch_items:
        if str(item.get("item_id64") or "") != "0":
            out.append(item)
            continue
        try:
            def_index = int(item["definition_index"])
        except (KeyError, TypeError, ValueError):
            out.append(item)
            continue
        # Knives (500–599) and gloves (>=5000) keep per-side materialize rules.
        if def_index >= 500:
            out.append(item)
            continue
        prior_idx = seen_def_index.get(def_index)
        if prior_idx is None:
            seen_def_index[def_index] = len(out)
            out.append(dict(item))
            continue
        prior = out[prior_idx]
        if prior.get("team") != item.get("team"):
            prior.pop("team", None)
    return out


def build_batch_from_plan_json(
    plan_json: dict[str, Any] | None,
    inventory_rows: list[dict[str, Any]] | None,
) -> list[dict[str, Any]]:
    """Rebuild skin-core batch items from a persisted display plan.

    Used when re-applying other players' plans onto a fresh original so a
    later player's save does not wipe earlier rewrites.
    """
    if not isinstance(plan_json, dict):
        raise CosmeticsSkinPlanError("stored plan is invalid")
    steamid = str(plan_json.get("steamid") or "").strip()
    items = plan_json.get("items")
    if not steamid:
        raise CosmeticsSkinPlanError("stored plan missing steamid")
    if not isinstance(items, list) or not items:
        raise CosmeticsSkinPlanError("stored plan has no items")

    replacements: dict[str, Any] = {}
    originals: dict[str, Any] = {}
    for entry in items:
        if not isinstance(entry, dict):
            continue
        key = str(entry.get("slot_key") or "").strip()
        repl = entry.get("replacement")
        if not key or not isinstance(repl, dict):
            continue
        replacements[key] = repl
        original = entry.get("original")
        if isinstance(original, dict):
            originals[key] = original

    batch_items, _ = build_batch_and_plan(
        steamid,
        inventory_rows,
        replacements,
        originals=originals or None,
        trusted_plan=plan_json,
    )
    return batch_items


def filter_plan_by_succeeded_item_ids(
    plan_json: dict[str, Any],
    succeeded_item_ids: set[str] | None = None,
    *,
    succeeded_rows: list[Any] | None = None,
) -> dict[str, Any]:
    """Keep plan entries that match succeeded skin-core rows.

    Side-aware status rows match positive items by ``item_id64 + team`` and
    vanilla items by ``item_id64=0 + definition_index + team``. Legacy status
    rows without ``team`` retain their identity-wide behavior.
    """
    items = plan_json.get("items") if isinstance(plan_json, dict) else None
    if not isinstance(items, list):
        return {"steamid": str((plan_json or {}).get("steamid") or ""), "items": []}

    id_set = {str(x) for x in (succeeded_item_ids or set()) if str(x)}
    status_rows = [row for row in (succeeded_rows or []) if isinstance(row, dict)]

    def status_matches(
        *,
        item_id64: str,
        definition_index: int,
        team: str | None,
    ) -> bool:
        matching = []
        for row in status_rows:
            if str(row.get("item_id64") or "").strip() != item_id64:
                continue
            if item_id64 == "0":
                try:
                    if int(float(row.get("definition_index"))) != definition_index:
                        continue
                except (TypeError, ValueError):
                    continue
            matching.append(row)
        if matching:
            scoped = [row for row in matching if _normalized_team(row.get("team"))]
            if not scoped:
                return True
            return bool(team) and any(
                _normalized_team(row.get("team")) == team for row in scoped
            )
        return not status_rows and item_id64 in id_set

    kept: list[dict[str, Any]] = []
    for entry in items:
        if not isinstance(entry, dict):
            continue
        original = entry.get("original")
        if not isinstance(original, dict):
            continue
        team = _entry_team(entry, original)
        item_id = _finite_item_id(original)
        if item_id is not None:
            if status_matches(
                item_id64=str(item_id),
                definition_index=_require_int(
                    original.get("def_index"), "definition_index"
                ),
                team=team,
            ):
                kept.append(entry)
            continue
        try:
            def_index = int(float(original.get("def_index")))
        except (TypeError, ValueError):
            continue
        if status_matches(
            item_id64="0",
            definition_index=def_index,
            team=team,
        ):
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
    by_id_team: dict[tuple[str, str | None], dict[str, Any]] = {}
    by_zero_def_team: dict[tuple[int, str | None], dict[str, Any]] = {}

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
        team = _entry_team(entry, original)
        item_id = _finite_item_id(original)
        if item_id is not None:
            by_id_team[(str(item_id), team)] = meta
            continue
        try:
            def_index = int(float(original.get("def_index")))
        except (TypeError, ValueError):
            continue
        by_zero_def_team[(def_index, team)] = meta

    def fallback_meta(
        mapping: dict[tuple[Any, str | None], dict[str, Any]],
        identity: Any,
        team: str | None,
    ) -> dict[str, Any]:
        exact = mapping.get((identity, team))
        if exact is not None:
            return exact
        unscoped = mapping.get((identity, None))
        if unscoped is not None:
            return unscoped
        matches = [meta for (key, _), meta in mapping.items() if key == identity]
        # Zero-id weapons may have both T and CT plan slots after UI dual-side
        # display + batch dedupe. Prefer any named match over empty meta (which
        # caused the save dialog to render bare item_id64 "0").
        return matches[0] if matches else {}

    out: list[dict[str, Any]] = []
    for row in statuses or []:
        if not isinstance(row, dict):
            continue
        item_id64 = str(row.get("item_id64") or "").strip()
        team = _normalized_team(row.get("team"))
        if item_id64 == "0":
            try:
                def_index = int(float(row.get("definition_index")))
                meta = fallback_meta(by_zero_def_team, def_index, team)
            except (TypeError, ValueError):
                meta = {}
        else:
            meta = fallback_meta(by_id_team, item_id64, team)
        mapped: dict[str, Any] = {
            "item_id64": item_id64,
            "definition_index": row.get("definition_index"),
            "team": team,
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
