"""Demo working-copy cache: copy originals into a configurable cache root.

Historical rows keep ``demo_files.path`` as the original absolute path (join key).
Working I/O uses ``cached_path`` once materialized.
"""

from __future__ import annotations

import asyncio
import hashlib
import logging
import os
import shutil
import tempfile
from dataclasses import dataclass
from pathlib import Path
from typing import Any

from .env_utils import get_data_dir, load_config, save_config

logger = logging.getLogger(__name__)

_DEFAULT_CACHE_DIRNAME = "demo-cache"


@dataclass(frozen=True)
class MaterializeResult:
    cached_path: Path
    created: bool
    reused_existing: bool


def default_demo_cache_root() -> Path:
    return (get_data_dir() / _DEFAULT_CACHE_DIRNAME).resolve()


def resolve_demo_cache_root(cfg: Any | None = None) -> Path:
    """Return the configured cache root (create if missing). Empty config → data/demo-cache."""
    config = cfg if cfg is not None else load_config()
    raw = str(getattr(config, "demo_cache_directory", "") or "").strip()
    root = Path(raw).expanduser() if raw else default_demo_cache_root()
    root.mkdir(parents=True, exist_ok=True)
    return root.resolve()


def _norm(path: Path | str) -> str:
    return os.path.normcase(str(Path(path).resolve()))


def is_under_directory(path: Path, root: Path) -> bool:
    try:
        path.resolve().relative_to(root.resolve())
        return True
    except (OSError, ValueError):
        return False


def cache_entry_name(*, content_md5: str | None, source: Path, demo_id: int | None = None) -> str:
    digest = str(content_md5 or "").strip().lower()
    if len(digest) >= 8 and all(ch in "0123456789abcdef" for ch in digest):
        return f"{digest}.dem"
    seed = f"{demo_id or 0}|{_norm(source)}|{source.name}".encode("utf-8", errors="ignore")
    return f"demo_{hashlib.sha1(seed).hexdigest()[:20]}.dem"


def file_md5(path: Path, *, chunk_size: int = 1024 * 1024) -> str:
    digest = hashlib.md5()
    with path.open("rb") as handle:
        while True:
            chunk = handle.read(chunk_size)
            if not chunk:
                break
            digest.update(chunk)
    return digest.hexdigest()


def copy_demo_into_cache(
    source: Path,
    *,
    content_md5: str | None = None,
    demo_id: int | None = None,
    cache_root: Path | None = None,
) -> MaterializeResult:
    """Copy ``source`` into the cache root. Idempotent when size matches an existing entry."""
    src = source.resolve()
    if not src.is_file():
        raise FileNotFoundError(f"Demo source missing: {src}")
    root = (cache_root or resolve_demo_cache_root()).resolve()
    root.mkdir(parents=True, exist_ok=True)
    dest = root / cache_entry_name(content_md5=content_md5, source=src, demo_id=demo_id)
    if dest.is_file() and dest.stat().st_size == src.stat().st_size:
        if _norm(dest) == _norm(src):
            return MaterializeResult(cached_path=dest, created=False, reused_existing=True)
        return MaterializeResult(cached_path=dest, created=False, reused_existing=True)

    dest.parent.mkdir(parents=True, exist_ok=True)
    fd, tmp_name = tempfile.mkstemp(prefix=".demo_cache_", suffix=".dem", dir=str(root))
    os.close(fd)
    tmp_path = Path(tmp_name)
    try:
        shutil.copy2(src, tmp_path)
        os.replace(tmp_path, dest)
    except Exception:
        try:
            tmp_path.unlink(missing_ok=True)
        except OSError:
            pass
        raise
    logger.info("Demo cache materialized: %s -> %s", src, dest)
    return MaterializeResult(cached_path=dest, created=True, reused_existing=False)


async def ensure_row_cached(demo_db: Any, row: dict[str, Any]) -> Path:
    """Ensure a library row has a usable cached copy; return its path.

    Historical rows: ``path`` is the original file. Missing/invalid ``cached_path``
    triggers a copy from ``path`` into the cache root and persists ``cached_path``.
    """
    cached_raw = str(row.get("cached_path") or "").strip()
    if cached_raw:
        cached = Path(cached_raw)
        if cached.is_file():
            return cached.resolve()

    original = Path(str(row.get("path") or ""))
    if not original.is_file():
        raise FileNotFoundError(f"Demo original missing: {original}")

    md5 = str(row.get("content_md5") or "").strip() or None
    if not md5:
        try:
            md5 = await asyncio.to_thread(file_md5, original)
        except Exception:  # noqa: BLE001 - md5 is optional for naming
            md5 = None

    result = await asyncio.to_thread(
        copy_demo_into_cache,
        original,
        content_md5=md5,
        demo_id=int(row["id"]) if row.get("id") is not None else None,
    )
    await demo_db.update_cached_path(
        str(original),
        str(result.cached_path),
        content_md5=md5 if md5 and not str(row.get("content_md5") or "").strip() else None,
    )
    row["cached_path"] = str(result.cached_path)
    if md5 and not str(row.get("content_md5") or "").strip():
        row["content_md5"] = md5
    return result.cached_path.resolve()


