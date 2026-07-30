"""Compact CS2 weapon/finish catalog generated from ianlucas/cs2-lib."""

from __future__ import annotations

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
_ALIAS_SEPARATORS = re.compile(r"[\s-]+")
_ALIAS_PUNCTUATION = re.compile(r"[^\w]+", flags=re.UNICODE)


@lru_cache(maxsize=1)
def load_cs2_item_catalog() -> dict[str, Any]:
    payload = json.loads(_CATALOG_PATH.read_text(encoding="utf-8"))
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
        return int(float(value))
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


def _sample_player_context(
    parser: object,
    ticks: Sequence[int] | None,
) -> dict[str, Any]:
    """Return cosmetic evidence sampled from weapon, pawn and controller entities."""
    empty = {
        "item_teams": {},
        "player_teams": {},
        "music_kits": {},
        "item_stickers": {},
        "observed_items": {},
        "pawn_gloves": {},
        "agents": {},
    }
    if not ticks:
        return empty
    parse_ticks = getattr(parser, "parse_ticks", None)
    if not callable(parse_ticks):
        return empty
    wanted = [
        "item_id_high",
        "item_id_low",
        "active_weapon_original_owner",
        "weapon_stickers",
        "item_def_idx",
        "weapon_skin_id",
        "weapon_paint_seed",
        "weapon_float",
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
    ]
    try:
        rows = _records_from_columns(parse_ticks(wanted, ticks=sorted(set(int(tick) for tick in ticks))))
    except Exception as exc:  # noqa: BLE001 - optional evidence enrichment
        logger.info("CS2 cosmetic side/music metadata unavailable: %s", exc)
        return empty

    item_teams: dict[tuple[str, int], set[str]] = {}
    player_teams: dict[str, set[str]] = {}
    music_kits: dict[str, set[int]] = {}
    item_stickers: dict[tuple[str, int], list[dict[str, Any]]] = {}
    observed_items: dict[tuple[str, int], dict[str, Any]] = {}
    pawn_gloves: dict[tuple[str, int], dict[str, Any]] = {}
    agents: dict[tuple[str, int], dict[str, Any]] = {}
    for row in rows:
        steamid = _safe_text(row.get("steamid"))
        original_owner = _safe_text(row.get("active_weapon_original_owner"))
        team_number = _safe_int(row.get("team_num"))
        team = "t" if team_number == 2 else "ct" if team_number == 3 else ""
        tick = _safe_int(row.get("tick"))
        if not steamid:
            continue
        if team:
            player_teams.setdefault(steamid, set()).add(team)
        item_id = _compose_item_id(row.get("item_id_high"), row.get("item_id_low"))
        if item_id is not None:
            if original_owner and original_owner != "0":
                if team and original_owner == steamid:
                    item_teams.setdefault((original_owner, item_id), set()).add(team)
                resolved_stickers = []
                for slot, sticker in enumerate(row.get("weapon_stickers") or []):
                    if not isinstance(sticker, Mapping):
                        continue
                    resolved = resolve_cs2_sticker(sticker.get("id"))
                    if not resolved:
                        continue
                    wear = _safe_float(sticker.get("wear"))
                    if wear is not None and 0.0 <= wear <= 1.0:
                        resolved["wear"] = 0.0 if wear < 0.000001 else wear
                    resolved["slot"] = slot
                    resolved_stickers.append(resolved)
                key = (original_owner, item_id)
                if len(resolved_stickers) > len(item_stickers.get(key, [])):
                    item_stickers[key] = resolved_stickers
                if re.fullmatch(r"\d{15,20}", original_owner):
                    observed_entry = _skin_entry({
                        "def_index": row.get("item_def_idx"),
                        "paint_index": row.get("weapon_skin_id"),
                        "paint_seed": row.get("weapon_paint_seed"),
                        "paint_wear": row.get("weapon_float"),
                        "item_id": item_id,
                        "custom_name": None,
                    })
                    if (
                        observed_entry
                        and observed_entry.get("catalog_exact")
                        and int(observed_entry.get("paint_index") or 0) > 0
                    ):
                        observed_entry.update({
                            "owner_steamid64": original_owner,
                            "ownership_evidence": "active_weapon_original_owner",
                            "observed_teams": [team] if team and original_owner == steamid else [],
                            "stickers": resolved_stickers,
                            "evidence_observations": 0,
                            "_owner_observation_ticks": set(),
                        })
                        previous = observed_items.get(key)
                        if previous is None:
                            observed_items[key] = observed_entry
                            previous = observed_entry
                        elif len(resolved_stickers) > len(previous.get("stickers") or []):
                            previous["stickers"] = resolved_stickers
                        if team and original_owner == steamid:
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
            pawn_catalog_item = resolve_cs2_item(pawn_def, 0)
            if pawn_catalog_item and str(pawn_catalog_item.get("type") or "") == "glove":
                attribute_def = _safe_int(row.get("CCSPlayerPawn.CEconItemAttribute.m_iAttributeDefinitionIndex"))
                glove_entry = _skin_entry({
                    "def_index": pawn_def,
                    "paint_index": 0,
                    "paint_seed": None,
                    "paint_wear": (
                        row.get("CCSPlayerPawn.CEconItemAttribute.m_flInitialValue")
                        if attribute_def == 8
                        else None
                    ),
                    "item_id": pawn_item_id,
                    "custom_name": row.get("CCSPlayerPawn.m_szCustomName"),
                })
                if glove_entry:
                    glove_key = (steamid, pawn_item_id)
                    previous_glove = pawn_gloves.get(glove_key)
                    if previous_glove is None:
                        glove_entry.update({
                            "owner_steamid64": steamid,
                            "ownership_evidence": "player_pawn_econ_item_id",
                            "finish_evidence": "base_definition_and_wear_only",
                            "observed_teams": [team] if team else [],
                            "stickers": [],
                            "evidence_observations": 0,
                            "_observation_ticks": set(),
                        })
                        pawn_gloves[glove_key] = glove_entry
                        previous_glove = glove_entry
                    elif team:
                        previous_glove["observed_teams"] = sorted(
                            set(previous_glove.get("observed_teams") or []) | {team},
                            key=("t", "ct").index,
                        )
                    if glove_entry.get("paint_wear") is not None:
                        previous_glove["paint_wear"] = glove_entry["paint_wear"]
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

    for entry in observed_items.values():
        entry["evidence_observations"] = len(entry.pop("_owner_observation_ticks", set()))
    for collection in (pawn_gloves, agents):
        for entry in collection.values():
            entry["evidence_observations"] = len(entry.pop("_observation_ticks", set()))
    return {
        "item_teams": item_teams,
        "player_teams": player_teams,
        "music_kits": music_kits,
        "item_stickers": item_stickers,
        "observed_items": observed_items,
        "pawn_gloves": pawn_gloves,
        "agents": agents,
    }


