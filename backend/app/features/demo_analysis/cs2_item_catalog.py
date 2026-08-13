# ---------------------------------------------------------------------------------------------
# Copyright (c) unicbm. All rights reserved.
# Licensed under the PolyForm Noncommercial License 1.0.0. See LICENSE in the project root for license information.
# ---------------------------------------------------------------------------------------------

"""Compact CS2 weapon/finish catalog generated from ianlucas/cs2-lib."""

from __future__ import annotations

import gzip
import json
import logging
import math
import re
import struct
from collections.abc import Mapping, Sequence
from functools import lru_cache
from pathlib import Path
from typing import Any

logger = logging.getLogger(__name__)

_CATALOG_PATH = Path(__file__).with_name("cs2_item_catalog.generated.json")
_CATALOG_GZIP_PATH = Path(__file__).with_name("cs2_item_catalog.generated.json.gz")
_ALIAS_SEPARATORS = re.compile(r"[\s-]+")
_ALIAS_PUNCTUATION = re.compile(r"[^\w]+", flags=re.UNICODE)
_STEAM_ID64_INDIVIDUAL_BASE = 76561197960265728
_TEAM_STARTER_PISTOL_DEFS = {
    "t": frozenset({4}),
    "ct": frozenset({32, 61}),
}


@lru_cache(maxsize=1)
def load_cs2_item_catalog() -> dict[str, Any]:
    if _CATALOG_PATH.is_file():
        encoded = _CATALOG_PATH.read_text(encoding="utf-8")
    elif _CATALOG_GZIP_PATH.is_file():
        with gzip.open(_CATALOG_GZIP_PATH, "rt", encoding="utf-8") as handle:
            encoded = handle.read()
    else:
        raise RuntimeError("Generated CS2 item catalog is missing")
    payload = json.loads(encoded)
    if not isinstance(payload, dict) or payload.get("schema_version") != 2:
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


@lru_cache(maxsize=1)
def _weapon_model_to_def_index() -> dict[str, int]:
    bases = load_cs2_item_catalog().get("bases") or {}
    out: dict[str, int] = {}
    for key, item in bases.items():
        if not isinstance(item, dict):
            continue
        if str(item.get("type") or "") != "weapon":
            continue
        model = str(item.get("model") or "").strip()
        if not model:
            continue
        try:
            out[model] = int(key)
        except (TypeError, ValueError):
            continue
    return out


def def_index_for_purchase_item_name(item_name: object) -> int | None:
    """Map demoparser item_purchase.item_name (e.g. AWP) to a weapon def_index."""
    model = resolve_weapon_model(item_name)
    if not model:
        return None
    return _weapon_model_to_def_index().get(model)

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
        # Demoparser emits NaN paint for vanilla finishes; treat non-finite as 0.
        paint_raw = 0.0 if paint_index is None else float(paint_index)
        paint = 0 if not math.isfinite(paint_raw) else int(paint_raw)
    except (TypeError, ValueError, OverflowError):
        return None
    catalog = load_cs2_item_catalog()
    raw = (catalog.get("items") or {}).get(f"{definition}:{paint}")
    exact = isinstance(raw, dict)
    if not isinstance(raw, dict):
        raw = (catalog.get("bases") or {}).get(str(definition))
    if not isinstance(raw, dict):
        return None
    item = dict(raw)
    item["def"] = definition
    item["paint"] = paint
    item["catalog_exact"] = exact
    image_path = str(item.pop("image", "") or "")
    image_base = str(catalog.get("image_base_url") or "").rstrip("/")
    item["image_url"] = f"{image_base}{image_path}" if image_base and image_path.startswith("/") else ""
    item["catalog_version"] = str(catalog.get("source_version") or "")
    return item


@lru_cache(maxsize=1)
def _cs2_items_by_catalog_id() -> dict[int, tuple[int, int]]:
    """Index generated finish rows by cs2-lib catalog id."""

    out: dict[int, tuple[int, int]] = {}
    for raw in (load_cs2_item_catalog().get("items") or {}).values():
        if not isinstance(raw, dict):
            continue
        try:
            catalog_id = int(raw.get("id"))
            definition = int(raw.get("def"))
            paint = int(raw.get("paint"))
        except (TypeError, ValueError, OverflowError):
            continue
        if catalog_id > 0:
            out[catalog_id] = (definition, paint)
    return out


def resolve_cs2_item_by_catalog_id(catalog_id: object) -> dict[str, Any] | None:
    """Resolve one exact generated finish by its stable cs2-lib catalog id."""

    try:
        number = float(catalog_id)
    except (TypeError, ValueError, OverflowError):
        return None
    if not math.isfinite(number) or not number.is_integer() or number <= 0:
        return None
    item_id = int(number)
    identity = _cs2_items_by_catalog_id().get(item_id)
    if identity is None:
        return None
    return resolve_cs2_item(*identity)


def resolve_cs2_sticker(sticker_id: object) -> dict[str, Any] | None:
    sticker = _safe_int(sticker_id)
    if sticker is None or sticker <= 0:
        return None
    catalog = load_cs2_item_catalog()
    raw = (catalog.get("stickers") or {}).get(str(sticker))
    if not isinstance(raw, dict):
        return None
    item = dict(raw)
    image_path = str(item.pop("image", "") or "")
    image_base = str(catalog.get("image_base_url") or "").rstrip("/")
    return {
        "catalog_id": int(item.get("id") or 0),
        "def_index": int(item.get("def") or 1209),
        "paint_index": sticker,
        "type": "sticker",
        "name_en": str(item.get("name_en") or ""),
        "name_zh": str(item.get("name_zh") or item.get("name_en") or ""),
        "image_url": f"{image_base}{image_path}" if image_base and image_path.startswith("/") else "",
        "rarity": str(item.get("rarity") or ""),
    }


