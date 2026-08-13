"""Disk cache for full-demo sparse smoke/inferno effect tracks.

v1 cached raw grenade rows (often multi-GB with voxel bytes) and made
round switches slower than a fresh parse. v2 stores only built tracks.
"""

from __future__ import annotations

import hashlib
import json
import logging
import os
import pickle
import time
from pathlib import Path
from typing import Any

from .replay_cache_storage import (
    replay_cache_namespace_root,
    replay_cache_namespace_roots,
)
from .replay_cache_owners import invalidate_owner_index, register_replay_cache_entry

logger = logging.getLogger(__name__)

# Bump when smoke/inferno track geometry decoding changes (axes, packing, etc.).
CACHE_VERSION = 7


def _cache_root() -> Path:
    return replay_cache_namespace_root("effects")


def _cache_roots() -> tuple[Path, ...]:
    primary = _cache_root()
    roots = [primary]
    for candidate in replay_cache_namespace_roots("effects", create_primary=False):
        if candidate not in roots:
            roots.append(candidate)
    return tuple(roots)


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
    for root in _cache_roots():
        for path in root.glob("*.pkl"):
            if keep_name and path.name == keep_name:
                continue
            try:
                # Legacy raw-row caches were multi-GB; tracks caches are tiny.
                if path.stat().st_size > 64 * 1024 * 1024:
                    path.unlink(missing_ok=True)
                    path.with_suffix(".meta.json").unlink(missing_ok=True)
                    logger.info("removed oversized replay-effects cache %s", path.name)
            except OSError:
                pass


def load_tracks(demo_path: str) -> dict[str, Any] | None:
    key = demo_cache_key(demo_path)
    if not key:
        return None
    path = next(
        (root / f"{key}.pkl" for root in _cache_roots() if (root / f"{key}.pkl").is_file()),
        None,
    )
    if path is None:
        _cleanup_stale_cache_files()
        return None
    try:
        with path.open("rb") as handle:
            payload = pickle.load(handle)
    except Exception as exc:  # noqa: BLE001
        logger.warning("replay effects track cache load failed: %s", exc)
        try:
            path.unlink(missing_ok=True)
            path.with_suffix(".meta.json").unlink(missing_ok=True)
        except OSError:
            pass
        return None
    if not isinstance(payload, dict) or payload.get("version") != CACHE_VERSION:
        try:
            path.unlink(missing_ok=True)
            path.with_suffix(".meta.json").unlink(missing_ok=True)
        except OSError:
            pass
        return None
    if not isinstance(payload.get("tracks"), list):
        return None
    return payload


def remove_tracks_for_demos(
    demo_paths: list[str],
    *,
    register_survivors: bool = False,
) -> dict[str, int]:
    """Remove sparse-effects entries for several Demo paths in one traversal."""
    normalized_to_key = {
        os.path.normcase(os.path.abspath(os.path.expanduser(str(path)))): demo_cache_key(path)
        for path in demo_paths
    }
    wanted = set(normalized_to_key)
    removed_files = 0
    removed_bytes = 0
    seen: set[str] = set()
    for root in _cache_roots():
        if not root.is_dir():
            continue
        matched_keys = {key for key in normalized_to_key.values() if key}
        for meta_path in root.glob("*.meta.json"):
            try:
                payload = json.loads(meta_path.read_text(encoding="utf-8"))
                cached_path = payload.get("demo_path") if isinstance(payload, dict) else None
                if not cached_path:
                    continue
                normalized_cached_path = os.path.normcase(
                    os.path.abspath(os.path.expanduser(str(cached_path)))
                )
                cache_key = meta_path.name.removesuffix(".meta.json")
                if normalized_cached_path in wanted:
                    matched_keys.add(cache_key)
                elif register_survivors:
                    register_replay_cache_entry(
                        "effects",
                        str(cached_path),
                        cache_key,
                        (root / f"{cache_key}.pkl", meta_path),
                    )
            except Exception as exc:  # noqa: BLE001 - cleanup skips unknown files
                logger.warning("replay effects cache metadata read failed for %s: %s", meta_path, exc)
        for matched_key in matched_keys:
            for path in (root / f"{matched_key}.pkl", root / f"{matched_key}.meta.json"):
                path_key = str(path.absolute()).casefold()
                if path_key in seen or not path.is_file():
                    continue
                seen.add(path_key)
                try:
                    size = int(path.stat().st_size)
                    path.unlink(missing_ok=True)
                    removed_files += 1
                    removed_bytes += size
                except OSError as exc:
                    logger.warning("replay effects cache cleanup failed for %s: %s", path, exc)
    return {"removed_files": removed_files, "removed_bytes": removed_bytes}


def remove_tracks_for_demo(demo_path: str) -> dict[str, int]:
    """Remove sparse-effects entries attributed to one Demo path."""
    return remove_tracks_for_demos([demo_path])


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
    meta_path = root / f"{key}.meta.json"
    meta_tmp = root / f"{key}.meta.json.partial"
    resolved_demo_path = str(Path(demo_path).resolve())
    payload = {
        "version": CACHE_VERSION,
        "saved_at": time.time(),
        "demo_path": resolved_demo_path,
        "tracks": tracks,
        "capabilities": capabilities or {},
        "warnings": list(warnings or []),
    }
    try:
        with tmp.open("wb") as handle:
            pickle.dump(payload, handle, protocol=pickle.HIGHEST_PROTOCOL)
        meta_tmp.write_text(
            json.dumps(
                {
                    "version": CACHE_VERSION,
                    "demo_path": resolved_demo_path,
                    "cache_key": key,
                },
                ensure_ascii=False,
                separators=(",", ":"),
            ),
            encoding="utf-8",
        )
        tmp.replace(path)
        meta_tmp.replace(meta_path)
        try:
            register_replay_cache_entry(
                "effects",
                resolved_demo_path,
                key,
                (path, meta_path),
            )
        except OSError as exc:
            invalidate_owner_index()
            logger.warning("replay effects owner index update failed: %s", exc)
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
            meta_tmp.unlink(missing_ok=True)
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
