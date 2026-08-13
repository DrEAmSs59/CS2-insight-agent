from __future__ import annotations

import asyncio
import json
from pathlib import Path

from app import main
from app.features.demo_analysis import replay_effects_cache, replay_frames_cache, replay_match_cache
from app.features.demo_analysis import replay_cache_storage
from app.features.demo_analysis import replay_cache_owners
from app.features.demo_library import api as demo_library_api


def _write_match_entry(root: Path, cache_key: str, demo_path: Path) -> None:
    root.mkdir(parents=True, exist_ok=True)
    (root / f"{cache_key}.parquet").write_bytes(b"PAR1")
    (root / f"{cache_key}.meta.json").write_text(
        json.dumps(
            {
                "version": replay_match_cache.REPLAY_MATCH_CACHE_VERSION,
                "cache_key": cache_key,
                "demo_fingerprint": {
                    "path": str(demo_path.resolve()),
                    "size": demo_path.stat().st_size,
                    "mtime_ns": demo_path.stat().st_mtime_ns,
                },
                "rounds": [],
            }
        ),
        encoding="utf-8",
    )


def _write_round_entry(demo_path: Path) -> str:
    key = replay_frames_cache.frames_cache_key(
        str(demo_path),
        round_number=1,
        start_tick=100,
        end_tick=200,
        fps=32,
    )
    assert key
    replay_frames_cache.save_frames(
        key,
        frames=[{"tick": 100, "players": []}],
        fps=32,
        start_tick=100,
        end_tick=200,
        map_transform=None,
        demo_fingerprint_meta=replay_frames_cache.demo_fingerprint(str(demo_path)),
    )
    return key


def test_replay_assets_are_persistent_managed_and_removed_per_demo(tmp_path, monkeypatch):
    monkeypatch.setenv("CS2_INSIGHT_DATA_DIR", str(tmp_path))
    demo_a = tmp_path / "a.dem"
    demo_b = tmp_path / "b.dem"
    demo_a.write_bytes(b"a")
    demo_b.write_bytes(b"bb")

    match_root = replay_cache_storage.replay_cache_namespace_root("matches")
    _write_match_entry(match_root, "match-a", demo_a)
    _write_match_entry(match_root, "match-b", demo_b)
    _write_round_entry(demo_a)
    _write_round_entry(demo_b)
    replay_effects_cache.save_tracks(demo_path=str(demo_a), tracks=[], capabilities={})
    replay_effects_cache.save_tracks(demo_path=str(demo_b), tracks=[], capabilities={})

    summary = replay_cache_storage.replay_cache_summary()
    assert Path(summary["path"]) == tmp_path / "cache" / "demo-replay"
    assert summary["persistent"] is True
    assert summary["files"] == 10

    # Metadata keeps cleanup attributable even after the source Demo is gone.
    demo_a.unlink()
    removed = replay_cache_storage.remove_demo_replay_cache(str(demo_a))

    assert removed["removed_files"] == 5
    assert removed["removed_bytes"] > 0
    assert removed["errors"] == []
    assert not (match_root / "match-a.parquet").exists()
    assert (match_root / "match-b.parquet").is_file()
    assert replay_cache_storage.replay_cache_summary()["files"] == 5


def test_legacy_match_cache_remains_readable_and_global_clear_reclaims_it(tmp_path, monkeypatch):
    monkeypatch.setenv("CS2_INSIGHT_DATA_DIR", str(tmp_path))
    demo_path = tmp_path / "legacy.dem"
    demo_path.write_bytes(b"demo")
    cache_key = replay_match_cache.replay_match_cache_key(str(demo_path))
    assert cache_key
    legacy_root = tmp_path / "replay-match"
    _write_match_entry(legacy_root, cache_key, demo_path)

    entry = replay_match_cache._load_meta_entry(cache_key)

    assert entry is not None
    assert entry[1] == legacy_root / f"{cache_key}.parquet"
    before = replay_cache_storage.replay_cache_summary()
    assert before["legacy_files"] == 2
    removed = replay_cache_storage.clear_replay_cache()
    assert removed["removed_files"] == 2
    assert replay_cache_storage.replay_cache_summary()["files"] == 0


def test_library_delete_reclaims_replay_cache(monkeypatch, tmp_path):
    demo_path = tmp_path / "library.dem"
    cached_path = tmp_path / "demo-cache" / "library.dem"
    demo_path.write_bytes(b"demo")
    cached_path.parent.mkdir(parents=True)
    cached_path.write_bytes(b"demo")
    calls: list[object] = []

    async def fake_get_demo_by_id(demo_id):
        calls.append(("get", demo_id))
        return {"id": demo_id, "path": str(demo_path), "cached_path": str(cached_path)}

    async def fake_delete_demo(demo_id):
        calls.append(("delete", demo_id))
        cached_path.unlink(missing_ok=True)
        return True

    async def fake_notify(_self, event):
        calls.append(("notify", event))

    def fake_remove_row(demo):
        calls.append(("cache", demo.get("path"), demo.get("cached_path")))
        return {"removed_files": 3, "removed_bytes": 42, "errors": []}

    monkeypatch.setattr(main.demo_db, "get_demo_by_id", fake_get_demo_by_id)
    monkeypatch.setattr(main.demo_db, "delete_demo", fake_delete_demo)
    monkeypatch.setattr(type(demo_library_api.demo_library_hub), "notify", fake_notify)
    monkeypatch.setattr(replay_cache_storage, "remove_demo_row_caches", fake_remove_row)

    result = asyncio.run(demo_library_api.delete_demo(17))

    assert result["replay_cache"] == {
        "removed_files": 3,
        "removed_bytes": 42,
        "errors": [],
    }
    assert calls == [
        ("get", 17),
        ("cache", str(demo_path), str(cached_path)),
        ("delete", 17),
        ("notify", "deleted"),
    ]


