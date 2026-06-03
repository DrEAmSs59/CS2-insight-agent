import asyncio
import logging
import time
from typing import Optional

logger = logging.getLogger(__name__)

# Non-Windows: stubs
try:
    from ...win_cs2_console import inject_console_sequence, send_cs2_vk_tap
except ImportError:
    def inject_console_sequence(lines): pass
    def send_cs2_vk_tap(vk: int) -> bool: return False

# Numpad keys bound during V3 recording warmup (bind KP_5 demo_pause / bind KP_6 demo_resume).
# These let us pause/resume the demo WITHOUT opening the console (which would appear in OBS capture).
_VK_NUMPAD5 = 0x65  # KP_5 → demo_pause
_VK_NUMPAD6 = 0x66  # KP_6 → demo_resume

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


async def demo_pause_silent() -> None:
    """Send KP_5 key tap to pause demo without opening the console.

    Requires that the V3 recording warmup has injected: bind KP_5 demo_pause
    Use this instead of demo_pause() when OBS is actively recording.
    Falls back to console if the key tap fails (only safe when OBS is NOT recording).
    """
    try:
        ok = await asyncio.to_thread(send_cs2_vk_tap, _VK_NUMPAD5)
        if not ok:
            logger.warning("demo_pause_silent: VK tap failed, falling back to console")
            await asyncio.to_thread(inject_console_sequence, ["demo_pause"])
    except Exception as e:
        logger.warning("demo_pause_silent failed: %s", e)


async def demo_resume_silent() -> None:
    """Send KP_6 key tap to resume demo without opening the console.

    Requires that the V3 recording warmup has injected: bind KP_6 demo_resume
    Use this instead of demo_resume() when OBS is actively recording.
    Falls back to console if the key tap fails (only safe when OBS is NOT recording).
    """
    try:
        ok = await asyncio.to_thread(send_cs2_vk_tap, _VK_NUMPAD6)
        if not ok:
            logger.warning("demo_resume_silent: VK tap failed, falling back to console")
            await asyncio.to_thread(inject_console_sequence, ["demo_resume"])
    except Exception as e:
        logger.warning("demo_resume_silent failed: %s", e)


async def demo_pause_silent_attempt() -> bool:
    """尝试用 KP_5 静默暂停 demo（不打开控制台）。

    成功返回 True，失败返回 False（调用方应降级到 demo_pause()）。
    用于预录制暂停：避免控制台注入期间 demo 继续跑 ~300ms 导致 overlay 偏移。
    """
    try:
        ok = await asyncio.to_thread(send_cs2_vk_tap, _VK_NUMPAD5)
        return bool(ok)
    except Exception as e:
        logger.warning("demo_pause_silent_attempt failed: %s", e)
        return False


async def demo_pause_silent_strict() -> bool:
    """Send KP_5 key tap to pause demo. No console fallback — safe while OBS is recording.

    Returns True if the tap was dispatched successfully, False otherwise.
    NEVER falls back to inject_console_sequence: the console opening would be captured by OBS.
    Use console fallback (demo_pause) only AFTER OBS has confirmed paused/stopped.
    """
    try:
        ok = await asyncio.to_thread(send_cs2_vk_tap, _VK_NUMPAD5)
        if not ok:
            logger.warning("demo_pause_silent_strict: VK tap failed; no console fallback (OBS may be active)")
        return bool(ok)
    except Exception as e:
        logger.warning("demo_pause_silent_strict failed: %s; no console fallback", e)
        return False


async def demo_resume_silent_strict() -> bool:
    """Send KP_6 key tap to resume demo. No console fallback — safe while OBS is recording.

    Returns True if the tap was dispatched successfully, False otherwise.
    NEVER falls back to inject_console_sequence: the console opening would be captured by OBS.
    If this returns False, the caller must pause/stop OBS before falling back to console.
    """
    try:
        ok = await asyncio.to_thread(send_cs2_vk_tap, _VK_NUMPAD6)
        if not ok:
            logger.warning("demo_resume_silent_strict: VK tap failed; no console fallback (OBS may be active)")
        return bool(ok)
    except Exception as e:
        logger.warning("demo_resume_silent_strict failed: %s; no console fallback", e)
        return False
