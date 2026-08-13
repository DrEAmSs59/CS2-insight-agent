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
import threading
from pathlib import Path
from typing import Any, Iterable

from .replay_cache_owners import (
    clear_owner_index,
    discard_owner_record,
    discard_owner_records_for_paths,
    load_owner_records,
    mark_owner_index_ready,
    normalized_demo_path,
    owner_index_ready,
)

logger = logging.getLogger(__name__)
_owner_cleanup_lock = threading.RLock()

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
    clear_owner_index()
    return {"removed_files": removed["files"], "removed_bytes": removed["bytes"]}


def _is_managed_cache_file(path: Path) -> bool:
    try:
        resolved = path.resolve()
    except OSError:
        return False
    for namespace in _NAMESPACE_DIRS:
        for root in replay_cache_namespace_roots(
            namespace,
            include_legacy=True,
            create_primary=False,
        ):
            try:
                resolved.relative_to(root.resolve())
                return True
            except (OSError, ValueError):
                continue
    return False


def _remove_indexed_demo_replay_caches(demo_paths: list[str]) -> dict[str, Any]:
    records, errors = load_owner_records(demo_paths)
    removed_files = 0
    removed_bytes = 0
    seen: set[str] = set()
    for record_path, payload in records:
        record_ok = True
        for raw_path in payload.get("files") or []:
            path = Path(str(raw_path))
            path_key = str(path.absolute()).casefold()
            if path_key in seen:
                continue
            seen.add(path_key)
            if not _is_managed_cache_file(path):
                errors.append(f"{record_path.name}: unmanaged cache path")
                record_ok = False
                continue
            if not path.is_file():
                continue
            try:
                size = int(path.stat().st_size)
                path.unlink(missing_ok=True)
                removed_files += 1
                removed_bytes += size
            except OSError as exc:
                logger.warning("Could not remove indexed replay cache file %s: %s", path, exc)
                errors.append(f"{record_path.name}: {type(exc).__name__}")
                record_ok = False
        if record_ok:
            try:
                discard_owner_record(record_path)
            except OSError as exc:
                errors.append(f"{record_path.name}: {type(exc).__name__}")
    return {
        "removed_files": removed_files,
        "removed_bytes": removed_bytes,
        "errors": errors,
    }


def _bootstrap_and_remove_demo_replay_caches(demo_paths: list[str]) -> dict[str, Any]:
    """Scan legacy payloads once, index survivors, and remove all requested paths."""
    from .replay_effects_cache import remove_tracks_for_demos
    from .replay_frames_cache import remove_frames_for_demos
    from .replay_match_cache import remove_match_caches_for_demos

    removed_files = 0
    removed_bytes = 0
    errors: list[str] = []
    for remover in (
        remove_match_caches_for_demos,
        remove_frames_for_demos,
        remove_tracks_for_demos,
    ):
        try:
            result = remover(demo_paths, register_survivors=True)
        except Exception as exc:  # noqa: BLE001 - cache cleanup must not undo a Demo deletion
            logger.warning("Could not reconcile %s replay cache: %s", remover.__name__, exc)
            errors.append(f"{remover.__name__}: {type(exc).__name__}")
            continue
        removed_files += int(result.get("removed_files") or 0)
        removed_bytes += int(result.get("removed_bytes") or 0)
    discard_owner_records_for_paths(demo_paths)
    if not errors:
        mark_owner_index_ready()
    return {
        "removed_files": removed_files,
        "removed_bytes": removed_bytes,
        "errors": errors,
    }


def remove_demo_replay_caches(demo_paths: Iterable[str]) -> dict[str, Any]:
    """Remove replay caches for several source/working paths in one operation."""
    unique: dict[str, str] = {}
    for raw in demo_paths:
        value = str(raw or "").strip()
        if value:
            unique.setdefault(normalized_demo_path(value), value)
    paths = list(unique.values())
    if not paths:
        return {"removed_files": 0, "removed_bytes": 0, "errors": []}
    with _owner_cleanup_lock:
        if owner_index_ready():
            return _remove_indexed_demo_replay_caches(paths)
        return _bootstrap_and_remove_demo_replay_caches(paths)


def ensure_replay_cache_owner_index() -> dict[str, Any]:
    """Warm the legacy cache index once without removing any replay assets."""
    with _owner_cleanup_lock:
        if owner_index_ready():
            return {"ready": True, "rebuilt": False, "errors": []}
        result = _bootstrap_and_remove_demo_replay_caches([])
        return {
            "ready": owner_index_ready(),
            "rebuilt": True,
            "errors": list(result.get("errors") or []),
        }


def remove_demo_replay_cache(demo_path: str) -> dict[str, Any]:
    """Remove every replay cache format that can be attributed to one Demo."""
    return remove_demo_replay_caches([demo_path])


def remove_demo_row_caches(demo: dict[str, Any] | None) -> dict[str, Any]:
    """Remove parse/replay caches for a library row's original and working paths.

    Analysis uses ``cached_path`` when present, so cleanup must cover both
    ``path`` and ``cached_path`` before the working copy is unlinked.
    """
    row = demo if isinstance(demo, dict) else {}
    return remove_demo_replay_caches(
        str(row.get(key) or "").strip()
        for key in ("path", "cached_path")
    )