def build_player_cosmetic_inventory(
    parser: object,
    *,
    sample_ticks: Sequence[int] | None = None,
) -> dict[str, list[dict[str, Any]]]:
    """Build evidence-only owned cosmetics keyed by their owner SteamID.

    Ownership comes from SteamID-bearing demo economy entities. A stable active
    melee item additionally requires repeated OriginalOwnerXuid observations.
    """
    parse_skins = getattr(parser, "parse_skins", None)
    rows: list[dict[str, Any]] = []
    if callable(parse_skins):
        try:
            rows = _records_from_columns(parse_skins())
        except Exception as exc:  # noqa: BLE001 - cosmetics never block analysis
            logger.info("CS2 owned cosmetic metadata unavailable: %s", exc)

    context = _sample_player_context(parser, sample_ticks)
    item_teams = context["item_teams"]
    player_teams = context["player_teams"]
    music_kits = context["music_kits"]
    item_stickers = context["item_stickers"]
    observed_items = context["observed_items"]
    pawn_gloves = context["pawn_gloves"]
    agents = context["agents"]
    grouped: dict[str, dict[tuple[Any, ...], dict[str, Any]]] = {}
    for row in rows:
        steamid = _safe_text(row.get("steamid"))
        entry = _skin_entry(row)
        if not steamid or not entry:
            continue
        item_id = _safe_int(row.get("item_id"))
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
            matching["observed_teams"] = sorted(
                set(matching.get("observed_teams") or [])
                | set(observed_entry.get("observed_teams") or []),
                key=("t", "ct").index,
            )
            if len(observed_entry.get("stickers") or []) > len(matching.get("stickers") or []):
                matching["stickers"] = observed_entry["stickers"]
            continue
        # A real asset ID plus OriginalOwnerXuid is sufficient for weapons.
        # Melee additionally needs the owner to hold the same asset at two
        # sampled ticks, filtering one-off pickups and transient server state.
        item_type = str(observed_entry.get("type") or "")
        observations = int(observed_entry.get("evidence_observations") or 0)
        if item_type == "weapon" or (item_type == "melee" and observations >= 2):
            owner_entries.setdefault(("item", item_id), observed_entry)

    for (steamid, item_id), glove_entry in pawn_gloves.items():
        owner_entries = grouped.setdefault(steamid, {})
        if any(int(entry.get("item_id") or 0) == item_id for entry in owner_entries.values()):
            continue
        owner_entries.setdefault(("item", item_id), glove_entry)

    for (steamid, agent_def), agent_entry in agents.items():
        grouped.setdefault(steamid, {}).setdefault(("agent", agent_def), agent_entry)

    for steamid, kit_ids in music_kits.items():
        for kit_id in kit_ids:
            item = resolve_cs2_item(1314, kit_id)
            if not item or str(item.get("type") or "") != "musickit":
                continue
            entry = _skin_entry({
                "def_index": 1314,
                "paint_index": kit_id,
                "paint_seed": None,
                "paint_wear": None,
                "custom_name": None,
            })
            if not entry:
                continue
            entry.update({
                "owner_steamid64": steamid,
                "ownership_evidence": "demo_player_controller_music_kit",
                "observed_teams": sorted(player_teams.get(steamid, set()), key=("t", "ct").index),
                "stickers": [],
            })
            grouped.setdefault(steamid, {}).setdefault(("music", kit_id), entry)

    priority = {"melee": 0, "glove": 1, "weapon": 2, "agent": 3, "musickit": 4, "utility": 5}
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
