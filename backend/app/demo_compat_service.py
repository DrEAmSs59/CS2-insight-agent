"""One-time, persistent compatibility preflight for local CS2 demos."""

from __future__ import annotations

import hashlib
import json
import logging
import os
import shutil
import tempfile
import threading
from dataclasses import asdict, dataclass
from pathlib import Path
from typing import Any

from .demo_playback_compat import (
    PATCH_REVISION,
    PlaybackDemoReport,
    repair_demo_in_place,
)
from .env_utils import get_data_dir

logger = logging.getLogger(__name__)

_CACHE_SCHEMA = 1
_CACHE_NAME = "demo-playback-compat-cache.json"
_EDGE_BYTES = 64 * 1024
_MAX_RECORDS = 2048
_BASELINE_SCHEMA = 1
_cache_lock = threading.RLock()
_path_locks: dict[str, threading.Lock] = {}
_baseline_locks: dict[str, threading.Lock] = {}


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


def _record_result(source: Path, report: PlaybackDemoReport) -> None:
    """Persist a verified compatibility result for the file at its current path."""

    fingerprint = _fingerprint(source)
    with _cache_lock:
        cache_path = _cache_path()
        cache = _load_cache(cache_path)
        records = cache.setdefault("records", {})
        records[_path_key(source)] = {
            "patch_revision": PATCH_REVISION,
            "fingerprint": fingerprint,
            "report": asdict(report),
        }
        while len(records) > _MAX_RECORDS:
            records.pop(next(iter(records)))
        try:
            _save_cache(cache_path, cache)
        except OSError:
            logger.exception("Could not persist demo compatibility cache: %s", cache_path)


def _baseline_identity(
    source: Path,
    fingerprint: dict[str, Any],
    *,
    allow_truncated_packet_tail: bool,
) -> dict[str, Any]:
    return {
        "schema": _BASELINE_SCHEMA,
        "patch_revision": PATCH_REVISION,
        "allow_truncated_packet_tail": allow_truncated_packet_tail,
        "source": _path_key(source),
        "source_fingerprint": fingerprint,
    }


def _baseline_paths(
    source: Path,
    cache_dir: Path,
    fingerprint: dict[str, Any],
    *,
    allow_truncated_packet_tail: bool,
) -> tuple[Path, Path, dict[str, Any]]:
    identity = _baseline_identity(
        source,
        fingerprint,
        allow_truncated_packet_tail=allow_truncated_packet_tail,
    )
    encoded = json.dumps(identity, sort_keys=True, separators=(",", ":")).encode("utf-8")
    digest = hashlib.sha256(encoded).hexdigest()
    baseline = cache_dir / f".skin-compat-v{PATCH_REVISION}-{digest}.dem"
    return baseline, baseline.with_suffix(".json"), identity


def _load_baseline_manifest(path: Path) -> dict[str, Any] | None:
    try:
        raw = json.loads(path.read_text(encoding="utf-8"))
    except (FileNotFoundError, OSError, json.JSONDecodeError):
        return None
    return raw if isinstance(raw, dict) else None


def _baseline_is_bound_to_source(
    baseline: Path,
    manifest_path: Path,
    identity: dict[str, Any],
) -> bool:
    if not baseline.is_file():
        return False
    manifest = _load_baseline_manifest(manifest_path)
    if manifest is None or manifest.get("identity") != identity:
        return False
    expected = manifest.get("baseline_fingerprint")
    if not isinstance(expected, dict):
        return False
    try:
        return _fingerprint(baseline) == expected
    except OSError:
        return False


def ensure_compatible_baseline(
    source_path: os.PathLike[str] | str,
    cache_dir: os.PathLike[str] | str,
    *,
    allow_truncated_packet_tail: bool = True,
) -> Path:
    """Return an immutable, source-bound compatibility baseline in ``cache_dir``.

    The library original is never modified. A baseline is rebuilt whenever the
    source fingerprint or compatibility patch revision changes. Publication is
    atomic, and a manifest binds the cached bytes back to the exact source
    fingerprint so an unrelated working-cache file can never be reused.
    """

    source = Path(source_path).resolve(strict=True)
    if not source.is_file() or source.suffix.lower() != ".dem":
        raise FileNotFoundError(f"Demo file not found: {source}")
    root = Path(cache_dir).resolve()
    root.mkdir(parents=True, exist_ok=True)
    source_fingerprint = _fingerprint(source)
    baseline, manifest_path, identity = _baseline_paths(
        source,
        root,
        source_fingerprint,
        allow_truncated_packet_tail=allow_truncated_packet_tail,
    )
    lock_key = _path_key(baseline)
    with _cache_lock:
        baseline_lock = _baseline_locks.setdefault(lock_key, threading.Lock())

    with baseline_lock:
        if _baseline_is_bound_to_source(baseline, manifest_path, identity):
            try:
                ensure_demo_compatible(
                    baseline,
                    allow_truncated_packet_tail=allow_truncated_packet_tail,
                )
                if _fingerprint(source) != source_fingerprint:
                    raise RuntimeError("demo source changed while compatibility baseline was checked")
                return baseline.resolve()
            except Exception:  # noqa: BLE001 - corrupt cache is rebuilt from the original
                logger.warning(
                    "Discarding invalid demo compatibility baseline: %s",
                    baseline,
                    exc_info=True,
                )

        baseline.unlink(missing_ok=True)
        manifest_path.unlink(missing_ok=True)
        fd, temp_name = tempfile.mkstemp(
            prefix=".skin-compat-build-",
            suffix=".dem",
            dir=str(root),
        )
        os.close(fd)
        temp_path = Path(temp_name)
        published = False
        try:
            shutil.copy2(source, temp_path)
            report = repair_demo_in_place(
                temp_path,
                allow_truncated_packet_tail=allow_truncated_packet_tail,
            )
            if _fingerprint(source) != source_fingerprint:
                raise RuntimeError("demo source changed while compatibility baseline was built")
            os.replace(temp_path, baseline)
            published = True
            manifest = {
                "schema": _BASELINE_SCHEMA,
                "identity": identity,
                "baseline_fingerprint": _fingerprint(baseline),
                "report": asdict(report),
            }
            _save_cache(manifest_path, manifest)
            _record_result(baseline, report)
            logger.info("Demo compatibility baseline materialized: %s -> %s", source, baseline)
            return baseline.resolve()
        except Exception:
            if published:
                baseline.unlink(missing_ok=True)
                manifest_path.unlink(missing_ok=True)
            raise
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


def ensure_demo_compatible(
    source_path: os.PathLike[str] | str,
    *,
    allow_truncated_packet_tail: bool = True,
) -> DemoCompatibilityEnsureResult:
    """Classify/repair a demo once, then cache its content fingerprint.

    By default, the narrowly validated CS2-unfinalized demo shape is finalized
    atomically before downstream parsing. Generic truncated packets remain hard
    failures. Strict callers can explicitly disable terminal recovery.
    """

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

        repair_options = (
            {"allow_truncated_packet_tail": True}
            if allow_truncated_packet_tail
            else {}
        )
        report = repair_demo_in_place(source, **repair_options)
        if report.recovered_unfinalized_demo:
            logger.warning(
                "Recovered unfinalized demo terminal metadata after compatibility patches: "
                "path=%s discarded_tail_bytes=%d removed_type138=%d "
                "removed_win_panel=%d",
                source,
                report.discarded_truncated_packet_bytes,
                report.removed_messages,
                report.removed_win_panel_events,
            )
        _record_result(source, report)
        return DemoCompatibilityEnsureResult(report=report, cached=False)
