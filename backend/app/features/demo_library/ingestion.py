"""Register discovered demo files without parsing them."""

from __future__ import annotations

import asyncio
import logging
import re
from datetime import datetime, timezone
from pathlib import Path

from ...app_state import application_state
from ...databases import demo_db
from ...demo_library_hub import demo_library_hub
from ...demo_watcher import _demo_ingest_md5_enabled
from ...file_hash import file_md5_hex

logger = logging.getLogger(__name__)

_ENQUEUE_STRIPE_COUNT = 64
_enqueue_striped_init_lock = asyncio.Lock()
_enqueue_striped_locks: list[asyncio.Lock] = []


def infer_demo_source(filename: str, server_name: str | None = None) -> str:
    fn = filename.lower()
    sn = (server_name or "").lower()
    if "faceit" in sn:
        return "Faceit"
    if "5eplay" in sn or "5e" in sn:
        return "5E"
    if "完美世界" in sn or "wanmei" in sn:
        return "Perfect World"
    if "valve" in sn:
        return "Matchmaking"
    if "esl" in sn:
        return "ESL"
    if "esea" in sn:
        return "ESEA"
    if "blast" in sn:
        return "Blast"
    if "pgl" in sn:
        return "PGL"
    if "starladder" in sn:
        return "StarLadder"
    if "flashpoint" in sn:
        return "Flashpoint"
    if "challengermode" in sn:
        return "Challengermode"

    if re.match(r"^g\d+-", fn):
        return "5E"
    if re.match(r"^\d+_team", fn):
        return "Faceit"
    if "faceit" in fn:
        return "Faceit"
    if "5e" in fn:
        return "5E"
    if "perfectworld" in fn or "pvp" in fn:
        return "Perfect World"
    if "match730" in fn or "matchmaking" in fn:
        return "Matchmaking"
    if "esl" in fn:
        return "ESL"
    if "esea" in fn:
        return "ESEA"
    return "Local/Other"


async def enqueue_demo_path(path: Path, origin_zip: str | None = None) -> None:
    """Register one demo as pending, with optional content-hash deduplication."""
    global _enqueue_striped_locks

    use_md5 = demo_db.ingest_md5_supported and _demo_ingest_md5_enabled()
    async with _enqueue_striped_init_lock:
        if not _enqueue_striped_locks:
            _enqueue_striped_locks = [asyncio.Lock() for _ in range(_ENQUEUE_STRIPE_COUNT)]

    demo_path = str(path.resolve())
    stripe = (hash(demo_path) & 0x7FFFFFFF) % _ENQUEUE_STRIPE_COUNT
    async with _enqueue_striped_locks[stripe]:
        size: int | None = None
        mtime_iso: str | None = None
        try:
            stat = path.stat()
            size = stat.st_size
            mtime_iso = datetime.fromtimestamp(stat.st_mtime, tz=timezone.utc).isoformat()
        except OSError:
            pass

        source = infer_demo_source(path.name)
        watcher = application_state.demo_watcher
        watch_root = watcher.watch_root_for(path) if watcher is not None else None

        md5_hex: str | None = None
        if use_md5:
            try:
                md5_hex = await asyncio.to_thread(file_md5_hex, path)
            except OSError as exc:
                logger.warning(
                    "Demo file md5 failed, continue without md5 dedupe: %s (%s)",
                    demo_path,
                    exc,
                )
            if md5_hex and await demo_db.content_md5_exists(md5_hex):
                logger.info("Skip enqueue duplicate demo content (md5): %s", demo_path)
                return

        _, inserted = await demo_db.add_demo(
            demo_path,
            file_size=size,
            source=source,
            status="pending",
            added_at=mtime_iso,
            content_md5=md5_hex if use_md5 else None,
            origin_zip=origin_zip if use_md5 else None,
            watch_root=watch_root,
        )
        if not inserted:
            if use_md5 and md5_hex:
                await demo_db.update_demo_content_md5_if_absent(demo_path, md5_hex, origin_zip)
            return

        # Discovery deliberately stops at registration. Metadata and scoreboard
        # extraction happen once, when the user confirms library ingestion.

    await demo_library_hub.notify("enqueue")
