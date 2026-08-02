# ---------------------------------------------------------------------------------------------
# Copyright (c) unicbm. All rights reserved.
# Licensed under the PolyForm Noncommercial License 1.0.0. See LICENSE in the project root for license information.
# ---------------------------------------------------------------------------------------------

"""Managed on-disk storage for Demo 2D replay assets.

New cache writes live under one application-data subtree so they can be
measured and reclaimed as a unit.  The historical flat directories remain
readable and are included in cleanup until existing installations naturally
migrate away from them.
"""

from __future__ import annotations

import logging
import os
from pathlib import Path
from typing import Any, Iterable

logger = logging.getLogger(__name__)

_NAMESPACE_DIRS = {
    "matches": "matches",
    "frames": "rounds",
    "effects": "effects",
}
_LEGACY_DIRS = {
    "matches": "replay-match",
    "frames": "replay-frames",
    "effects": "replay-effects-cache",
}


def _data_dir() -> Path:
    try:
        from app.env_utils import get_data_dir

        return get_data_dir()
    except Exception:
        return Path.cwd() / "data"


def replay_cache_root(*, create: bool = True) -> Path:
    root = _data_dir() / "cache" / "demo-replay"
    if create:
        root.mkdir(parents=True, exist_ok=True)
    return root


def replay_cache_namespace_root(namespace: str, *, create: bool = True) -> Path:
    try:
        subdir = _NAMESPACE_DIRS[namespace]
    except KeyError as exc:
        raise ValueError(f"unknown replay cache namespace: {namespace}") from exc
    root = replay_cache_root(create=create) / subdir
    if create:
        root.mkdir(parents=True, exist_ok=True)
    return root


def replay_cache_namespace_roots(
    namespace: str,
    *,
    include_legacy: bool = True,
    create_primary: bool = True,
) -> tuple[Path, ...]:
    primary = replay_cache_namespace_root(namespace, create=create_primary)
    roots = [primary]
    if include_legacy:
        legacy = _data_dir() / _LEGACY_DIRS[namespace]
        if legacy != primary:
            roots.append(legacy)
    return tuple(roots)


def _iter_files(roots: Iterable[Path]) -> Iterable[Path]:
    seen: set[str] = set()
    for root in roots:
        try:
            root_key = str(root.resolve()).casefold()
        except OSError:
            root_key = str(root.absolute()).casefold()
        if root_key in seen or not root.is_dir():
            continue
        seen.add(root_key)
        try:
            yield from (path for path in root.iterdir() if path.is_file())
        except OSError:
            continue


def _directory_stats(roots: Iterable[Path]) -> dict[str, int]:
    files = 0
    bytes_used = 0
    for path in _iter_files(roots):
        try:
            bytes_used += int(path.stat().st_size)
            files += 1
        except OSError:
            continue
    return {"files": files, "bytes": bytes_used}


def replay_cache_summary() -> dict[str, Any]:
    namespaces: dict[str, dict[str, int]] = {}
    total_files = 0
    total_bytes = 0
    legacy_files = 0
    legacy_bytes = 0
    for namespace in _NAMESPACE_DIRS:
        roots = replay_cache_namespace_roots(
            namespace,
            include_legacy=True,
            create_primary=False,
        )
        stats = _directory_stats(roots)
        legacy_stats = _directory_stats(roots[1:])
        namespaces[namespace] = stats
        total_files += stats["files"]
        total_bytes += stats["bytes"]
        legacy_files += legacy_stats["files"]
        legacy_bytes += legacy_stats["bytes"]
    return {
        "path": str(replay_cache_root(create=False).resolve()),
        "persistent": True,
        "files": total_files,
        "bytes": total_bytes,
        "legacy_files": legacy_files,
        "legacy_bytes": legacy_bytes,
        "namespaces": namespaces,
    }


def _unlink_files(roots: Iterable[Path]) -> dict[str, int]:
    removed_files = 0
    removed_bytes = 0
    for path in list(_iter_files(roots)):
        try:
            size = int(path.stat().st_size)
            path.unlink(missing_ok=True)
            removed_files += 1
            removed_bytes += size
        except OSError as exc:
            logger.warning("Could not remove replay cache file %s: %s", path, exc)
    return {"files": removed_files, "bytes": removed_bytes}


def clear_replay_cache() -> dict[str, Any]:
    roots: list[Path] = []
    for namespace in _NAMESPACE_DIRS:
        roots.extend(
            replay_cache_namespace_roots(
                namespace,
                include_legacy=True,
                create_primary=False,
            )
        )
    removed = _unlink_files(roots)
    return {"removed_files": removed["files"], "removed_bytes": removed["bytes"]}


def remove_demo_replay_cache(demo_path: str) -> dict[str, Any]:
    """Remove every replay cache format that can be attributed to one Demo."""
    from .replay_effects_cache import remove_tracks_for_demo
    from .replay_frames_cache import remove_frames_for_demo
    from .replay_match_cache import remove_match_cache_for_demo

    removed_files = 0
    removed_bytes = 0
    errors: list[str] = []
    for remover in (
        remove_match_cache_for_demo,
        remove_frames_for_demo,
        remove_tracks_for_demo,
    ):
        try:
            result = remover(demo_path)
        except Exception as exc:  # noqa: BLE001 - cache cleanup must not undo a Demo deletion
            logger.warning("Could not remove %s replay cache for %s: %s", remover.__name__, demo_path, exc)
            errors.append(f"{remover.__name__}: {type(exc).__name__}")
            continue
        removed_files += int(result.get("removed_files") or 0)
        removed_bytes += int(result.get("removed_bytes") or 0)
    return {
        "removed_files": removed_files,
        "removed_bytes": removed_bytes,
        "errors": errors,
    }


def _normalized_demo_path(path: str) -> str:
    return os.path.normcase(os.path.abspath(os.path.expanduser(str(path))))


def remove_demo_row_caches(demo: dict[str, Any] | None) -> dict[str, Any]:
    """Remove parse/replay caches for a library row's original and working paths.

    Analysis uses ``cached_path`` when present, so cleanup must cover both
    ``path`` and ``cached_path`` before the working copy is unlinked.
    """
    removed_files = 0
    removed_bytes = 0
    errors: list[str] = []
    seen: set[str] = set()
    row = demo if isinstance(demo, dict) else {}
    for key in ("path", "cached_path"):
        raw = str(row.get(key) or "").strip()
        if not raw:
            continue
        try:
            normalized = _normalized_demo_path(raw)
        except OSError:
            normalized = raw.casefold()
        if normalized in seen:
            continue
        seen.add(normalized)
        result = remove_demo_replay_cache(raw)
        removed_files += int(result.get("removed_files") or 0)
        removed_bytes += int(result.get("removed_bytes") or 0)
        errors.extend(list(result.get("errors") or []))
    return {
        "removed_files": removed_files,
        "removed_bytes": removed_bytes,
        "errors": errors,
    }
