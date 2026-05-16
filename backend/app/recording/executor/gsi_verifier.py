import asyncio
import logging
from typing import Optional

from ...gsi_ready import gsi_status

logger = logging.getLogger(__name__)

class SpecVerifyError(Exception):
    pass

async def get_current_player_steamid() -> Optional[str]:
    """
    Read the current spectated player's steamid64 from GSI payload.
    Returns None if GSI data is unavailable or doesn't have player.steamid.
    """
    payload = gsi_status()
    if not isinstance(payload, dict):
        return None
    player = payload.get("player")
    if not isinstance(player, dict):
        return None
    for key in ("steamid", "steam_id", "xuid", "id"):
        val = player.get(key)
        if val and str(val).strip():
            return str(val).strip()
    # Also check allplayers for the observed player
    allplayers = payload.get("allplayers")
    if isinstance(allplayers, dict):
        for pid, row in allplayers.items():
            if not isinstance(row, dict):
                continue
            obs = row.get("observer_slot")
            if obs == 0 or obs == "0":  # slot 0 = currently spectated
                for key in ("steamid", "steam_id", "xuid", "id"):
                    val = row.get(key)
                    if val and str(val).strip():
                        return str(val).strip()
    return None

async def verify_spec_target(
    expected_steamid64: str,
    max_retries: int = 5,
    retry_interval_sec: float = 0.4,
) -> bool:
    """
    Poll GSI to verify the current spectated player matches expected_steamid64.
    Returns True if verified, False if exhausted retries.
    If expected_steamid64 is empty, returns True (no verification needed).
    """
    if not expected_steamid64:
        return True
    for attempt in range(max_retries):
        current = await get_current_player_steamid()
        if current and current == expected_steamid64:
            return True
        if attempt < max_retries - 1:
            await asyncio.sleep(retry_interval_sec)
    logger.warning(
        "spec verify failed: expected %s, last seen %s after %d retries",
        expected_steamid64,
        current,
        max_retries,
    )
    return False
