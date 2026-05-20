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
    status = gsi_status()
    if not isinstance(status, dict):
        return None
    # gsi_status() returns a wrapper dict; the actual CS2 payload is in "last_payload"
    payload = status.get("last_payload", {})
    if not isinstance(payload, dict) or not payload:
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
) -> "bool | None":
    """
    Poll GSI to verify the current spectated player matches expected_steamid64.

    Returns:
        True  — GSI confirmed we are spectating expected_steamid64
        None  — GSI was silent for all retries (inconclusive; demo may be paused)
        False — GSI returned data but confirmed a different player (wrong spectate)

    If expected_steamid64 is empty, returns True (no verification needed).
    """
    if not expected_steamid64:
        return True
    last_seen: "str | None" = None
    for attempt in range(max_retries):
        current = await get_current_player_steamid()
        if current:
            last_seen = current
            if current == expected_steamid64:
                return True
            # GSI returned a different player — keep retrying; spec_player may not have
            # taken effect yet even after the initial settle sleep
        if attempt < max_retries - 1:
            await asyncio.sleep(retry_interval_sec)
    # All retries exhausted
    if last_seen is not None:
        # At least one GSI response consistently showed a different player
        logger.warning(
            "spec verify failed: expected %s, last seen %s after %d retries",
            expected_steamid64, last_seen, max_retries,
        )
        return False
    # GSI was silent throughout (demo paused or GSI not updating)
    logger.debug(
        "spec verify inconclusive for %s: GSI silent after %d retries",
        expected_steamid64, max_retries,
    )
    return None