def _f32_bit_pattern(value: object) -> int | None:
    try:
        number = float(value)
    except (TypeError, ValueError, OverflowError):
        return None
    if not math.isfinite(number) or number == 0.0:
        return None
    return struct.unpack("<I", struct.pack("<f", number))[0]


def _looks_like_sticker_id_float(value: object) -> bool:
    """True when a float is a denormal/bit-packed sticker id, not normal wear/offset."""
    try:
        number = float(value)
    except (TypeError, ValueError, OverflowError):
        return False
    if not math.isfinite(number) or number == 0.0:
        return False
    # Normal sticker wear / offsets live near [-2, 2]; demoparser packs sticker
    # ids as f32 bit patterns which decode to tiny denormals (~1e-40).
    if abs(number) >= 1e-20:
        return False
    bits = _f32_bit_pattern(number)
    return bits is not None and resolve_cs2_sticker(bits) is not None


def _resolve_weapon_stickers(raw_stickers: object) -> list[dict[str, Any]]:
    """Normalize demoparser weapon_stickers.

    Prefer attribute-indexed decode from patched demoparser (id > 0). Keep a
    collapsed id=0 recovery path only as fallback for older wheels.
    """
    if not isinstance(raw_stickers, Sequence) or isinstance(raw_stickers, (str, bytes, bytearray)):
        return []

    resolved: list[dict[str, Any]] = []
    for index, sticker in enumerate(raw_stickers):
        if not isinstance(sticker, Mapping):
            continue
        sticker_id = _safe_int(sticker.get("id")) or 0
        if sticker_id <= 0:
            continue
        entry = resolve_cs2_sticker(sticker_id)
        if not entry:
            continue
        wear = _safe_float(sticker.get("wear"))
        # demotracer filter: keep wear in [0, 1]; missing wear is fine.
        if wear is not None and not (0.0 <= wear <= 1.0):
            continue
        if wear is not None:
            entry["wear"] = 0.0 if wear < 0.000001 else wear
        entry["slot"] = index
        resolved.append(entry)
    if resolved:
        return resolved

    # Fallback for older demoparser layouts that leave id=0 and pack sticker
    # ids into wear/x/y f32 bit patterns. Require ≥2 recovered catalog ids.
    next_slot = 0
    for sticker in raw_stickers:
        if not isinstance(sticker, Mapping):
            continue
        if (_safe_int(sticker.get("id")) or 0) > 0:
            continue
        recovered_ids: list[int] = []
        for field in ("wear", "x", "y"):
            raw = sticker.get(field)
            if not _looks_like_sticker_id_float(raw):
                continue
            bits = _f32_bit_pattern(raw)
            if bits is None or bits in recovered_ids:
                continue
            if resolve_cs2_sticker(bits) is None:
                continue
            recovered_ids.append(bits)
        if len(recovered_ids) < 2:
            continue
        for bits in recovered_ids:
            entry = resolve_cs2_sticker(bits)
            if not entry:
                continue
            entry["slot"] = next_slot
            resolved.append(entry)
            next_slot += 1
    return resolved


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


def _safe_int(value: object) -> int | None:
    try:
        number = float(value)
    except (TypeError, ValueError, OverflowError):
        return None
    if not math.isfinite(number):
        return None
    try:
        return int(number)
    except (TypeError, ValueError, OverflowError):
        return None


def _decode_paint_wear(value: object) -> float | None:
    """Decode demoparser's raw uint32 paint-wear bits, while accepting decimals."""
    try:
        number = float(value)
    except (TypeError, ValueError, OverflowError):
        return None
    if not math.isfinite(number):
        return None
    if 0.0 <= number <= 1.0:
        return round(number, 6)
    integer = _safe_int(value)
    if integer is None or integer < 0 or integer > 0xFFFFFFFF:
        return None
    decoded = struct.unpack("<f", struct.pack("<I", integer))[0]
    if not math.isfinite(decoded) or decoded < 0.0 or decoded > 1.0:
        return None
    return round(decoded, 6)


def _custom_name(value: object) -> str:
    text = str(value or "")
    return "" if text.strip().lower() in {"", "nan", "nat", "none", "null"} else text


def _row_value(row: Mapping[str, Any], *names: str) -> object:
    for name in names:
        if name in row and row[name] is not None:
            return row[name]
    return None


def _compose_item_id(high_value: object, low_value: object) -> int | None:
    high = _safe_int(high_value)
    low = _safe_int(low_value)
    if high is None or low is None or high < 0:
        return None
    item_id = (high << 32) | (low & 0xFFFFFFFF)
    return item_id if item_id > 0 else None


def _steamid64_from_account_id(value: object) -> str:
    account_id = _safe_int(value)
    if account_id is None or account_id <= 0 or account_id > 0xFFFFFFFF:
        return ""
    return str(_STEAM_ID64_INDIVIDUAL_BASE + account_id)


