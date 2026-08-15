from __future__ import annotations

import asyncio
import threading

import pytest
from fastapi import HTTPException

from app import demo_parse_isolation
from app.api import demo_replay as demo_replay_api
from app.features.demo_analysis import replay_match_cache


@pytest.fixture(autouse=True)
def bypass_demo_library_lookup(monkeypatch):
    """Keep direct-path replay tests independent from the library database."""

    async def not_in_library(_path):
        return None

    monkeypatch.setattr(demo_replay_api.demo_db, "get_demo_by_path", not_in_library)
    monkeypatch.setattr(demo_replay_api.demo_db, "get_demo_by_cached_path", not_in_library)


def _request(path: str) -> demo_replay_api.DemoReplayRequest:
    return demo_replay_api.DemoReplayRequest(
        path=path,
        map_name="de_mirage",
        start_tick=100,
        end_tick=164,
        tick_rate=64,
        fps=32,
    )


def test_binary_endpoint_repairs_cold_parquet_from_persisted_workspace(
    monkeypatch,
    tmp_path,
):
    demo_path = tmp_path / "match.dem"
    demo_path.write_bytes(b"demo")
    load_calls = 0
    materialize_calls: list[dict] = []

    def fake_load(*_args, **_kwargs):
        nonlocal load_calls
        load_calls += 1
        return None if load_calls == 1 else b"CS2RPL01-repaired"

    async def fake_get_result(path):
        assert path == str(demo_path.resolve())
        return {"analysis_workspace": {"rounds": [{"round_number": 1}]}}

    def fake_materialize(path, workspace, *, fps):
        materialize_calls.append({"path": path, "workspace": workspace, "fps": fps})
        return {"status": "materialized"}

    monkeypatch.setattr(replay_match_cache, "load_match_replay_round_binary", fake_load)
    monkeypatch.setattr(demo_replay_api.demo_db, "get_result", fake_get_result)
    monkeypatch.setattr(
        demo_parse_isolation,
        "materialize_match_replay_parquet_isolated",
        fake_materialize,
    )

    response = asyncio.run(demo_replay_api.get_demo_replay_binary(_request(str(demo_path))))

    assert response.status_code == 200
    assert response.body == b"CS2RPL01-repaired"
    assert load_calls == 2
    assert materialize_calls == [
        {
            "path": str(demo_path.resolve()),
            "workspace": {"rounds": [{"round_number": 1}]},
            "fps": 32.0,
        }
    ]


def test_binary_endpoint_uses_original_library_path_when_working_copy_is_cached(
    monkeypatch,
    tmp_path,
):
    original_path = tmp_path / "library" / "match.dem"
    cached_path = tmp_path / "demo-cache" / "cached.dem"
    original_path.parent.mkdir()
    cached_path.parent.mkdir()
    original_path.write_bytes(b"original")
    cached_path.write_bytes(b"cached")
    load_calls = 0
    result_lookups: list[str] = []

    async def fake_resolve(path, *, demo_db):
        assert path == str(original_path)
        assert demo_db is demo_replay_api.demo_db
        return cached_path.resolve()

    def fake_load(path, **_kwargs):
        nonlocal load_calls
        assert path == str(cached_path.resolve())
        load_calls += 1
        return None if load_calls == 1 else b"CS2RPL01-cached-repaired"

    async def fake_get_result(path):
        result_lookups.append(path)
        if path == str(original_path):
            return {"analysis_workspace": {"rounds": [{"round_number": 1}]}}
        return None

    def fake_materialize(path, workspace, *, fps):
        assert path == str(cached_path.resolve())
        assert workspace == {"rounds": [{"round_number": 1}]}
        assert fps == 32.0
        return {"status": "materialized"}

    monkeypatch.setattr(demo_replay_api, "resolve_working_demo_path", fake_resolve)
    monkeypatch.setattr(replay_match_cache, "load_match_replay_round_binary", fake_load)
    monkeypatch.setattr(demo_replay_api.demo_db, "get_result", fake_get_result)
    monkeypatch.setattr(
        demo_parse_isolation,
        "materialize_match_replay_parquet_isolated",
        fake_materialize,
    )

    response = asyncio.run(demo_replay_api.get_demo_replay_binary(_request(str(original_path))))

    assert response.status_code == 200
    assert response.body == b"CS2RPL01-cached-repaired"
    assert result_lookups == [str(original_path)]
    assert load_calls == 2


def test_binary_endpoint_reports_reanalysis_when_workspace_is_unavailable(
    monkeypatch,
    tmp_path,
):
    demo_path = tmp_path / "match.dem"
    demo_path.write_bytes(b"demo")
    monkeypatch.setattr(
        replay_match_cache,
        "load_match_replay_round_binary",
        lambda *_args, **_kwargs: None,
    )

    async def fake_get_result(_path):
        return None

    monkeypatch.setattr(demo_replay_api.demo_db, "get_result", fake_get_result)

    with pytest.raises(HTTPException) as error:
        asyncio.run(demo_replay_api.get_demo_replay_binary(_request(str(demo_path))))

    assert error.value.status_code == 409
    assert "analyze the demo again" in str(error.value.detail)


def test_concurrent_binary_cold_misses_share_one_materialization(
    monkeypatch,
    tmp_path,
):
    demo_path = tmp_path / "match.dem"
    demo_path.write_bytes(b"demo")
    call_lock = threading.Lock()
    both_initial_loads = threading.Event()
    load_calls = 0
    materialize_calls = 0

    def fake_load(*_args, **_kwargs):
        nonlocal load_calls
        with call_lock:
            load_calls += 1
            current = load_calls
            if current >= 2:
                both_initial_loads.set()
        return None if current <= 2 else b"CS2RPL01-shared"

    async def fake_get_result(_path):
        return {"analysis_workspace": {"rounds": [{"round_number": 1}]}}

    def fake_materialize(*_args, **_kwargs):
        nonlocal materialize_calls
        materialize_calls += 1
        assert both_initial_loads.wait(timeout=2)
        return {"status": "materialized"}

    monkeypatch.setattr(replay_match_cache, "load_match_replay_round_binary", fake_load)
    monkeypatch.setattr(demo_replay_api.demo_db, "get_result", fake_get_result)
    monkeypatch.setattr(
        demo_parse_isolation,
        "materialize_match_replay_parquet_isolated",
        fake_materialize,
    )

    async def run_both():
        return await asyncio.gather(
            demo_replay_api.get_demo_replay_binary(_request(str(demo_path))),
            demo_replay_api.get_demo_replay_binary(_request(str(demo_path))),
        )

    responses = asyncio.run(run_both())

    assert [response.body for response in responses] == [
        b"CS2RPL01-shared",
        b"CS2RPL01-shared",
    ]
    assert materialize_calls == 1
    assert load_calls == 3
