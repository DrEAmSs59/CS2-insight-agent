"""Resolve cached glove aliases against the immutable demo's owned Pawn evidence."""
from __future__ import annotations

from copy import deepcopy
from functools import lru_cache
import logging
from pathlib import Path

from .cosmetics_skin_plan import CosmeticsSkinPlanError, build_batch_from_plan_json

logger = logging.getLogger(__name__)


def has_glove_entries(plan):
    if not isinstance(plan, dict) or not isinstance(plan.get("items"), list):
        return False
    return any(isinstance(row, dict) and isinstance(row.get("original"), dict)
               and row["original"].get("type") == "glove" for row in plan["items"])


def read_original_glove_inventory(path: Path):
    try:
        with path.open("rb") as source:
            if source.read(8) != b"PBDEMS2\0":
                return None
        stat = path.stat()
        return _read(str(path.resolve()), stat.st_size, stat.st_mtime_ns)
    except Exception:
        logger.warning("Could not recover original glove evidence", exc_info=True)
        return None


@lru_cache(maxsize=16)
def _read(path: str, size: int, mtime: int):
    from demoparser2 import DemoParser
    from .features.demo_analysis.cs2_item_catalog import build_player_cosmetic_inventory

    parser = DemoParser(path)
    ticks = sorted({int(tick) + 128 for tick in parser.parse_event("round_start")["tick"]})
    inventory = build_player_cosmetic_inventory(parser, sample_ticks=ticks)
    stat = Path(path).stat()
    if (stat.st_size, stat.st_mtime_ns) != (size, mtime):
        raise CosmeticsSkinPlanError("Demo source changed while reading glove evidence")
    return {steam: [row for row in rows if row.get("type") == "glove"] for steam, rows in inventory.items()}


def _source(original, team, sources):
    side = str(team or "").lower()
    candidates = [row for row in sources if side not in {"ct", "t"} or side in row.get("observed_teams", [])]
    exact = [row for row in candidates if str(row.get("item_id") or "0") == str(original.get("item_id") or "0")
             and row.get("def_index") == original.get("def_index")]
    selected = exact if len(exact) == 1 else candidates
    if len(selected) != 1:
        raise CosmeticsSkinPlanError("Original glove evidence is missing or ambiguous for this player and side")
    return {**selected[0], "observed_teams": [side] if side in {"ct", "t"} else list(selected[0].get("observed_teams", []))}


def canonical_glove_batch(batch, plan, sources):
    """Keep UI alias keys, but send only source-proven IDs/defs to the ownership gate."""
    if sources is None or not has_glove_entries(plan):
        return batch, plan
    result, display = deepcopy(batch), deepcopy(plan)
    for entry in display["items"]:
        original = entry.get("original", {})
        if original.get("type") != "glove":
            continue
        key = str(entry.get("slot_key") or "")
        side = key.split(":", 1)[0].lower()
        matching = [row for row in result if str(row.get("item_id64")) == str(original.get("item_id") or "0")
                    and (str(row.get("item_id64")) != "0" or row.get("definition_index") == original.get("def_index"))
                    and (side not in {"ct", "t"} or str(row.get("team") or "").lower() == side)]
        if not matching:
            raise CosmeticsSkinPlanError("Glove plan and batch provenance differ")
        if not sources and str(original.get("item_id") or "0") == "0":
            continue  # Existing stock-glove materialization still requires native Pawn ownership.
        source = _source(original, side, sources)
        for row in matching:
            row["item_id64"] = str(source.get("item_id") or "0")
            row["definition_index"] = int(source["def_index"])
        entry["original"] = source
    return result, display


def replay_glove_plan(plan, inventory, sources):
    if sources is None or not has_glove_entries(plan):
        return build_batch_from_plan_json(plan, inventory)
    canonical = deepcopy(plan)
    for entry in canonical["items"]:
        original = entry.get("original", {})
        if original.get("type") != "glove":
            continue
        side = str(entry["slot_key"]).split(":", 1)[0].lower()
        if not sources and str(original.get("item_id") or "0") == "0":
            continue
        source = _source(original, side, sources)
        identity = source.get("item_id")
        base = f"id:{identity}" if identity else f"def:{source['def_index']}"
        entry["slot_key"] = f"{side}:{base}" if side in {"ct", "t"} else base
        entry["original"] = source
    rows = [row for row in inventory if row.get("type") != "glove"] + list(sources)
    return build_batch_from_plan_json(canonical, rows)
