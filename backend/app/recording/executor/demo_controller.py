import asyncio
import logging
import time
from typing import Optional

logger = logging.getLogger(__name__)

# Non-Windows: inject_console_sequence is a no-op
try:
    from ...win_cs2_console import inject_console_sequence
except ImportError:
    def inject_console_sequence(lines): pass

class DemoSeekError(Exception):
    pass

async def gototick(tick: int, verify_tolerance_ticks: int = 32) -> None:
    """
    Send demo_gototick command and wait for CS2 to seek.

    Since we cannot read the current demo tick from outside CS2,
    this function sends the command and waits a fixed delay.
    The caller is responsible for verifying the seek succeeded
    (e.g., via GSI or by trusting the delay).

    Raises DemoSeekError on platform failure.
    """
    cmds = ["demo_pause", f"demo_gototick {int(tick)}"]
    try:
        await asyncio.to_thread(inject_console_sequence, cmds)
    except Exception as e:
        raise DemoSeekError(f"gototick {tick} failed: {e}") from e
    # Wait for seek to complete (CS2 async disk read)
    await asyncio.sleep(1.2)

async def demo_resume() -> None:
    """Send demo_resume to CS2."""
    try:
        await asyncio.to_thread(inject_console_sequence, ["demo_resume"])
    except Exception as e:
        logger.warning("demo_resume failed: %s", e)

async def demo_pause() -> None:
    """Send demo_pause to CS2."""
    try:
        await asyncio.to_thread(inject_console_sequence, ["demo_pause"])
    except Exception as e:
        logger.warning("demo_pause failed: %s", e)
