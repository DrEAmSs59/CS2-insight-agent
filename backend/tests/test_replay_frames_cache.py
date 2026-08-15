from __future__ import annotations

import gzip
import json
from pathlib import Path

from app.features.demo_analysis.replay_frames_cache import (
    REPLAY_FRAMES_CACHE_VERSION,
    demo_fingerprint,
    frames_cache_key,
    load_frames,
    save_frames,
)


def test_demo_fingerprint(tmp_path: Path):
    dem = tmp_path / "a.dem"
    dem.write_bytes(b"abc")
    fp = demo_fingerprint(str(dem))
    assert fp is not None
    assert fp["size"] == 3
    assert "mtime_ns" in fp
    assert fp["path"].endswith("a.dem")


def test_frames_cache_roundtrip(tmp_path: Path, monkeypatch):
    dem = tmp_path / "demo.dem"
    dem.write_bytes(b"demo")
    monkeypatch.setenv("CS2_INSIGHT_DATA_DIR", str(tmp_path))
    # Force cache root under tmp via monkeypatch of get_data_dir if needed
    import app.features.demo_analysis.replay_frames_cache as mod

    monkeypatch.setattr(mod, "_cache_root", lambda: tmp_path / "replay-frames")

    key = frames_cache_key(
        str(dem),
        round_number=1,
        start_tick=100,
        end_tick=200,
        fps=8,
    )
    assert key
    save_frames(
        key,
        frames=[{"tick": 100, "players": []}],
        fps=8,
        start_tick=100,
        end_tick=200,
        map_transform={"scale": 5.0},
        effect_tracks=[{"type": "smoke"}],
        effect_capabilities={"smoke_voxels": True},
        demo_fingerprint_meta=demo_fingerprint(str(dem)),
    )
    loaded = load_frames(key)
    assert loaded is not None
    assert loaded["version"] == REPLAY_FRAMES_CACHE_VERSION
    assert len(loaded["frames"]) == 1
    assert loaded["map_transform"]["scale"] == 5.0
    assert loaded["effect_tracks"][0]["type"] == "smoke"

    # Corrupt version invalidates
    path = tmp_path / "replay-frames" / f"{key}.json.gz"
    with gzip.open(path, "rt", encoding="utf-8") as handle:
        payload = json.load(handle)
    payload["version"] = 999
    with gzip.open(path, "wt", encoding="utf-8") as handle:
        json.dump(payload, handle)
    assert load_frames(key) is None
