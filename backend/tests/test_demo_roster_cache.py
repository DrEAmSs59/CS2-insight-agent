import asyncio
import sys
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import AsyncMock


sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from app import demo_parse_isolation, main, parse_worker
from app.demo_db import DemoDB
from app.env_utils import AppConfig
from app.features.demo_analysis import inspection
from app.features.demo_analysis import workflows
from app.features.demo_library import roster
from app.features.demo_library import api as demo_library_api


def _cache_metadata(
    demo_path: str,
    *,
    state: str = "ready",
    row_count: int = 1,
    error_msg: str | None = None,
    cache_version: int | None = None,
):
    normalized_path, file_size, mtime_ns = roster._demo_roster_source_fingerprint(demo_path)
    return {
        "demo_path": normalized_path,
        "cache_version": (
            roster._DEMO_ROSTER_CACHE_VERSION if cache_version is None else cache_version
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
    monkeypatch.setattr(roster, "index_demo_player_stats", index_mock)

    result = asyncio.run(roster.get_or_index_demo_roster(12, "match.dem"))

    assert result["cache_hit"] is True
    assert result["players"] == [{
        "name": "alpha",
        "player_name": "alpha",
        "player_key": "steamid:76561198000000001",
        "team": 3,
        "team_number": 3,
        "team_name": None,
        "player_color": None,
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
    monkeypatch.setattr(roster, "index_demo_player_stats", index_mock)

    result = asyncio.run(roster.get_or_index_demo_roster(13, "match.dem"))

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
    monkeypatch.setattr(demo_library_api, "get_or_index_demo_roster", lookup_mock)
    monkeypatch.setattr(
        demo_library_api,
        "library_working_demo_path",
        AsyncMock(return_value=Path("match.dem")),
    )

    response = asyncio.run(demo_library_api.batch_demo_summary(demo_library_api.BatchSummaryBody(ids=[21])))

    assert response["items"][0]["players"] == roster
    lookup_mock.assert_awaited_once()


def test_batch_demo_summary_materializes_working_cache_for_legacy_rows(monkeypatch, tmp_path):
    """Pre-cache-era done rows get cached_path when load-selected hits batch-summary."""
    original = tmp_path / "legacy.dem"
    original.write_bytes(b"legacy-demo-bytes")
    working = tmp_path / "demo-cache" / "aabb.dem"
    working.parent.mkdir(parents=True)
    working.write_bytes(original.read_bytes())
    row = {
        "id": 99,
        "path": str(original),
        "filename": "legacy.dem",
        "status": "done",
        "cached_path": None,
        "map_name": "de_dust2",
        "players": [{"name": "alpha", "team": 2}],
        "result": None,
    }
    monkeypatch.setattr(
        main.demo_db,
        "get_demo_list_items",
        AsyncMock(return_value=[dict(row)]),
    )
    ensure_calls: list[dict] = []

    async def fake_working(row_arg):
        ensure_calls.append(dict(row_arg))
        row_arg["cached_path"] = str(working)
        return working

    roster_paths: list[object] = []

    async def fake_roster(demo_id, dem_path, **_kwargs):
        roster_paths.append(dem_path)
        return {
            "players": [{"name": "alpha", "team": 2}],
            "cache_hit": True,
            "indexed": True,
            "error": None,
        }

    monkeypatch.setattr(demo_library_api, "library_working_demo_path", fake_working)
    monkeypatch.setattr(demo_library_api, "get_or_index_demo_roster", fake_roster)

    response = asyncio.run(demo_library_api.batch_demo_summary(demo_library_api.BatchSummaryBody(ids=[99])))

    assert len(ensure_calls) == 1
    assert response["failed"] == []
    assert response["items"][0]["cached_path"] == str(working)
    assert response["items"][0]["path"] == str(original)
    assert roster_paths == [str(original)]


def test_batch_demo_summary_reports_missing_original_as_item_failure(monkeypatch):
    monkeypatch.setattr(
        main.demo_db,
        "get_demo_list_items",
        AsyncMock(
            return_value=[{
                "id": 44,
                "path": "C:/missing/gone.dem",
                "filename": "gone.dem",
                "status": "done",
                "cached_path": None,
                "players": [],
                "result": None,
            }],
        ),
    )

    async def fake_working(_row):
        raise FileNotFoundError("Demo original missing: C:/missing/gone.dem")

    monkeypatch.setattr(demo_library_api, "library_working_demo_path", fake_working)
    monkeypatch.setattr(demo_library_api, "get_or_index_demo_roster", AsyncMock())

    response = asyncio.run(demo_library_api.batch_demo_summary(demo_library_api.BatchSummaryBody(ids=[44])))

    assert response["items"] == []
    assert response["failed"] == [{
        "id": 44,
        "filename": "gone.dem",
        "code": "DEMO_FILE_NOT_FOUND",
    }]
    demo_library_api.get_or_index_demo_roster.assert_not_awaited()


def test_batch_resolve_players_reports_roster_failure_without_raw_error(monkeypatch):
    monkeypatch.setattr(
        main.demo_db,
        "get_demo_by_id",
        AsyncMock(return_value={
            "id": 21,
            "path": "broken.dem",
            "filename": "broken.dem",
        }),
    )
    monkeypatch.setattr(
        demo_library_api,
        "get_or_index_demo_roster",
        AsyncMock(side_effect=RuntimeError("native parser implementation detail")),
    )

    response = asyncio.run(demo_library_api.batch_resolve_players(demo_library_api.BatchResolvePlayersBody(
        demo_ids=[21],
        mode="manual",
        manual_lines=["alpha"],
    )))

    assert response["resolved"] == {"21": []}
    assert response["failed"] == [{
        "id": 21,
        "filename": "broken.dem",
        "code": "DEMO_INSPECTION_FAILED",
    }]


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
    monkeypatch.setattr(roster, "index_demo_player_stats", index_once)

    async def scenario():
        return await asyncio.gather(
            roster.get_or_index_demo_roster(31337, "same.dem"),
            roster.get_or_index_demo_roster(31337, "same.dem"),
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
    monkeypatch.setattr(roster, "index_demo_player_stats", index_mock)

    result = asyncio.run(roster.get_or_index_demo_roster(88, "partial.dem"))

    assert result["cache_hit"] is False
    assert [player["name"] for player in result["players"]] == ["alpha", "bravo"]
    index_mock.assert_awaited_once_with(88, "partial.dem")


def test_empty_and_error_roster_states_are_negative_cached(monkeypatch):
    cache_mock = AsyncMock()
    monkeypatch.setattr(main.demo_db, "get_demo_roster_cache", cache_mock)
    index_mock = AsyncMock(side_effect=AssertionError("negative cache must not parse"))
    monkeypatch.setattr(roster, "index_demo_player_stats", index_mock)

    cache_mock.return_value = _cache_metadata("empty.dem", state="empty", row_count=0)
    empty = asyncio.run(roster.get_or_index_demo_roster(89, "empty.dem"))
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
    error = asyncio.run(roster.get_or_index_demo_roster(90, "error.dem"))
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
    monkeypatch.setattr(roster, "index_demo_player_stats", index_mock)

    result = asyncio.run(roster.get_or_index_demo_roster(91, "old.dem"))

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
    monkeypatch.setattr(roster, "index_demo_player_stats", index_mock)

    result = asyncio.run(roster.get_or_index_demo_roster(94, str(demo_path)))

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

    result = asyncio.run(roster.index_demo_player_stats(92, str(demo_path)))

    assert result["indexed"] is True
    replace_mock.assert_awaited_once_with(92, str(demo_path), players)
    kwargs = save_mock.await_args.kwargs
    assert kwargs["cache_version"] == roster._DEMO_ROSTER_CACHE_VERSION
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
    monkeypatch.setattr(demo_library_api, "demo_library_hub", SimpleNamespace(notify=AsyncMock()))

    response = asyncio.run(demo_library_api.reparse_demo(93))

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
                "player_color": "purple",
                "kills": 14,
                "deaths": 12,
                "assists": 5,
            }],
        )
        await db.save_demo_roster_cache(
            demo_id,
            demo_path,
            cache_version=roster._DEMO_ROSTER_CACHE_VERSION,
            source_file_size=None,
            source_mtime_ns=None,
            state="ready",
            row_count=1,
        )
        cached = await db.list_demo_player_stats(demo_id)
        return roster._roster_rows_for_api(cached), await db.get_demo_roster_cache(demo_id)

    players, metadata = asyncio.run(scenario())
    assert players == [{
        "name": "alpha",
        "player_name": "alpha",
        "player_key": "steamid:76561198000000002",
        "team": 2,
        "team_number": 2,
        "team_name": None,
        "player_color": "purple",
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
    assert metadata["cache_version"] == roster._DEMO_ROSTER_CACHE_VERSION


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
        return {"__has_player_keyboard_input__": False, **parsed}

    monkeypatch.setattr(demo_parse_isolation, "analyze_multi_isolated", fake_analyze_multi)
    monkeypatch.setattr(workflows, "get_or_index_demo_roster", AsyncMock(return_value={"error": None}))
    monkeypatch.setattr(
        main.demo_db,
        "get_demo_by_id",
        AsyncMock(return_value={"id": 7, "path": "match.dem"}),
    )
    monkeypatch.setattr(main, "load_config", AppConfig)
    clear_result = AsyncMock(side_effect=AssertionError("last-known-good result must not be cleared before parse"))
    monkeypatch.setattr(main.demo_db, "clear_result", clear_result)
    monkeypatch.setattr(main.demo_db, "update_status", AsyncMock())
    save_result = AsyncMock()
    monkeypatch.setattr(main.demo_db, "save_result", save_result)
    monkeypatch.setattr(main.demo_db, "replace_timeline_events", AsyncMock())

    response = asyncio.run(
        workflows.run_library_demo_analyze(
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
    assert composite["has_player_keyboard_input"] is False
    assert response["has_player_keyboard_input"] is False
    clear_result.assert_not_awaited()


def test_library_analyze_persists_status_on_original_path(monkeypatch, tmp_path):
    """Working cache path is for I/O; DB status/result must key on demo_files.path."""
    original = tmp_path / "originals" / "legacy.dem"
    original.parent.mkdir(parents=True)
    original.write_bytes(b"demo")
    working = tmp_path / "demo-cache" / "aabb.dem"
    working.parent.mkdir(parents=True)
    working.write_bytes(original.read_bytes())
    parsed = {
        "alpha": {
            "clips": [{"id": "a"}],
            "match_meta": {"target_player": "alpha"},
            "timeline": [],
            "round_timeline": [],
        }
    }
    roster_paths: list[object] = []
    status_calls: list[tuple[object, str]] = []
    worker_paths: list[object] = []
    save_paths: list[object] = []

    async def fake_roster(demo_id, path, **_kwargs):
        roster_paths.append(path)
        return {"error": None}

    async def fake_update_status(path, status, **_kwargs):
        status_calls.append((path, status))

    async def fake_save_result(path, result, **_kwargs):
        save_paths.append(path)

    def fake_analyze_multi(path, target_players, freeze_rounds):
        worker_paths.append(path)
        return parsed

    monkeypatch.setattr(
        main.demo_db,
        "get_demo_by_id",
        AsyncMock(return_value={"id": 11746, "path": str(original), "cached_path": str(working)}),
    )
    monkeypatch.setattr(workflows, "get_or_index_demo_roster", fake_roster)
    monkeypatch.setattr(main.demo_db, "update_status", fake_update_status)
    monkeypatch.setattr(main.demo_db, "save_result", fake_save_result)
    monkeypatch.setattr(main.demo_db, "replace_timeline_events", AsyncMock())
    monkeypatch.setattr(demo_parse_isolation, "analyze_multi_isolated", fake_analyze_multi)
    monkeypatch.setattr(main, "load_config", AppConfig)
    monkeypatch.setattr(workflows, "demo_library_hub", SimpleNamespace(notify=AsyncMock()))

    response = asyncio.run(
        workflows.run_library_demo_analyze(11746, Path(working), ["alpha"])
    )

    assert roster_paths == [str(original)]
    assert worker_paths == [str(working)]
    assert save_paths == [str(original)]
    assert status_calls[0] == (str(original), "parsing")
    assert status_calls[-1][0] == str(original)
    assert status_calls[-1][1] == "done"
    assert response["demo_path"] == str(original)


def test_upload_metadata_uses_one_combined_inspection_worker(monkeypatch):
    expected = {
        "players": [{"name": "alpha"}],
        "match_meta": {"map_name": "de_nuke", "total_rounds": 24},
    }
    calls = []

    def fake_inspect(dem_path):
        calls.append(dem_path)
        return expected

    monkeypatch.setattr(demo_parse_isolation, "inspect_demo_isolated", fake_inspect)

    players, match_meta, error_code = asyncio.run(
        inspection.safe_upload_demo_meta(Path("match.dem"))
    )

    assert players == expected["players"]
    assert match_meta == expected["match_meta"]
    assert error_code is None
    assert calls == ["match.dem"]


def test_upload_metadata_returns_safe_timeout_code(monkeypatch):
    def fake_inspect(_dem_path):
        raise RuntimeError("worker timed out with internal details")

    monkeypatch.setattr(demo_parse_isolation, "inspect_demo_isolated", fake_inspect)

    players, match_meta, error_code = asyncio.run(
        inspection.safe_upload_demo_meta(Path("broken.dem"))
    )

    assert players == []
    assert match_meta == {}
    assert error_code == "DEMO_INSPECTION_TIMEOUT"


def test_parse_worker_dispatches_combined_inspection(monkeypatch):
    expected = {
        "players": [{"name": "alpha"}],
        "match_meta": {"map_name": "de_nuke"},
    }
    calls = []

    def fake_inspect(dem_path):
        calls.append(dem_path)
        return expected

    monkeypatch.setattr(parse_worker, "inspect_demo", fake_inspect)

    assert parse_worker._run({"action": "inspect", "dem_path": "match.dem"}) == expected
    assert calls == ["match.dem"]


def test_index_demo_player_stats_reuses_precomputed_roster(monkeypatch):
    players = [{"name": "alpha", "team": 2}]
    worker_calls = []

    def worker_must_not_run(dem_path):
        worker_calls.append(dem_path)
        raise AssertionError("roster worker should not run")

    monkeypatch.setattr(
        demo_parse_isolation,
        "get_player_list_isolated",
        worker_must_not_run,
    )
    replace_stats = AsyncMock()
    save_cache = AsyncMock()
    monkeypatch.setattr(main.demo_db, "replace_demo_player_stats", replace_stats)
    monkeypatch.setattr(main.demo_db, "save_demo_roster_cache", save_cache)

    result = asyncio.run(
        roster.index_demo_player_stats(
            7,
            "match.dem",
            precomputed_players=players,
        )
    )

    assert worker_calls == []
    assert result["players"] == players
    replace_stats.assert_awaited_once_with(7, "match.dem", players)
    assert save_cache.await_args.kwargs["row_count"] == 1


def test_batch_ingest_bounds_inspection_concurrency_and_reuses_rosters(
    monkeypatch,
    tmp_path,
):
    rows = []
    for demo_id in (1, 2, 3):
        demo_path = tmp_path / f"match-{demo_id}.dem"
        demo_path.write_bytes(b"demo")
        rows.append({
            "id": demo_id,
            "path": str(demo_path),
            "filename": demo_path.name,
            "status": "pending",
        })

    active = 0
    max_active = 0

    async def fake_inspect(dem_path):
        nonlocal active, max_active
        active += 1
        max_active = max(max_active, active)
        await asyncio.sleep(0.01)
        active -= 1
        return ([{"name": dem_path.stem}], {"map_name": "de_test"})

    monkeypatch.setattr(demo_library_api, "demo_inspect_concurrency", lambda: 2)
    monkeypatch.setattr(demo_library_api, "inspect_demo_meta", fake_inspect)

    async def fake_working(row):
        return Path(str(row["path"]))

    monkeypatch.setattr(demo_library_api, "library_working_demo_path", fake_working)
    compat_calls: list[tuple[str, bool]] = []

    def fake_ensure(path, *, allow_truncated_packet_tail=False):
        compat_calls.append((str(path), allow_truncated_packet_tail))
        return SimpleNamespace()

    monkeypatch.setattr(demo_library_api, "ensure_demo_compatible", fake_ensure)
    monkeypatch.setattr(
        main.demo_db,
        "get_demo_list_items",
        AsyncMock(return_value=rows),
    )
    persist_ingest = AsyncMock(return_value={"indexed": True, "error": None})
    monkeypatch.setattr(demo_library_api, "persist_ingested_demo", persist_ingest)
    notify = AsyncMock()
    monkeypatch.setattr(demo_library_api, "demo_library_hub", SimpleNamespace(notify=notify))

    response = asyncio.run(
        demo_library_api.batch_ingest_demos(demo_library_api.BatchIngestBody(demo_ids=[1, 2, 3]))
    )

    assert response == {"ingested": 3, "failed": []}
    assert compat_calls == [
        (str(tmp_path / f"match-{demo_id}.dem"), True)
        for demo_id in (1, 2, 3)
    ]
    assert max_active == 2
    assert [call.args[0] for call in persist_ingest.await_args_list] == [1, 2, 3]
    assert [
        call.kwargs["players"][0]["name"]
        for call in persist_ingest.await_args_list
    ] == ["match-1", "match-2", "match-3"]
    notify.assert_awaited_once_with("enqueue")
