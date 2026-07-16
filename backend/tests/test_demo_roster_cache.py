import asyncio
import sys
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import AsyncMock


sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from app import demo_parse_isolation, main
from app.demo_db import DemoDB
from app.env_utils import AppConfig


def _cache_metadata(
    demo_path: str,
    *,
    state: str = "ready",
    row_count: int = 1,
    error_msg: str | None = None,
    cache_version: int | None = None,
):
    normalized_path, file_size, mtime_ns = main._demo_roster_source_fingerprint(demo_path)
    return {
        "demo_path": normalized_path,
        "cache_version": (
            main._DEMO_ROSTER_CACHE_VERSION if cache_version is None else cache_version
        ),
        "source_content_md5": None,
        "current_content_md5": None,
        "source_file_size": file_size,
        "source_mtime_ns": mtime_ns,
        "state": state,
        "row_count": row_count,
        "error_msg": error_msg,
    }


def test_get_or_index_demo_roster_reuses_persisted_stats(monkeypatch):
    cached = [
        {
            "player_name": "alpha",
            "team_number": 3,
            "steam_id64": "76561198000000001",
            "account_id": "7",
            "kills": 20,
            "deaths": 10,
            "assists": 4,
            "kd": 2.0,
        },
    ]
    monkeypatch.setattr(
        main.demo_db,
        "get_demo_roster_cache",
        AsyncMock(return_value=_cache_metadata("match.dem")),
    )
    monkeypatch.setattr(main.demo_db, "list_demo_player_stats", AsyncMock(return_value=cached))
    index_mock = AsyncMock(side_effect=AssertionError("cache hit must not parse the Demo"))
    monkeypatch.setattr(main, "index_demo_player_stats", index_mock)

    result = asyncio.run(main.get_or_index_demo_roster(12, "match.dem"))

    assert result["cache_hit"] is True
    assert result["players"] == [{
        "name": "alpha",
        "player_name": "alpha",
        "team": 3,
        "team_number": 3,
        "team_name": None,
        "steam_id": "76561198000000001",
        "steam_id64": "76561198000000001",
        "steamid64": "76561198000000001",
        "account_id": "7",
        "user_id": None,
        "kills": 20,
        "deaths": 10,
        "assists": 4,
        "kd": 2.0,
    }]
    index_mock.assert_not_awaited()


def test_get_or_index_demo_roster_indexes_only_on_cache_miss(monkeypatch):
    monkeypatch.setattr(main.demo_db, "get_demo_roster_cache", AsyncMock(return_value=None))
    parsed = [
        {
            "name": "bravo",
            "team": 2,
            "steam_id": "76561198000000002",
            "user_id": 11,
            "kills": 14,
            "deaths": 12,
            "assists": 5,
        },
    ]
    index_mock = AsyncMock(
        return_value={
            "indexed": True,
            "player_count": 1,
            "players": parsed,
            "error": None,
        },
    )
    monkeypatch.setattr(main, "index_demo_player_stats", index_mock)

    result = asyncio.run(main.get_or_index_demo_roster(13, "match.dem"))

    assert result["cache_hit"] is False
    assert result["indexed"] is True
    assert result["players"][0]["name"] == "bravo"
    assert result["players"][0]["team_number"] == 2
    assert result["players"][0]["steam_id64"] == "76561198000000002"
    assert result["players"][0]["account_id"] == "39734274"
    assert result["players"][0]["user_id"] == "11"
    index_mock.assert_awaited_once_with(13, "match.dem")


def test_batch_demo_summary_uses_roster_cache(monkeypatch):
    monkeypatch.setattr(
        main.demo_db,
        "get_demo_list_items",
        AsyncMock(
            return_value=[
                {
                    "id": 21,
                    "path": "match.dem",
                    "filename": "match.dem",
                    "map_name": "de_nuke",
                    "players": [{"name": "stale-shape"}],
                    "result": None,
                },
            ],
        ),
    )
    roster = [{"name": "alpha", "team": 3, "steam_id": "76561198000000001"}]
    lookup_mock = AsyncMock(
        return_value={
            "players": roster,
            "cache_hit": True,
            "indexed": True,
            "error": None,
        },
    )
    monkeypatch.setattr(main, "get_or_index_demo_roster", lookup_mock)

    response = asyncio.run(main.batch_demo_summary(main.BatchSummaryBody(ids=[21])))

    assert response["items"][0]["players"] == roster
    lookup_mock.assert_awaited_once()