def _skin_entry(row: Mapping[str, Any]) -> dict[str, Any] | None:
    item = resolve_cs2_item(row.get("def_index"), row.get("paint_index"))
    if not item:
        return None
    item_type = str(item.get("type") or "")
    model = str(item.get("model") or f"{item_type}_{item.get('def', '')}")
    entry = {
        "catalog_id": int(item.get("id") or 0),
        "base_catalog_id": _safe_int(item.get("base_id")),
        "def_index": int(item["def"]),
        "paint_index": int(item["paint"]),
        "model": model,
        "player_model": str(item.get("player_model") or ""),
        "type": item_type,
        "name_en": str(item.get("name_en") or ""),
        "name_zh": str(item.get("name_zh") or item.get("name_en") or ""),
        "alt_name": str(item.get("alt_name") or ""),
        "image_url": str(item.get("image_url") or ""),
        "rarity": str(item.get("rarity") or ""),
        "category": str(item.get("category") or ""),
        "collection_image_url": "",
        "collection_name_en": str(item.get("collection_name_en") or ""),
        "collection_name_zh": str(item.get("collection_name_zh") or ""),
        "desc_en": str(item.get("desc_en") or ""),
        "desc_zh": str(item.get("desc_zh") or ""),
        "teams": _safe_int(item.get("teams")),
        "wear_min": _safe_float(item.get("wear_min")),
        "wear_max": _safe_float(item.get("wear_max")),
        "catalog_exact": bool(item.get("catalog_exact")),
        "catalog_version": str(item.get("catalog_version") or ""),
        "finish_known": item_type not in {"glove", "melee", "weapon"} or int(item["paint"]) > 0,
    }
    collection_path = str(item.get("collection_image") or "")
    if collection_path.startswith("/"):
        image_base = str(load_cs2_item_catalog().get("image_base_url") or "").rstrip("/")
        entry["collection_image_url"] = f"{image_base}{collection_path}"
    custom_name = _custom_name(row.get("custom_name"))
    if custom_name:
        entry["custom_name"] = custom_name
    wear = _decode_paint_wear(row.get("paint_wear"))
    if wear is not None:
        entry["paint_wear"] = wear
    seed = _safe_int(row.get("paint_seed"))
    if seed is not None:
        entry["paint_seed"] = seed
    item_id = _safe_int(row.get("item_id"))
    if item_id is not None and item_id > 0:
        entry["item_id"] = item_id
    return entry


def _starter_pistol_def_from_inventory(value: object, team: str) -> int | None:
    """Resolve a side-correct pistol only from a clean respawn inventory.

    ``player_spawn`` also fires for players carrying saved equipment into a new
    round. Those snapshots may contain a pistol picked up in the prior round, so
    only knife + starter pistol (+ optional C4) inventories qualify here.
    """
    if not isinstance(value, Sequence) or isinstance(value, (str, bytes, bytearray)):
        return None
    allowed = _TEAM_STARTER_PISTOL_DEFS.get(team, frozenset())
    found: set[int] = set()
    for item_name in value:
        model = resolve_weapon_model(item_name)
        if not model:
            return None
        def_index = def_index_for_purchase_item_name(item_name)
        if def_index in allowed:
            found.add(def_index)
            continue
        if model == "c4" or model == "knife" or model.startswith("knife_"):
            continue
        return None
    return next(iter(found)) if len(found) == 1 else None