def test_remove_demo_row_caches_covers_working_copy(tmp_path, monkeypatch):
    monkeypatch.setenv("CS2_INSIGHT_DATA_DIR", str(tmp_path))
    original = tmp_path / "original.dem"
    cached = tmp_path / "demo-cache" / "working.dem"
    original.write_bytes(b"original")
    cached.parent.mkdir(parents=True)
    cached.write_bytes(b"working")

    match_root = replay_cache_storage.replay_cache_namespace_root("matches")
    _write_match_entry(match_root, "match-working", cached)
    replay_effects_cache.save_tracks(demo_path=str(cached), tracks=[], capabilities={})

    removed = replay_cache_storage.remove_demo_row_caches(
        {"path": str(original), "cached_path": str(cached)}
    )

    assert removed["removed_files"] >= 3
    assert removed["errors"] == []
    assert not (match_root / "match-working.parquet").exists()
    assert cached.is_file()  # working copy unlink is delete_demo's job


def test_remove_demo_row_caches_bootstraps_all_paths_in_one_namespace_pass(
    tmp_path,
    monkeypatch,
):
    monkeypatch.setenv("CS2_INSIGHT_DATA_DIR", str(tmp_path))
    original = str(tmp_path / "original.dem")
    cached = str(tmp_path / "cached.dem")
    calls: list[tuple[str, ...]] = []

    def fake_remove(paths, *, register_survivors=False):
        assert register_survivors is True
        calls.append(tuple(paths))
        return {"removed_files": 0, "removed_bytes": 0}

    monkeypatch.setattr(replay_match_cache, "remove_match_caches_for_demos", fake_remove)
    monkeypatch.setattr(replay_frames_cache, "remove_frames_for_demos", fake_remove)
    monkeypatch.setattr(replay_effects_cache, "remove_tracks_for_demos", fake_remove)

    result = replay_cache_storage.remove_demo_row_caches(
        {"path": original, "cached_path": cached}
    )

    assert result == {"removed_files": 0, "removed_bytes": 0, "errors": []}
    assert calls == [(original, cached), (original, cached), (original, cached)]
    assert replay_cache_owners.owner_index_ready() is True


def test_ready_owner_index_deletes_directly_without_namespace_scan(tmp_path, monkeypatch):
    monkeypatch.setenv("CS2_INSIGHT_DATA_DIR", str(tmp_path))
    demo_path = tmp_path / "indexed.dem"
    demo_path.write_bytes(b"demo")
    match_root = replay_cache_storage.replay_cache_namespace_root("matches")
    _write_match_entry(match_root, "indexed-match", demo_path)
    files = (
        match_root / "indexed-match.parquet",
        match_root / "indexed-match.meta.json",
    )
    replay_cache_owners.register_replay_cache_entry(
        "matches",
        str(demo_path),
        "indexed-match",
        files,
    )
    replay_cache_owners.mark_owner_index_ready()

    def unexpected_scan(*_args, **_kwargs):
        raise AssertionError("ready owner index must bypass namespace scans")

    monkeypatch.setattr(replay_match_cache, "remove_match_caches_for_demos", unexpected_scan)
    monkeypatch.setattr(replay_frames_cache, "remove_frames_for_demos", unexpected_scan)
    monkeypatch.setattr(replay_effects_cache, "remove_tracks_for_demos", unexpected_scan)

    removed = replay_cache_storage.remove_demo_replay_cache(str(demo_path))

    assert removed["removed_files"] == 2
    assert removed["errors"] == []
    assert all(not path.exists() for path in files)


def test_owner_index_keeps_primary_and_legacy_entries_with_the_same_key(
    tmp_path,
    monkeypatch,
):
    monkeypatch.setenv("CS2_INSIGHT_DATA_DIR", str(tmp_path))
    demo_path = tmp_path / "duplicate-root.dem"
    demo_path.write_bytes(b"demo")
    primary = replay_cache_storage.replay_cache_namespace_root("matches")
    legacy = tmp_path / "replay-match"
    _write_match_entry(primary, "same-key", demo_path)
    _write_match_entry(legacy, "same-key", demo_path)

    warmed = replay_cache_storage.ensure_replay_cache_owner_index()
    records, errors = replay_cache_owners.load_owner_records([str(demo_path)])

    assert warmed == {"ready": True, "rebuilt": True, "errors": []}
    assert errors == []
    assert len(records) == 2

    removed = replay_cache_storage.remove_demo_replay_cache(str(demo_path))

    assert removed["removed_files"] == 4
    assert removed["errors"] == []