def test_get_or_index_demo_roster_single_flights_concurrent_misses(monkeypatch):
    state = {"indexed": False, "calls": 0}
    parsed = [{
        "name": "alpha",
        "team": 2,
        "steam_id": "76561198000000002",
        "user_id": 11,
        "kills": 14,
        "deaths": 12,
        "assists": 5,
    }]

    async def list_stats(_demo_id):
        if not state["indexed"]:
            return []
        return [{
            "player_name": "alpha",
            "team_number": 2,
            "steam_id64": "76561198000000002",
            "account_id": "39734274",
            "user_id": "11",
            "kills": 14,
            "deaths": 12,
            "assists": 5,
            "kd": 1.167,
        }]

    async def get_cache(_demo_id):
        if not state["indexed"]:
            return None
        return _cache_metadata("same.dem")

    async def index_once(_demo_id, _demo_path):
        state["calls"] += 1
        await asyncio.sleep(0.02)
        state["indexed"] = True
        return {
            "indexed": True,
            "player_count": 1,
            "players": parsed,
            "error": None,
        }

    monkeypatch.setattr(main.demo_db, "get_demo_roster_cache", get_cache)
    monkeypatch.setattr(main.demo_db, "list_demo_player_stats", list_stats)
    monkeypatch.setattr(main, "index_demo_player_stats", index_once)

    async def scenario():
        return await asyncio.gather(
            main.get_or_index_demo_roster(31337, "same.dem"),
            main.get_or_index_demo_roster(31337, "same.dem"),
        )

    first, second = asyncio.run(scenario())
    assert state["calls"] == 1
    assert first["cache_hit"] is False
    assert second["cache_hit"] is True


def test_partial_or_stale_roster_cache_is_rebuilt(monkeypatch):
    partial = [{"player_name": "alpha", "team_number": 2}]
    metadata = _cache_metadata("partial.dem", row_count=2)
    monkeypatch.setattr(
        main.demo_db,
        "get_demo_roster_cache",
        AsyncMock(return_value=metadata),
    )
    monkeypatch.setattr(
        main.demo_db,
        "list_demo_player_stats",
        AsyncMock(return_value=partial),
    )
    rebuilt = [
        {"name": "alpha", "team": 2},
        {"name": "bravo", "team": 3},
    ]
    index_mock = AsyncMock(
        return_value={
            "indexed": True,
            "player_count": 2,
            "players": rebuilt,
            "error": None,
        }
    )
    monkeypatch.setattr(main, "index_demo_player_stats", index_mock)

    result = asyncio.run(main.get_or_index_demo_roster(88, "partial.dem"))

    assert result["cache_hit"] is False
    assert [player["name"] for player in result["players"]] == ["alpha", "bravo"]
    index_mock.assert_awaited_once_with(88, "partial.dem")


def test_empty_and_error_roster_states_are_negative_cached(monkeypatch):
    cache_mock = AsyncMock()
    monkeypatch.setattr(main.demo_db, "get_demo_roster_cache", cache_mock)
    index_mock = AsyncMock(side_effect=AssertionError("negative cache must not parse"))
    monkeypatch.setattr(main, "index_demo_player_stats", index_mock)

    cache_mock.return_value = _cache_metadata("empty.dem", state="empty", row_count=0)
    empty = asyncio.run(main.get_or_index_demo_roster(89, "empty.dem"))
    assert empty == {
        "players": [],
        "cache_hit": True,
        "indexed": True,
        "error": None,
    }

    cache_mock.return_value = _cache_metadata(
        "error.dem",
        state="error",
        row_count=0,
        error_msg="broken demo",
    )
    error = asyncio.run(main.get_or_index_demo_roster(90, "error.dem"))
    assert error == {
        "players": [],
        "cache_hit": True,
        "indexed": False,
        "error": "broken demo",
    }
    index_mock.assert_not_awaited()


def test_roster_cache_version_mismatch_forces_rebuild(monkeypatch):
    monkeypatch.setattr(
        main.demo_db,
        "get_demo_roster_cache",
        AsyncMock(return_value=_cache_metadata("old.dem", cache_version=0)),
    )
    index_mock = AsyncMock(
        return_value={
            "indexed": True,
            "player_count": 1,
            "players": [{"name": "fresh", "team": 2}],
            "error": None,
        }
    )
    monkeypatch.setattr(main, "index_demo_player_stats", index_mock)

    result = asyncio.run(main.get_or_index_demo_roster(91, "old.dem"))

    assert result["cache_hit"] is False
    assert result["players"][0]["name"] == "fresh"
    index_mock.assert_awaited_once()


def test_roster_cache_file_fingerprint_change_forces_rebuild(monkeypatch, tmp_path):
    demo_path = tmp_path / "changed.dem"
    demo_path.write_bytes(b"old")
    metadata = _cache_metadata(str(demo_path))
    demo_path.write_bytes(b"new-content")
    monkeypatch.setattr(
        main.demo_db,
        "get_demo_roster_cache",
        AsyncMock(return_value=metadata),
    )
    index_mock = AsyncMock(
        return_value={
            "indexed": True,
            "player_count": 1,
            "players": [{"name": "fresh", "team": 2}],
            "error": None,
        }
    )
    monkeypatch.setattr(main, "index_demo_player_stats", index_mock)

    result = asyncio.run(main.get_or_index_demo_roster(94, str(demo_path)))

    assert result["cache_hit"] is False
    index_mock.assert_awaited_once()