def _sample_player_context(
    parser: object,
    ticks: Sequence[int] | None,
    known_steamids: Sequence[str] | None = None,
    starter_snapshot_ticks: Sequence[int] | None = None,
) -> dict[str, Any]:
    """Return cosmetic evidence sampled from weapon, pawn and controller entities."""
    empty = {
        "item_teams": {},
        "item_accounts": {},
        "player_teams": {},
        "music_kits": {},
        "item_stickers": {},
        "observed_items": {},
        "default_weapons": {},
        "pawn_gloves": {},
        "agents": {},
        "starter_pistol_defs": {},
        "starter_pistol_item_ids": {},
    }
    if not ticks:
        return empty
    parse_ticks = getattr(parser, "parse_ticks", None)
    if not callable(parse_ticks):
        return empty
    wanted = [
        "item_id_high",
        "item_id_low",
        "inventory",
        "weapon_stickers",
        "item_def_idx",
        "weapon_skin_id",
        "weapon_paint_seed",
        "weapon_float",
        "Weapon.m_iAccountID",
        "team_num",
        "m_iMusicKitID",
        "m_unMusicID",
        "CCSPlayerController.m_iMusicKitID",
        "CCSPlayerController.CCSPlayerController_InventoryServices.m_unMusicID",
        "CCSPlayerController.m_nPawnCharacterDefIndex",
        "CCSPlayerPawn.m_iItemDefinitionIndex",
        "CCSPlayerPawn.m_iItemIDHigh",
        "CCSPlayerPawn.m_iItemIDLow",
        "CCSPlayerPawn.CEconItemAttribute.m_iAttributeDefinitionIndex",
        "CCSPlayerPawn.CEconItemAttribute.m_flInitialValue",
        "CCSPlayerPawn.m_szCustomName",
        # demoparser synthesizes these from EconGloves attribute cache; the
        # flattened CEconItemAttribute pair alone often only exposes wear (8).
        "glove_paint_id",
        "glove_paint_seed",
        "glove_paint_float",
    ]
    try:
        rows = _records_from_columns(parse_ticks(wanted, ticks=sorted(set(int(tick) for tick in ticks))))
    except Exception as exc:  # noqa: BLE001 - optional evidence enrichment
        logger.info("CS2 cosmetic side/music metadata unavailable: %s", exc)
        return empty

    item_teams: dict[tuple[str, int], set[str]] = {}
    item_account_candidates: dict[int, set[str]] = {}
    player_teams: dict[str, set[str]] = {}
    music_kits: dict[str, set[int]] = {}
    item_stickers: dict[tuple[str, int], list[dict[str, Any]]] = {}
    observed_items: dict[tuple[str, int], dict[str, Any]] = {}
    default_weapons: dict[tuple[str, int], dict[str, Any]] = {}
    pawn_gloves: dict[tuple[str, int], dict[str, Any]] = {}
    agents: dict[tuple[str, int], dict[str, Any]] = {}
    starter_pistol_candidates: dict[tuple[str, str], set[int]] = {}
    starter_pistol_item_ids: dict[tuple[str, int], set[int]] = {}
    starter_ticks = {int(tick) for tick in starter_snapshot_ticks or []}
    roster_steamids = {
        steamid
        for row in rows
        if re.fullmatch(r"\d{15,20}", steamid := _safe_text(row.get("steamid")))
    }
    roster_steamids.update(
        steamid
        for value in known_steamids or []
        if re.fullmatch(r"\d{15,20}", steamid := _safe_text(value))
    )
    for row in rows:
        steamid = _safe_text(row.get("steamid"))
        team_number = _safe_int(row.get("team_num"))
        team = "t" if team_number == 2 else "ct" if team_number == 3 else ""
        tick = _safe_int(row.get("tick"))
        if not steamid:
            continue
        if team:
            player_teams.setdefault(steamid, set()).add(team)
        item_id = _compose_item_id(row.get("item_id_high"), row.get("item_id_low"))
        if tick in starter_ticks and team:
            starter_def = _starter_pistol_def_from_inventory(row.get("inventory"), team)
            if starter_def is not None:
                starter_pistol_candidates.setdefault((steamid, team), set()).add(starter_def)
                active_def = _safe_int(row.get("item_def_idx"))
                account_owner = _steamid64_from_account_id(row.get("Weapon.m_iAccountID"))
                if item_id is not None and active_def == starter_def and account_owner == steamid:
                    starter_pistol_item_ids.setdefault((steamid, starter_def), set()).add(item_id)
        if item_id is None:
            # Default buys often have item_id=0 and account_id 0/1 with unreliable
            # paint kits. Attribute a vanilla finish to the holder only when there
            # is no roster economy owner (never steal real account-owned assets).
            account_owner = _steamid64_from_account_id(row.get("Weapon.m_iAccountID"))
            if (
                steamid in roster_steamids
                and team
                and account_owner not in roster_steamids
            ):
                default_entry = _skin_entry({
                    "def_index": row.get("item_def_idx"),
                    "paint_index": 0,
                    "paint_seed": None,
                    "paint_wear": None,
                    "item_id": None,
                    "custom_name": None,
                })
                if (
                    default_entry
                    and default_entry.get("catalog_exact")
                    and default_entry.get("type") == "weapon"
                    and str(default_entry.get("category") or "") in {
                        "secondary",
                        "rifle",
                        "smg",
                        "heavy",
                        "shotgun",
                    }
                ):
                    def_index = int(default_entry["def_index"])
                    key = (steamid, def_index)
                    previous = default_weapons.get(key)
                    if previous is None:
                        default_entry.update({
                            "owner_steamid64": steamid,
                            "ownership_evidence": "default_weapon_no_econ_id",
                            "observed_teams": [team],
                            "stickers": [],
                            "evidence_observations": 0,
                            "_owner_observation_ticks": set(),
                        })
                        default_weapons[key] = default_entry
                        previous = default_entry
                    else:
                        previous["observed_teams"] = sorted(
                            set(previous.get("observed_teams") or []) | {team},
                            key=("t", "ct").index,
                        )
                    if tick is not None:
                        previous.setdefault("_owner_observation_ticks", set()).add(tick)
        if item_id is not None:
            account_owner = _steamid64_from_account_id(row.get("Weapon.m_iAccountID"))
            if account_owner in roster_steamids:
                item_account_candidates.setdefault(item_id, set()).add(account_owner)
                if team and account_owner == steamid:
                    item_teams.setdefault((account_owner, item_id), set()).add(team)
                resolved_stickers = _resolve_weapon_stickers(row.get("weapon_stickers"))
                key = (account_owner, item_id)
                if len(resolved_stickers) > len(item_stickers.get(key, [])):
                    item_stickers[key] = resolved_stickers
                observed_entry = _skin_entry({
                    "def_index": row.get("item_def_idx"),
                    "paint_index": row.get("weapon_skin_id"),
                    "paint_seed": row.get("weapon_paint_seed"),
                    "paint_wear": row.get("weapon_float"),
                    "item_id": item_id,
                    "custom_name": None,
                })
                if observed_entry and observed_entry.get("catalog_exact"):
                    observed_entry.update({
                        "owner_steamid64": account_owner,
                        "ownership_evidence": "weapon_account_id",
                        "observed_teams": [team] if team and account_owner == steamid else [],
                        "stickers": resolved_stickers,
                        "evidence_observations": 0,
                        "_owner_observation_ticks": set(),
                        "_snapshot_tick": tick,
                    })
                    previous = observed_items.get(key)
                    if previous is None:
                        observed_items[key] = observed_entry
                        previous = observed_entry
                    else:
                        observed_teams = set(previous.get("observed_teams") or [])
                        observation_ticks = set(previous.get("_owner_observation_ticks") or set())
                        previous_stickers = list(previous.get("stickers") or [])
                        previous_tick = _safe_int(previous.get("_snapshot_tick"))
                        # Each sampled row is an already merged baseline -> entity-delta
                        # snapshot. For the same economy asset, the latest snapshot must
                        # replace the older cosmetic state wholesale, including an explicit
                        # paint kit 0. This is deliberately not a non-zero fallback.
                        if tick is not None and (previous_tick is None or tick > previous_tick):
                            observed_entry["observed_teams"] = sorted(
                                observed_teams | set(observed_entry.get("observed_teams") or []),
                                key=("t", "ct").index,
                            )
                            observed_entry["_owner_observation_ticks"] = observation_ticks
                            if len(previous_stickers) > len(resolved_stickers):
                                observed_entry["stickers"] = previous_stickers
                            observed_items[key] = observed_entry
                            previous = observed_entry
                        elif len(resolved_stickers) > len(previous_stickers):
                            previous["stickers"] = resolved_stickers
                    if team and account_owner == steamid:
                        previous["observed_teams"] = sorted(
                            set(previous.get("observed_teams") or []) | {team},
                            key=("t", "ct").index,
                        )
                        if tick is not None:
                            previous.setdefault("_owner_observation_ticks", set()).add(tick)

        pawn_item_id = _compose_item_id(
            row.get("CCSPlayerPawn.m_iItemIDHigh"),
            row.get("CCSPlayerPawn.m_iItemIDLow"),
        )
        pawn_def = _safe_int(row.get("CCSPlayerPawn.m_iItemDefinitionIndex"))
        if pawn_item_id is not None and pawn_def is not None:
            glove_paint = _safe_int(row.get("glove_paint_id")) or 0
            pawn_catalog_item = resolve_cs2_item(pawn_def, glove_paint)
            if pawn_catalog_item and str(pawn_catalog_item.get("type") or "") == "glove":
                attribute_def = _safe_int(row.get("CCSPlayerPawn.CEconItemAttribute.m_iAttributeDefinitionIndex"))
                glove_wear = row.get("glove_paint_float")
                if glove_wear is None and attribute_def == 8:
                    glove_wear = row.get("CCSPlayerPawn.CEconItemAttribute.m_flInitialValue")
                glove_entry = _skin_entry({
                    "def_index": pawn_def,
                    "paint_index": glove_paint,
                    "paint_seed": row.get("glove_paint_seed"),
                    "paint_wear": glove_wear,
                    "item_id": pawn_item_id,
                    "custom_name": row.get("CCSPlayerPawn.m_szCustomName"),
                })
                if glove_entry:
                    finish_evidence = (
                        "glove_paint_props"
                        if glove_paint > 0
                        else "base_definition_and_wear_only"
                    )
                    glove_key = (steamid, pawn_item_id)
                    previous_glove = pawn_gloves.get(glove_key)
                    if previous_glove is None:
                        glove_entry.update({
                            "owner_steamid64": steamid,
                            "ownership_evidence": "player_pawn_econ_item_id",
                            "finish_evidence": finish_evidence,
                            "observed_teams": [team] if team else [],
                            "stickers": [],
                            "evidence_observations": 0,
                            "_observation_ticks": set(),
                        })
                        pawn_gloves[glove_key] = glove_entry
                        previous_glove = glove_entry
                    else:
                        if team:
                            previous_glove["observed_teams"] = sorted(
                                set(previous_glove.get("observed_teams") or []) | {team},
                                key=("t", "ct").index,
                            )
                        # Upgrade vanilla/base pawn rows once demoparser exposes paint.
                        if (
                            int(glove_entry.get("paint_index") or 0) > 0
                            and int(previous_glove.get("paint_index") or 0) == 0
                        ):
                            for field in (
                                "catalog_id",
                                "base_catalog_id",
                                "paint_index",
                                "name_en",
                                "name_zh",
                                "alt_name",
                                "image_url",
                                "rarity",
                                "category",
                                "collection_image_url",
                                "collection_name_en",
                                "collection_name_zh",
                                "desc_en",
                                "desc_zh",
                                "wear_min",
                                "wear_max",
                                "catalog_exact",
                                "finish_known",
                            ):
                                if field in glove_entry:
                                    previous_glove[field] = glove_entry[field]
                            if glove_entry.get("paint_seed") is not None:
                                previous_glove["paint_seed"] = glove_entry["paint_seed"]
                            previous_glove["finish_evidence"] = finish_evidence
                    if glove_entry.get("paint_wear") is not None:
                        previous_glove["paint_wear"] = glove_entry["paint_wear"]
                    if (
                        glove_entry.get("paint_seed") is not None
                        and previous_glove.get("paint_seed") is None
                    ):
                        previous_glove["paint_seed"] = glove_entry["paint_seed"]
                    if tick is not None:
                        previous_glove.setdefault("_observation_ticks", set()).add(tick)

        agent_def = _safe_int(row.get("CCSPlayerController.m_nPawnCharacterDefIndex"))
        if agent_def is not None:
            agent_item = resolve_cs2_item(agent_def, 0)
            if agent_item and agent_item.get("catalog_exact") and str(agent_item.get("type") or "") == "agent":
                agent_key = (steamid, agent_def)
                agent_entry = agents.get(agent_key)
                if agent_entry is None:
                    agent_entry = _skin_entry({
                        "def_index": agent_def,
                        "paint_index": 0,
                        "paint_seed": None,
                        "paint_wear": None,
                        "custom_name": None,
                    })
                    if agent_entry:
                        agent_entry.update({
                            "owner_steamid64": steamid,
                            "ownership_evidence": "demo_player_controller_agent",
                            "observed_teams": [team] if team else [],
                            "stickers": [],
                            "evidence_observations": 0,
                            "_observation_ticks": set(),
                        })
                        agents[agent_key] = agent_entry
                elif team:
                    agent_entry["observed_teams"] = sorted(
                        set(agent_entry.get("observed_teams") or []) | {team},
                        key=("t", "ct").index,
                    )
                if agent_entry and tick is not None:
                    agent_entry.setdefault("_observation_ticks", set()).add(tick)

        equipped_music = _safe_int(_row_value(
            row,
            "CCSPlayerController.m_iMusicKitID",
            "m_iMusicKitID",
        ))
        inventory_music = _safe_int(_row_value(
            row,
            "CCSPlayerController.CCSPlayerController_InventoryServices.m_unMusicID",
            "m_unMusicID",
        ))
        # A present live field with -1 means no equipped kit. Inventory service
        # is only a compatibility fallback for demos that omit the live field.
        music_id = equipped_music if equipped_music is not None else inventory_music
        if music_id is not None and music_id > 0:
            music_kits.setdefault(steamid, set()).add(music_id)

    # A single asset observed under multiple participant accounts is ambiguous
    # demo state. Fail closed instead of assigning it to whichever row happened
    # to be parsed last.
    item_accounts = {
        item_id: next(iter(accounts))
        for item_id, accounts in item_account_candidates.items()
        if len(accounts) == 1
    }
    item_teams = {
        key: teams
        for key, teams in item_teams.items()
        if item_accounts.get(key[1]) == key[0]
    }
    item_stickers = {
        key: stickers
        for key, stickers in item_stickers.items()
        if item_accounts.get(key[1]) == key[0]
    }
    observed_items = {
        key: entry
        for key, entry in observed_items.items()
        if item_accounts.get(key[1]) == key[0]
    }
    for entry in observed_items.values():
        entry["evidence_observations"] = len(entry.pop("_owner_observation_ticks", set()))
        entry.pop("_snapshot_tick", None)
    for entry in default_weapons.values():
        entry["evidence_observations"] = len(entry.pop("_owner_observation_ticks", set()))
    for collection in (pawn_gloves, agents):
        for entry in collection.values():
            entry["evidence_observations"] = len(entry.pop("_observation_ticks", set()))
    starter_pistol_defs: dict[str, set[int]] = {}
    for (steamid, _team), candidates in starter_pistol_candidates.items():
        # Conflicting CT spawn loadouts are unsafe for zero-id rewrite. Fail
        # closed instead of guessing between USP-S and P2000.
        if len(candidates) == 1:
            starter_pistol_defs.setdefault(steamid, set()).update(candidates)
    # Glock has no T-side loadout alternative. Some third-party demos omit the
    # player_spawn event at halftime, so side participation itself is sufficient
    # to create the player's Glock slot. Cosmetic identity is still selected only
    # from that player's economy-owned asset below; otherwise it stays vanilla.
    if starter_ticks:
        for steamid, teams in player_teams.items():
            if "t" in teams:
                starter_pistol_defs.setdefault(steamid, set()).add(4)
    return {
        "item_teams": item_teams,
        "item_accounts": item_accounts,
        "player_teams": player_teams,
        "music_kits": music_kits,
        "item_stickers": item_stickers,
        "observed_items": observed_items,
        "default_weapons": default_weapons,
        "pawn_gloves": pawn_gloves,
        "agents": agents,
        "starter_pistol_defs": starter_pistol_defs,
        "starter_pistol_item_ids": starter_pistol_item_ids,
    }


