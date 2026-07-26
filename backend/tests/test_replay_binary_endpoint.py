from __future__ import annotations

import asyncio
import threading

import pytest
from fastapi import HTTPException

from app import demo_parse_isolation, main
from app.parser import replay_match_cache


def _request(path: str) -> main.DemoReplayRequest:
    return main.DemoReplayRequest(
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
    monkeypatch.setattr(main.demo_db, "get_result", fake_get_result)
    monkeypatch.setattr(
        demo_parse_isolation,
        "materialize_match_replay_parquet_isolated",
        fake_materialize,
    )

    response = asyncio.run(main.get_demo_replay_binary(_request(str(demo_path))))

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

    monkeypatch.setattr(main.demo_db, "get_result", fake_get_result)

    with pytest.raises(HTTPException) as error:
        asyncio.run(main.get_demo_replay_binary(_request(str(demo_path))))

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
    monkeypatch.setattr(main.demo_db, "get_result", fake_get_result)
    monkeypatch.setattr(
        demo_parse_isolation,
        "materialize_match_replay_parquet_isolated",
        fake_materialize,
    )

    async def run_both():
        return await asyncio.gather(
            main.get_demo_replay_binary(_request(str(demo_path))),
            main.get_demo_replay_binary(_request(str(demo_path))),
        )

    responses = asyncio.run(run_both())

    assert [response.body for response in responses] == [
        b"CS2RPL01-shared",
        b"CS2RPL01-shared",
    ]
    assert materialize_calls == 1
    assert load_calls == 3
