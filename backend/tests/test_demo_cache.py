"""Tests for Demo working-copy cache."""

from __future__ import annotations

import asyncio
from pathlib import Path

import pytest

from app.demo_cache import (
    copy_demo_into_cache,
    copy_original_to_temp_input,
    default_demo_cache_root,
    ensure_row_cached,
    migrate_cache_files,
    rewrite_path_under_root,
)
from app.demo_db import DemoDB
from app.env_utils import AppConfig, save_config


@pytest.fixture()
def demo_file(tmp_path: Path) -> Path:
    source = tmp_path / "originals" / "match.dem"
    source.parent.mkdir(parents=True)
    source.write_bytes(b"demo-bytes-1234567890")
    return source


def test_copy_demo_into_cache_is_idempotent(tmp_path: Path, demo_file: Path, monkeypatch):
    cache_root = tmp_path / "cache"
    monkeypatch.setattr("app.demo_cache.get_data_dir", lambda: tmp_path)
    first = copy_demo_into_cache(demo_file, content_md5="aabbccddeeff0011", cache_root=cache_root)
    second = copy_demo_into_cache(demo_file, content_md5="aabbccddeeff0011", cache_root=cache_root)
    assert first.cached_path == second.cached_path
    assert first.cached_path.is_file()
    assert first.cached_path.read_bytes() == demo_file.read_bytes()
    assert first.created is True
    assert second.reused_existing is True


def test_rewrite_and_migrate_cache_files(tmp_path: Path, demo_file: Path):
    old_root = tmp_path / "old-cache"
    new_root = tmp_path / "new-cache"
    materialize = copy_demo_into_cache(demo_file, content_md5="1122334455667788", cache_root=old_root)
    stats = migrate_cache_files(old_root, new_root)
    assert stats["moved"] == 1
    assert stats["failed"] == 0
    rewritten = rewrite_path_under_root(str(materialize.cached_path), old_root, new_root)
    assert rewritten is not None
    assert Path(rewritten).is_file()


def test_copy_original_to_temp_input_is_independent_of_cache(tmp_path: Path, demo_file: Path):
    cache_dir = tmp_path / "cache"
    cache_dir.mkdir()
    cached = cache_dir / "working.dem"
    cached.write_bytes(b"POLLUTED-CACHE")

    temp_in = copy_original_to_temp_input(demo_file, cache_dir)
    try:
        assert temp_in.is_file()
        assert temp_in.resolve() != cached.resolve()
        assert temp_in.parent == cache_dir.resolve()
        assert temp_in.read_bytes() == demo_file.read_bytes()
        assert cached.read_bytes() == b"POLLUTED-CACHE"
    finally:
        temp_in.unlink(missing_ok=True)


def test_ensure_row_cached_persists_path(tmp_path: Path, demo_file: Path, monkeypatch):
    monkeypatch.setattr("app.demo_cache.get_data_dir", lambda: tmp_path)
    monkeypatch.setattr("app.demo_cache.resolve_demo_cache_root", lambda cfg=None: tmp_path / "demo-cache")
    db_path = tmp_path / "test.db"
    db = DemoDB(db_path)

    async def _run():
        await db.init_db()
        demo_id, inserted = await db.add_demo(str(demo_file), file_size=demo_file.stat().st_size, status="loaded")
        assert inserted
        row = await db.get_demo_by_id(demo_id)
        assert row is not None
        assert not row.get("cached_path")
        cached = await ensure_row_cached(db, row)
        assert cached.is_file()
        refreshed = await db.get_demo_by_id(demo_id)
        assert refreshed is not None
        assert Path(refreshed["cached_path"]).resolve() == cached.resolve()
        # Historical path (original) stays as join key
        assert Path(refreshed["path"]).resolve() == demo_file.resolve()

    asyncio.run(_run())


def test_default_cache_root_under_data_dir(tmp_path: Path, monkeypatch):
    monkeypatch.setattr("app.demo_cache.get_data_dir", lambda: tmp_path)
    assert default_demo_cache_root() == (tmp_path / "demo-cache").resolve()