def _live_spawn_snapshot_ticks(parser: object, match_start_tick: int) -> list[int]:
    """Return ticks immediately after live player spawns, before buys or pickups."""
    start = int(match_start_tick or 0)
    if start <= 0:
        return []
    parse_event = getattr(parser, "parse_event", None)
    if callable(parse_event):
        try:
            rows = _records_from_columns(parse_event("player_spawn"))
        except Exception as exc:  # noqa: BLE001 - optional cosmetics evidence
            logger.info("CS2 player_spawn unavailable for starter-pistol gate: %s", exc)
        else:
            ticks = {
                tick + 1
                for row in rows
                if (tick := _safe_int(row.get("tick"))) is not None and tick + 1 >= start
            }
            if ticks:
                return sorted(ticks)
    # begin_new_match commonly points at the first post-spawn snapshot already.
    return [start]


def _live_weapon_purchase_defs(
    parser: object,
    match_start_tick: int,
) -> dict[str, set[int]]:
    """Return steamid -> weapon def_index set bought at/after match start."""
    parse_event = getattr(parser, "parse_event", None)
    if not callable(parse_event) or int(match_start_tick or 0) <= 0:
        return {}
    try:
        table = parse_event("item_purchase")
    except Exception as exc:  # noqa: BLE001 - cosmetics never block analysis
        logger.info("CS2 item_purchase unavailable for cosmetics gate: %s", exc)
        return {}
    rows = _records_from_columns(table)
    out: dict[str, set[int]] = {}
    start = int(match_start_tick)
    for row in rows:
        tick = _safe_int(row.get("tick"))
        if tick is None or tick < start:
            continue
        steamid = _safe_text(row.get("steamid"))
        if not steamid:
            continue
        def_index = def_index_for_purchase_item_name(row.get("item_name"))
        if def_index is None:
            continue
        out.setdefault(steamid, set()).add(def_index)
    return out


