"""Lightweight ownership index for per-Demo replay cache reclamation."""

from __future__ import annotations

import hashlib
import json
import os
import shutil
import tempfile
from pathlib import Path
from typing import Any, Iterable

_SCHEMA = 1
_INDEX_DIRNAME = ".owners-v1"
_READY_FILENAME = ".ready"
_NAMESPACES = frozenset({"matches", "frames", "effects"})


def _data_dir() -> Path:
    try:
        from app.env_utils import get_data_dir

        return get_data_dir()
    except Exception:
        return Path.cwd() / "data"


def normalized_demo_path(path: str) -> str:
    return os.path.normcase(os.path.abspath(os.path.expanduser(str(path))))


def owner_index_root(*, create: bool = True) -> Path:
    root = _data_dir() / "cache" / "demo-replay" / _INDEX_DIRNAME
    if create:
        root.mkdir(parents=True, exist_ok=True)
    return root


def _owner_directory(demo_path: str, *, create: bool) -> Path:
    normalized = normalized_demo_path(demo_path)
    digest = hashlib.sha256(
        normalized.encode("utf-8", errors="replace")
    ).hexdigest()[:32]
    directory = owner_index_root(create=create) / digest
    if create:
        directory.mkdir(parents=True, exist_ok=True)
    return directory


def register_replay_cache_entry(
    namespace: str,
    demo_path: str,
    cache_key: str,
    files: Iterable[Path],
) -> None:
    """Atomically register files owned by one Demo cache entry.

    Each entry has its own record, so independent parser workers never rewrite
    a shared central manifest.
    """
    if namespace not in _NAMESPACES:
        raise ValueError(f"unknown replay cache namespace: {namespace}")
    normalized = normalized_demo_path(demo_path)
    paths = list(dict.fromkeys(str(Path(path).resolve()) for path in files))
    if not paths:
        return
    directory = _owner_directory(normalized, create=True)
    record_identity = "\0".join((namespace, str(cache_key), *paths))
    record_key = hashlib.sha256(
        record_identity.encode(
            "utf-8",
            errors="replace",
        )
    ).hexdigest()[:32]
    destination = directory / f"{record_key}.json"
    payload = {
        "schema": _SCHEMA,
        "namespace": namespace,
        "demo_path": normalized,
        "cache_key": str(cache_key),
        "files": paths,
    }
    temp_file = tempfile.NamedTemporaryFile(
        mode="w",
        encoding="utf-8",
        prefix=".tmp-",
        suffix=".json",
        dir=directory,
        delete=False,
    )
    temp_path = Path(temp_file.name)
    try:
        with temp_file as writer:
            json.dump(payload, writer, ensure_ascii=False, separators=(",", ":"))
            writer.flush()
        os.replace(temp_path, destination)
    finally:
        temp_path.unlink(missing_ok=True)


def load_owner_records(
    demo_paths: Iterable[str],
) -> tuple[list[tuple[Path, dict[str, Any]]], list[str]]:
    records: list[tuple[Path, dict[str, Any]]] = []
    errors: list[str] = []
    for raw in dict.fromkeys(normalized_demo_path(path) for path in demo_paths):
        directory = _owner_directory(raw, create=False)
        if not directory.is_dir():
            continue
        for record_path in directory.glob("*.json"):
            try:
                payload = json.loads(record_path.read_text(encoding="utf-8"))
                if (
                    not isinstance(payload, dict)
                    or payload.get("schema") != _SCHEMA
                    or payload.get("namespace") not in _NAMESPACES
                    or normalized_demo_path(str(payload.get("demo_path") or "")) != raw
                    or not isinstance(payload.get("files"), list)
                ):
                    raise ValueError("invalid owner record")
                records.append((record_path, payload))
            except Exception as exc:  # noqa: BLE001 - corrupt indexes must not broaden deletion scope
                errors.append(f"{record_path.name}: {type(exc).__name__}")
    return records, errors


def discard_owner_record(record_path: Path) -> None:
    record_path.unlink(missing_ok=True)
    directory = record_path.parent
    try:
        directory.rmdir()
    except OSError:
        pass


def discard_owner_records_for_paths(demo_paths: Iterable[str]) -> None:
    for raw in dict.fromkeys(normalized_demo_path(path) for path in demo_paths):
        directory = _owner_directory(raw, create=False)
        if directory.is_dir():
            shutil.rmtree(directory, ignore_errors=True)


def owner_index_ready() -> bool:
    return (owner_index_root(create=False) / _READY_FILENAME).is_file()


def mark_owner_index_ready() -> None:
    root = owner_index_root(create=True)
    marker = root / _READY_FILENAME
    temp = root / f".{_READY_FILENAME}.{os.getpid()}.tmp"
    temp.write_text(str(_SCHEMA), encoding="ascii")
    os.replace(temp, marker)


def invalidate_owner_index() -> None:
    try:
        (owner_index_root(create=False) / _READY_FILENAME).unlink(missing_ok=True)
    except OSError:
        pass


def clear_owner_index() -> None:
    root = owner_index_root(create=False)
    if root.is_dir():
        shutil.rmtree(root, ignore_errors=True)