def test_index_demo_player_stats_persists_ready_metadata(monkeypatch, tmp_path):
    demo_path = tmp_path / "indexed.dem"
    demo_path.write_bytes(b"demo")
    players = [{"name": "alpha", "team": 2}]
    monkeypatch.setattr(
        demo_parse_isolation,
        "get_player_list_isolated",
        lambda _path: players,
    )
    replace_mock = AsyncMock()
    save_mock = AsyncMock()
    monkeypatch.setattr(main.demo_db, "replace_demo_player_stats", replace_mock)
    monkeypatch.setattr(main.demo_db, "save_demo_roster_cache", save_mock)

    result = asyncio.run(main.index_demo_player_stats(92, str(demo_path)))

    assert result["indexed"] is True
    replace_mock.assert_awaited_once_with(92, str(demo_path), players)
    kwargs = save_mock.await_args.kwargs
    assert kwargs["cache_version"] == main._DEMO_ROSTER_CACHE_VERSION
    assert kwargs["state"] == "ready"
    assert kwargs["row_count"] == 1
    assert kwargs["source_file_size"] == 4
    assert isinstance(kwargs["source_mtime_ns"], int)


def test_reparse_invalidates_roster_cache(monkeypatch):
    monkeypatch.setattr(
        main.demo_db,
        "get_demo_by_id",
        AsyncMock(return_value={"id": 93, "path": "match.dem"}),
    )
    invalidate_mock = AsyncMock()
    monkeypatch.setattr(main.demo_db, "invalidate_demo_roster_cache", invalidate_mock)
    monkeypatch.setattr(main.demo_db, "clear_result", AsyncMock())
    monkeypatch.setattr(main.demo_db, "update_status", AsyncMock())
    monkeypatch.setattr(main, "demo_library_hub", SimpleNamespace(notify=AsyncMock()))

    response = asyncio.run(main.reparse_demo(93))

    assert response == {"status": "loaded", "demo_id": 93}
    invalidate_mock.assert_awaited_once_with(93, clear_rows=True)


def test_roster_cache_round_trip_preserves_public_contract(tmp_path):
    async def scenario():
        db = DemoDB(tmp_path / "roster.sqlite3")
        await db.init_db()
        demo_path = str(tmp_path / "roundtrip.dem")
        demo_id, _ = await db.add_demo(demo_path, status="done")
        await db.replace_demo_player_stats(
            demo_id,
            demo_path,
            [{
                "name": "alpha",
                "team": 2,
                "steam_id": "76561198000000002",
                "user_id": 11,
                "kills": 14,
                "deaths": 12,
                "assists": 5,
            }],
        )
        await db.save_demo_roster_cache(
            demo_id,
            demo_path,
            cache_version=main._DEMO_ROSTER_CACHE_VERSION,
            source_file_size=None,
            source_mtime_ns=None,
            state="ready",
            row_count=1,
        )
        cached = await db.list_demo_player_stats(demo_id)
        return main._roster_rows_for_api(cached), await db.get_demo_roster_cache(demo_id)

    players, metadata = asyncio.run(scenario())
    assert players == [{
        "name": "alpha",
        "player_name": "alpha",
        "team": 2,
        "team_number": 2,
        "team_name": None,
        "steam_id": "76561198000000002",
        "steam_id64": "76561198000000002",
        "steamid64": "76561198000000002",
        "account_id": "39734274",
        "user_id": "11",
        "kills": 14,
        "deaths": 12,
        "assists": 5,
        "kd": 1.167,
    }]
    assert not ({"id", "demo_id", "demo_path", "normalized_name", "indexed_at"} & players[0].keys())
    assert metadata["state"] == "ready"
    assert metadata["row_count"] == 1
    assert metadata["cache_version"] == main._DEMO_ROSTER_CACHE_VERSION


def test_library_multi_parse_normalizes_targets_and_uses_first_success(monkeypatch):
    parsed = {
        "alpha": {
            "clips": [{"id": "a"}],
            "match_meta": {"target_player": "alpha"},
            "timeline": [],
            "round_timeline": [],
        }
    }
    worker_calls = []

    def fake_analyze_multi(dem_path, target_players, freeze_rounds):
        worker_calls.append((dem_path, target_players, freeze_rounds))
        return parsed

    monkeypatch.setattr(demo_parse_isolation, "analyze_multi_isolated", fake_analyze_multi)
    monkeypatch.setattr(main, "get_or_index_demo_roster", AsyncMock(return_value={"error": None}))
    monkeypatch.setattr(main, "load_config", AppConfig)
    monkeypatch.setattr(main.demo_db, "clear_result", AsyncMock())
    monkeypatch.setattr(main.demo_db, "update_status", AsyncMock())
    save_result = AsyncMock()
    monkeypatch.setattr(main.demo_db, "save_result", save_result)
    monkeypatch.setattr(main.demo_db, "replace_timeline_events", AsyncMock())

    response = asyncio.run(
        main._run_library_demo_analyze(
            7,
            "match.dem",
            [" missing ", " alpha ", "alpha"],
        )
    )

    assert worker_calls == [("match.dem", ["missing", "alpha"], None)]
    assert response["players"] == parsed
    composite = save_result.await_args.args[1]
    assert composite["auto_target_player"] == "alpha"
    assert composite["analyzed_target_players"] == ["alpha"]