def migrate_cache_files(old_root: Path, new_root: Path) -> dict[str, int]:
    """Move files from old_root into new_root (same relative names when possible)."""
    old = old_root.resolve()
    new = new_root.resolve()
    if _norm(old) == _norm(new):
        return {"moved": 0, "skipped": 0, "failed": 0}
    new.mkdir(parents=True, exist_ok=True)
    moved = skipped = failed = 0
    if not old.is_dir():
        return {"moved": 0, "skipped": 0, "failed": 0}
    for src in old.rglob("*"):
        if not src.is_file():
            continue
        rel = src.relative_to(old)
        dest = new / rel
        try:
            dest.parent.mkdir(parents=True, exist_ok=True)
            if dest.exists():
                skipped += 1
                continue
            shutil.move(str(src), str(dest))
            moved += 1
        except OSError:
            logger.exception("Failed to migrate cache file %s -> %s", src, dest)
            failed += 1
    return {"moved": moved, "skipped": skipped, "failed": failed}


def rewrite_path_under_root(path: str, old_root: Path, new_root: Path) -> str | None:
    """If path is under old_root, return the equivalent path under new_root."""
    raw = (path or "").strip()
    if not raw:
        return None
    try:
        current = Path(raw).resolve()
        rel = current.relative_to(old_root.resolve())
    except (OSError, ValueError):
        return None
    return str((new_root.resolve() / rel).resolve())


async def migrate_demo_cache_root(demo_db: Any, destination: str) -> dict[str, Any]:
    """Move cache files, update DB cached_path rows, then persist config."""
    dest_raw = (destination or "").strip()
    if not dest_raw:
        raise ValueError("Demo 缓存路径不能为空")
    new_root = Path(dest_raw).expanduser().resolve()
    new_root.mkdir(parents=True, exist_ok=True)

    cfg = load_config()
    old_root = resolve_demo_cache_root(cfg)
    if _norm(old_root) == _norm(new_root):
        cfg.demo_cache_directory = str(new_root)
        save_config(cfg)
        return {
            "path": str(new_root),
            "moved": 0,
            "skipped": 0,
            "failed": 0,
            "db_updated": 0,
            "unchanged": True,
        }

    stats = await asyncio.to_thread(migrate_cache_files, old_root, new_root)
    if stats["failed"]:
        raise RuntimeError(
            f"缓存迁移失败 {stats['failed']} 个文件；配置未更改。已成功移动 {stats['moved']} 个。"
        )

    db_updated = await demo_db.remap_cached_paths(str(old_root), str(new_root))
    cfg.demo_cache_directory = str(new_root)
    save_config(cfg)
    return {
        "path": str(new_root),
        "previous_path": str(old_root),
        "moved": stats["moved"],
        "skipped": stats["skipped"],
        "failed": stats["failed"],
        "db_updated": db_updated,
        "unchanged": False,
    }


async def clear_demo_cache(demo_db: Any) -> dict[str, Any]:
    """Delete cached demos and invalidate parse state; keep library rows + original paths."""
    cfg = load_config()
    root = resolve_demo_cache_root(cfg)
    removed_files = 0
    removed_bytes = 0
    if root.is_dir():
        for path in root.rglob("*"):
            if not path.is_file():
                continue
            try:
                size = path.stat().st_size
                path.unlink()
                removed_files += 1
                removed_bytes += size
            except OSError:
                logger.exception("Failed to delete cache file %s", path)

    invalidated = await demo_db.invalidate_all_demo_caches()
    return {
        "path": str(root),
        "removed_files": removed_files,
        "removed_bytes": removed_bytes,
        "demos_invalidated": invalidated,
    }


def cache_status_payload(demo_db_stats: dict[str, Any] | None = None) -> dict[str, Any]:
    cfg = load_config()
    root = resolve_demo_cache_root(cfg)
    file_count = 0
    total_bytes = 0
    if root.is_dir():
        for path in root.rglob("*.dem"):
            if path.is_file():
                file_count += 1
                try:
                    total_bytes += path.stat().st_size
                except OSError:
                    pass
    return {
        "path": str(root),
        "default_path": str(default_demo_cache_root()),
        "custom": bool(str(getattr(cfg, "demo_cache_directory", "") or "").strip()),
        "file_count": file_count,
        "total_bytes": total_bytes,
        **(demo_db_stats or {}),
    }
