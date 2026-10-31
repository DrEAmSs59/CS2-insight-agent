"""Display provenance for controller cosmetics, separate from native requests."""
from __future__ import annotations

import logging
from pathlib import Path
from typing import Any

SLOTS = ("agent_t", "agent_ct", "music_kit_t", "music_kit_ct")
logger = logging.getLogger(__name__)


def loadout_originals(inventory: list[dict], trusted_plan: dict | None,
                     original_rows: list[dict] | None = None) -> dict[str, list[dict]]:
    plan = trusted_plan or {}
    saved = plan.get("player_loadout_originals", {})
    settings = plan.get("player_loadout", {})
    result = {}
    for field in SLOTS:
        if field in saved and isinstance(saved[field], list):
            result[field] = saved[field]
            continue
        kind = "musickit" if field.startswith("music_kit") else "agent"
        side = field.rsplit("_", 1)[1]
        previously_replaced = field in settings or (kind == "musickit" and "music_kit" in settings)
        # Re-analyzed evidence can already be the replacement. Never call it original.
        rows = original_rows if original_rows is not None else ([] if previously_replaced else inventory)
        result[field] = [dict(row) for row in rows if row.get("type") == kind
                         and side in (row.get("observed_teams") or [])]
    return result


def read_original_loadout(path: Path, steamid: str) -> list[dict[str, Any]] | None:
    """Recover legacy plans from immutable library bytes, never the rewritten cache."""
    try:
        from demoparser2 import DemoParser
        from .features.demo_analysis.cs2_item_catalog import build_player_cosmetic_inventory

        with path.open("rb") as source:
            if source.read(8) != b"PBDEMS2\0":
                return None
        parser = DemoParser(str(path))
        starts = parser.parse_event("round_start")
        ticks = sorted({int(tick) + 128 for tick in starts["tick"]})

        class Controllers:
            def parse_skins(self):
                return {}

            def parse_ticks(self, _wanted, *, ticks):
                return parser.parse_ticks([
                    "team_num", "CCSPlayerController.m_nPawnCharacterDefIndex",
                    "CCSPlayerController.m_iMusicKitID",
                    "CCSPlayerController.CCSPlayerController_InventoryServices.m_unMusicID",
                ], ticks=ticks)

        rows = build_player_cosmetic_inventory(Controllers(), sample_ticks=ticks).get(str(steamid), [])
        return [row for row in rows if row.get("type") in {"agent", "musickit"}]
    except Exception:  # Optional display enrichment must not block a valid rewrite.
        logger.warning("Original controller cosmetics could not be read", exc_info=True)
        return None
