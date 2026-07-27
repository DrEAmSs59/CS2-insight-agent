from __future__ import annotations

import asyncio
import json
from pathlib import Path

from app import main
from app.parser import replay_effects_cache, replay_frames_cache, replay_match_cache
from app.parser import replay_cache_storage


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
    demo_path.write_bytes(b"demo")
    calls: list[object] = []

    async def fake_get_demo_by_id(demo_id):
        calls.append(("get", demo_id))
        return {"id": demo_id, "path": str(demo_path)}

    async def fake_delete_demo(demo_id, *, rescan):
        calls.append(("delete", demo_id, rescan))
        return True

    async def fake_notify(_self, event):
        calls.append(("notify", event))

    def fake_remove(path):
        calls.append(("cache", path))
        return {"removed_files": 3, "removed_bytes": 42, "errors": []}

    monkeypatch.setattr(main.demo_db, "get_demo_by_id", fake_get_demo_by_id)
    monkeypatch.setattr(main.demo_db, "delete_demo", fake_delete_demo)
    monkeypatch.setattr(type(main.demo_library_hub), "notify", fake_notify)
    monkeypatch.setattr(replay_cache_storage, "remove_demo_replay_cache", fake_remove)

    result = asyncio.run(main.delete_demo(17, rescan="skip"))

    assert result["replay_cache"] == {
        "removed_files": 3,
        "removed_bytes": 42,
        "errors": [],
    }
    assert calls == [
        ("get", 17),
        ("delete", 17, "skip"),
        ("cache", str(demo_path)),
        ("notify", "deleted"),
    ]
