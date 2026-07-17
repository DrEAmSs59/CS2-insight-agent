"""One-time, persistent compatibility preflight for local CS2 demos."""

from __future__ import annotations

import hashlib
import json
import logging
import os
import tempfile
import threading
from dataclasses import asdict, dataclass
from pathlib import Path
from typing import Any

from .demo_playback_compat import PATCH_REVISION, PlaybackDemoReport, repair_demo_in_place
from .env_utils import get_data_dir

logger = logging.getLogger(__name__)

_CACHE_SCHEMA = 1
_CACHE_NAME = "demo-playback-compat-cache.json"
_EDGE_BYTES = 64 * 1024
_MAX_RECORDS = 2048
_cache_lock = threading.RLock()
_path_locks: dict[str, threading.Lock] = {}


@dataclass(frozen=True)
class DemoCompatibilityEnsureResult:
    report: PlaybackDemoReport
    cached: bool


def _cache_path() -> Path:
    return get_data_dir() / _CACHE_NAME


def _path_key(path: Path) -> str:
    return os.path.normcase(str(path.resolve()))


def _fingerprint(path: Path) -> dict[str, Any]:
    stat = path.stat()
    digest = hashlib.sha256()
    with path.open("rb") as reader:
        digest.update(reader.read(_EDGE_BYTES))
        if stat.st_size > _EDGE_BYTES:
            reader.seek(max(0, stat.st_size - _EDGE_BYTES))
            digest.update(reader.read(_EDGE_BYTES))
    return {
        "size": int(stat.st_size),
        "mtime_ns": int(stat.st_mtime_ns),
        "device": int(stat.st_dev),
        "inode": int(stat.st_ino),
        "edge_sha256": digest.hexdigest(),
    }


def _load_cache(path: Path) -> dict[str, Any]:
    try:
        raw = json.loads(path.read_text(encoding="utf-8"))
    except (FileNotFoundError, OSError, json.JSONDecodeError):
        return {"schema": _CACHE_SCHEMA, "records": {}}
    if not isinstance(raw, dict) or raw.get("schema") != _CACHE_SCHEMA:
        return {"schema": _CACHE_SCHEMA, "records": {}}
    if not isinstance(raw.get("records"), dict):
        raw["records"] = {}
    return raw


def _save_cache(path: Path, cache: dict[str, Any]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    temp_file = tempfile.NamedTemporaryFile(
        mode="w",
        encoding="utf-8",
        prefix=f".{path.name}.",
        suffix=".tmp",
        dir=path.parent,
        delete=False,
    )
    temp_path = Path(temp_file.name)
    try:
        with temp_file as writer:
            json.dump(cache, writer, ensure_ascii=False, separators=(",", ":"))
            writer.flush()
            os.fsync(writer.fileno())
        os.replace(temp_path, path)
    finally:
        temp_path.unlink(missing_ok=True)


def _cached_result(
    cache: dict[str, Any],
    key: str,
    fingerprint: dict[str, Any],
) -> DemoCompatibilityEnsureResult | None:
    record = cache.get("records", {}).get(key)
    if not isinstance(record, dict):
        return None
    if record.get("patch_revision") != PATCH_REVISION:
        return None
    if record.get("fingerprint") != fingerprint:
        return None
    try:
        report = PlaybackDemoReport(**record["report"])
    except (KeyError, TypeError, ValueError):
        return None
    return DemoCompatibilityEnsureResult(report=report, cached=True)


def ensure_demo_compatible(source_path: os.PathLike[str] | str) -> DemoCompatibilityEnsureResult:
    """Repair a demo once, then use a persistent O(1)-I/O fingerprint cache."""

    source = Path(source_path).resolve(strict=True)
    if not source.is_file() or source.suffix.lower() != ".dem":
        raise FileNotFoundError(f"Demo file not found: {source}")
    key = _path_key(source)
    fingerprint = _fingerprint(source)
    cache_path = _cache_path()

    with _cache_lock:
        cache = _load_cache(cache_path)
        hit = _cached_result(cache, key, fingerprint)
        if hit is not None:
            return hit
        path_lock = _path_locks.setdefault(key, threading.Lock())

    with path_lock:
        fingerprint = _fingerprint(source)
        with _cache_lock:
            cache = _load_cache(cache_path)
            hit = _cached_result(cache, key, fingerprint)
            if hit is not None:
                return hit

        report = repair_demo_in_place(source)
        repaired_fingerprint = _fingerprint(source)
        with _cache_lock:
            cache = _load_cache(cache_path)
            records = cache.setdefault("records", {})
            records[key] = {
                "patch_revision": PATCH_REVISION,
                "fingerprint": repaired_fingerprint,
                "report": asdict(report),
            }
            while len(records) > _MAX_RECORDS:
                records.pop(next(iter(records)))
            try:
                _save_cache(cache_path, cache)
            except OSError:
                logger.exception("Could not persist demo compatibility cache: %s", cache_path)
        return DemoCompatibilityEnsureResult(report=report, cached=False)