def build_player_cosmetic_inventory(
    parser: object,
    *,
    sample_ticks: Sequence[int] | None = None,
    match_start_tick: int = 0,
) -> dict[str, list[dict[str, Any]]]:
    """Build evidence-only owned cosmetics keyed by their owner SteamID.

    Ownership comes from SteamID-bearing demo economy entities. Weapon entities
    are attributed through their economy account ID, never OriginalOwnerXuid.

    When ``match_start_tick > 0``, gun cosmetics additionally require a live-phase
    ``item_purchase`` for that player+weapon def (warmup buys do not count).
    Glock-18/USP-S/P2000 instead qualify only from a fresh-spawn loadout snapshot,
    before a player can pick up another player's pistol. Knives/gloves are unchanged;
    agents, music kits, and C4 are deliberately omitted from the cosmetics page.
    """
    parse_skins = getattr(parser, "parse_skins", None)
    rows: list[dict[str, Any]] = []
    if callable(parse_skins):
        try:
            rows = _records_from_columns(parse_skins())
        except Exception as exc:  # noqa: BLE001 - cosmetics never block analysis
            logger.info("CS2 owned cosmetic metadata unavailable: %s", exc)

    start_tick = int(match_start_tick or 0)
    live_sample_ticks = sample_ticks
    if start_tick > 0 and sample_ticks is not None:
        live_sample_ticks = [tick for tick in sample_ticks if int(tick) >= start_tick]
    starter_snapshot_ticks = _live_spawn_snapshot_ticks(parser, start_tick)
    if starter_snapshot_ticks:
        live_sample_ticks = sorted(
            set(int(tick) for tick in live_sample_ticks or []) | set(starter_snapshot_ticks)
        )

    context = _sample_player_context(
        parser,
        live_sample_ticks,
        known_steamids=[_safe_text(row.get("steamid")) for row in rows],
        starter_snapshot_ticks=starter_snapshot_ticks,
    )
    item_teams = context["item_teams"]
    item_accounts = context["item_accounts"]
    item_stickers = context["item_stickers"]
    observed_items = context["observed_items"]
    default_weapons = context["default_weapons"]
    pawn_gloves = context["pawn_gloves"]
    starter_pistol_defs = context["starter_pistol_defs"]
    starter_pistol_item_ids = context["starter_pistol_item_ids"]
    live_weapon_buys = (
        _live_weapon_purchase_defs(parser, start_tick) if start_tick > 0 else None
    )

    def weapon_allowed(steamid: str, def_index: int) -> bool:
        return (
            live_weapon_buys is None
            or def_index in live_weapon_buys.get(steamid, set())
            or def_index in starter_pistol_defs.get(steamid, set())
        )

    grouped: dict[str, dict[tuple[Any, ...], dict[str, Any]]] = {}
    for row in rows:
        entry = _skin_entry(row)
        if not entry:
            continue
        if (
            entry.get("type") in {"agent", "musickit"}
            or str(entry.get("model") or "").lower() == "c4"
            or int(entry.get("def_index") or 0) == 49
        ):
            continue
        item_id = _safe_int(row.get("item_id"))
        skin_table_steamid = _safe_text(row.get("steamid"))
        steamid = item_accounts.get(item_id or 0, skin_table_steamid)
        if not steamid:
            continue
        # Knife rows are especially prone to entity-owner drift. Require the
        # weapon economy account to resolve back to a participant before the
        # item can be shown under a player.
        if entry.get("type") == "melee" and item_accounts.get(item_id or 0) != steamid:
            continue
        if entry.get("type") == "weapon" and live_weapon_buys is not None:
            def_index = int(entry["def_index"])
            if not weapon_allowed(steamid, def_index):
                continue
        signature: tuple[Any, ...] = (
            ("item", item_id)
            if item_id is not None and item_id > 0
            else (
                "finish",
                entry["def_index"],
                entry["paint_index"],
                entry.get("paint_seed"),
                entry.get("paint_wear"),
                entry.get("custom_name", ""),
            )
        )
        entry["owner_steamid64"] = steamid
        entry["ownership_evidence"] = "demo_skin_table"
        entry["stickers"] = item_stickers.get((steamid, item_id or 0), [])
        observed = set(item_teams.get((steamid, item_id or 0), set()))
        pawn_glove = pawn_gloves.get((steamid, item_id or 0))
        if pawn_glove:
            observed.update(pawn_glove.get("observed_teams") or [])
            entry["evidence_observations"] = pawn_glove.get("evidence_observations", 0)
        entry["observed_teams"] = sorted(observed, key=("t", "ct").index)
        grouped.setdefault(steamid, {}).setdefault(signature, entry)

    for (steamid, item_id), observed_entry in observed_items.items():
        if (
            live_weapon_buys is not None
            and str(observed_entry.get("type") or "") == "weapon"
        ):
            try:
                def_index = int(observed_entry.get("def_index"))
            except (TypeError, ValueError):
                continue
            if not weapon_allowed(steamid, def_index):
                continue
        owner_entries = grouped.setdefault(steamid, {})
        matching = next((
            entry
            for entry in owner_entries.values()
            if int(entry.get("item_id") or 0) == item_id
            or (
                int(entry.get("def_index") or 0) == int(observed_entry.get("def_index") or 0)
                and int(entry.get("paint_index") or 0) == int(observed_entry.get("paint_index") or 0)
                and entry.get("paint_seed") == observed_entry.get("paint_seed")
                and entry.get("paint_wear") == observed_entry.get("paint_wear")
            )
        ), None)
        if matching is not None:
            # parse_skins() is useful ownership/string-table evidence, but the
            # sampled weapon entity is the protocol-final baseline -> delta state.
            # Replace the cosmetic snapshot for this exact item ID rather than
            # allowing a stale/default skin-table value to win.  Preserve a custom
            # name only when the entity snapshot does not expose one.
            custom_name = matching.get("custom_name")
            prior_teams = set(matching.get("observed_teams") or [])
            prior_stickers = list(matching.get("stickers") or [])
            matching.update(observed_entry)
            if custom_name and not matching.get("custom_name"):
                matching["custom_name"] = custom_name
            matching["observed_teams"] = sorted(
                prior_teams
                | set(observed_entry.get("observed_teams") or []),
                key=("t", "ct").index,
            )
            if len(prior_stickers) > len(matching.get("stickers") or []):
                matching["stickers"] = prior_stickers
            continue
        # A real asset ID plus its economy account is sufficient for weapons.
        # Melee additionally needs that account's player to hold the asset at two
        # sampled ticks, filtering one-off pickups and transient server state.
        item_type = str(observed_entry.get("type") or "")
        observations = int(observed_entry.get("evidence_observations") or 0)
        if item_type == "weapon" or (item_type == "melee" and observations >= 2):
            owner_entries.setdefault(("item", item_id), observed_entry)

    for (steamid, def_index), default_entry in default_weapons.items():
        if not weapon_allowed(steamid, def_index):
            continue
        owner_entries = grouped.setdefault(steamid, {})
        # Prefer a real economy-backed finish for the same definition when present.
        if any(
            int(entry.get("def_index") or 0) == def_index
            and int(entry.get("item_id") or 0) > 0
            for entry in owner_entries.values()
        ):
            continue
        owner_entries.setdefault(("default", def_index), default_entry)

    for steamid, definitions in starter_pistol_defs.items():
        owner_entries = grouped.setdefault(steamid, {})
        for def_index in sorted(definitions):
            matching = [
                (key, entry)
                for key, entry in owner_entries.items()
                if str(entry.get("type") or "") == "weapon"
                and int(entry.get("def_index") or 0) == def_index
            ]
            starter_ids = starter_pistol_item_ids.get((steamid, def_index), set())
            precise = [
                entry
                for _key, entry in matching
                if int(entry.get("item_id") or 0) in starter_ids
            ]
            durable = [
                entry
                for _key, entry in matching
                if int(entry.get("item_id") or 0) > 0
                and str(entry.get("ownership_evidence") or "") in {
                    "weapon_account_id",
                    "demo_skin_table",
                }
            ]
            defaults = [
                entry
                for _key, entry in matching
                if str(entry.get("ownership_evidence") or "") == "default_weapon_no_econ_id"
            ]
            chosen = (
                precise[0] if len(precise) == 1
                else durable[0] if len(durable) == 1
                else defaults[0] if defaults
                else None
            )
            if chosen is None:
                chosen = _skin_entry({
                    "def_index": def_index,
                    "paint_index": 0,
                    "paint_seed": None,
                    "paint_wear": None,
                    "item_id": None,
                    "custom_name": None,
                })
                if chosen:
                    chosen.update({
                        "owner_steamid64": steamid,
                        "ownership_evidence": "spawn_loadout_default_pistol",
                        "stickers": [],
                        "evidence_observations": 1,
                    })
            for key, _entry in matching:
                owner_entries.pop(key, None)
            if chosen:
                side = "t" if def_index == 4 else "ct"
                chosen["observed_teams"] = sorted(
                    set(chosen.get("observed_teams") or []) | {side},
                    key=("t", "ct").index,
                )
                owner_entries[("starter_pistol", def_index)] = chosen

    for (steamid, item_id), glove_entry in pawn_gloves.items():
        owner_entries = grouped.setdefault(steamid, {})
        if any(int(entry.get("item_id") or 0) == item_id for entry in owner_entries.values()):
            continue
        owner_entries.setdefault(("item", item_id), glove_entry)

    priority = {"melee": 0, "glove": 1, "weapon": 2, "utility": 3}
    return {
        steamid: sorted(
            entries.values(),
            key=lambda entry: (
                priority.get(str(entry.get("type") or ""), 99),
                str(entry.get("name_en") or "").lower(),
                int(entry.get("item_id") or 0),
            ),
        )
        for steamid, entries in grouped.items()
        if entries
    }


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
