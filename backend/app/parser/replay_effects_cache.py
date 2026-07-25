"""Disk cache for full-demo sparse smoke/inferno effect tracks.

v1 cached raw grenade rows (often multi-GB with voxel bytes) and made
round switches slower than a fresh parse. v2 stores only built tracks.
"""

from __future__ import annotations

import hashlib
import logging
import pickle
import time
from pathlib import Path
from typing import Any

logger = logging.getLogger(__name__)

CACHE_VERSION = 4


def _cache_root() -> Path:
    try:
        from app.env_utils import get_data_dir

        root = get_data_dir() / "replay-effects-cache"
    except Exception:
        root = Path.cwd() / "data" / "replay-effects-cache"
    root.mkdir(parents=True, exist_ok=True)
    return root


def demo_cache_key(demo_path: str) -> str | None:
    try:
        path = Path(demo_path).resolve()
        stat = path.stat()
    except OSError:
        return None
    digest = hashlib.sha256(
        f"{CACHE_VERSION}|{path}|{stat.st_mtime_ns}|{stat.st_size}".encode("utf-8", errors="replace")
    ).hexdigest()[:40]
    return digest


def _cleanup_stale_cache_files(keep_name: str | None = None) -> None:
    """Drop oversized legacy v1 pickles and other stale entries."""
    root = _cache_root()
    for path in root.glob("*.pkl"):
        if keep_name and path.name == keep_name:
            continue
        try:
            # Legacy raw-row caches were multi-GB; tracks caches are tiny.
            if path.stat().st_size > 64 * 1024 * 1024:
                path.unlink(missing_ok=True)
                logger.info("removed oversized replay-effects cache %s", path.name)
        except OSError:
            pass


def load_tracks(demo_path: str) -> dict[str, Any] | None:
    key = demo_cache_key(demo_path)
    if not key:
        return None
    path = _cache_root() / f"{key}.pkl"
    if not path.is_file():
        _cleanup_stale_cache_files()
        return None
    try:
        with path.open("rb") as handle:
            payload = pickle.load(handle)
    except Exception as exc:  # noqa: BLE001
        logger.warning("replay effects track cache load failed: %s", exc)
        try:
            path.unlink(missing_ok=True)
        except OSError:
            pass
        return None
    if not isinstance(payload, dict) or payload.get("version") != CACHE_VERSION:
        try:
            path.unlink(missing_ok=True)
        except OSError:
            pass
        return None
    if not isinstance(payload.get("tracks"), list):
        return None
    return payload


def save_tracks(
    demo_path: str,
    *,
    tracks: list[dict[str, Any]],
    capabilities: dict[str, Any],
    warnings: list[str] | None = None,
) -> None:
    key = demo_cache_key(demo_path)
    if not key:
        return
    root = _cache_root()
    path = root / f"{key}.pkl"
    tmp = path.with_suffix(".pkl.partial")
    payload = {
        "version": CACHE_VERSION,
        "saved_at": time.time(),
        "demo_path": str(demo_path),
        "tracks": tracks,
        "capabilities": capabilities or {},
        "warnings": list(warnings or []),
    }
    try:
        with tmp.open("wb") as handle:
            pickle.dump(payload, handle, protocol=pickle.HIGHEST_PROTOCOL)
        tmp.replace(path)
        _cleanup_stale_cache_files(keep_name=path.name)
        logger.info(
            "replay effects track cache saved key=%s tracks=%s bytes=%s",
            key,
            len(tracks),
            path.stat().st_size,
        )
    except Exception as exc:  # noqa: BLE001
        logger.warning("replay effects track cache save failed: %s", exc)
        try:
            tmp.unlink(missing_ok=True)
        except OSError:
            pass


def filter_tracks_for_window(
    tracks: list[dict[str, Any]],
    *,
    start_tick: int,
    end_tick: int,
) -> list[dict[str, Any]]:
    """Keep tracks overlapping the replay window; preserve pre-window sample state."""
    out: list[dict[str, Any]] = []
    for track in tracks:
        try:
            track_start = int(track.get("start_tick"))
            track_end = int(track.get("end_tick"))
        except (TypeError, ValueError):
            continue
        if track_end < start_tick or track_start > end_tick:
            continue
        samples = list(track.get("samples") or [])
        useful: list[dict[str, Any]] = []
        pre: dict[str, Any] | None = None
        for sample in samples:
            try:
                sample_tick = int(sample.get("tick"))
            except (TypeError, ValueError):
                continue
            if sample_tick < start_tick:
                pre = sample
                continue
            if sample_tick > end_tick:
                break
            useful.append(sample)
        if pre is not None and (not useful or int(useful[0]["tick"]) > start_tick):
            useful = [{**pre, "tick": start_tick}, *useful]
        if not useful and pre is None:
            continue
        clipped = dict(track)
        clipped["start_tick"] = max(track_start, start_tick)
        clipped["end_tick"] = min(track_end, end_tick)
        clipped["samples"] = useful or ([pre] if pre is not None else [])
        out.append(clipped)
    return out
