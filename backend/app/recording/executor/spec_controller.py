import asyncio
import logging
from typing import Optional

logger = logging.getLogger(__name__)

try:
    from ...win_cs2_console import inject_console_sequence
except ImportError:
    def inject_console_sequence(lines): pass

async def spec_player(player_name: str, mode: int = 5) -> None:
    """
    Send spec_mode + spec_player commands to CS2.
    mode: 5 = first-person (POV), 4 = chase/third-person, 1 = free
    """
    cmds = [f"spec_mode {mode}", f"spec_player {player_name}"]
    try:
        await asyncio.to_thread(inject_console_sequence, cmds)
    except Exception as e:
        logger.warning("spec_player %s failed: %s", player_name, e)
    # Wait for spec switch to settle
    await asyncio.sleep(0.8)

async def spec_by_slot(slot: int, mode: int = 5) -> None:
    """Send spec_mode + spec_player by numeric slot."""
    cmds = [f"spec_mode {mode}", f"spec_player {int(slot)}"]
    try:
        await asyncio.to_thread(inject_console_sequence, cmds)
    except Exception as e:
        logger.warning("spec_player slot %s failed: %s", slot, e)
    await asyncio.sleep(0.8)
