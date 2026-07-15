import asyncio
import sys
from pathlib import Path
from unittest.mock import AsyncMock

import pytest
sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from app import main


def _run(coro):
    return asyncio.run(coro)


def _route_kwargs(**overrides):
    values = {
        "limit": 25,
        "offset": 5,
        "q": " match ",
        "map_names": None,
        "map_name": "de_mirage",
        "statuses": None,
        "status": "done",
        "min_kills": 18,
        "max_deaths": 20,
        "min_assists": 3,
        "min_kd": 1.1,
        "player_query": None,
        "steam_query": "7656119",
        "rounds_min": 20,
        "rounds_max": 30,
        "duration_min": 25.0,
        "duration_max": 60.0,
        "date_from": "2026-07-01",
        "date_to": "2026-07-31",
    }
    values.update(overrides)
    return values


def test_compact_list_route_uses_compact_query_and_forwards_all_filters(monkeypatch):
    calls = {}

    async def fake_count_demos(**kwargs):
        calls["count"] = kwargs
        return 1

    async def fake_list_demos_compact(**kwargs):
        calls["list"] = kwargs
        return [{"id": 7, "has_result": True, "clip_count": 2}]

    async def forbidden_legacy_list(**_kwargs):
        raise AssertionError("the list route must not load result_json")

    monkeypatch.setattr(main.demo_db, "count_demos", fake_count_demos)
    monkeypatch.setattr(main.demo_db, "list_demos_compact", fake_list_demos_compact)
    monkeypatch.setattr(main.demo_db, "list_demos", forbidden_legacy_list)

    response = _run(main.list_demos_compact_api(**_route_kwargs()))

    assert response["items"] == [{"id": 7, "has_result": True, "clip_count": 2}]
    assert response["total"] == 1
    assert response["q"] == "match"
    assert calls["count"] == {
        "name_query": "match",
        "filters": calls["list"]["filters"],
    }
    assert calls["list"]["limit"] == 25
    assert calls["list"]["offset"] == 5
    assert calls["list"]["name_query"] == "match"
    assert calls["list"]["filters"] == {
        "map_names": ["de_mirage"],
        "statuses": ["done"],
        "steam_query": "7656119",
        "min_kills": 18,
        "max_deaths": 20,
        "min_assists": 3,
        "min_kd": 1.1,
        "rounds_min": 20,
        "rounds_max": 30,
        "duration_min": 25.0,
        "duration_max": 60.0,
        "date_from": "2026-07-01",
        "date_to": "2026-07-31",
    }


def test_legacy_list_route_preserves_full_result_contract(monkeypatch):
    full_item = {"id": 7, "result": {"clips": [{"id": "clip"}]}}
    list_mock = AsyncMock(return_value=[full_item])
    compact_mock = AsyncMock(side_effect=AssertionError("legacy route must keep full results"))
    monkeypatch.setattr(main.demo_db, "count_demos", AsyncMock(return_value=1))
    monkeypatch.setattr(main.demo_db, "list_demos", list_mock)
    monkeypatch.setattr(main.demo_db, "list_demos_compact", compact_mock)

    response = _run(main.list_demos(**_route_kwargs()))

    assert response["items"] == [full_item]
    assert response["items"][0]["result"]["clips"] == [{"id": "clip"}]
    list_mock.assert_awaited_once()
    compact_mock.assert_not_awaited()


def test_list_demo_ids_returns_only_filtered_ids(monkeypatch):
    calls = []

    async def fake_list_filtered_demo_ids(**kwargs):
        calls.append(kwargs)
        return [11, 9, 3]

    monkeypatch.setattr(main.demo_db, "list_filtered_demo_ids", fake_list_filtered_demo_ids)

    response = _run(
        main.list_demo_ids(
            **_route_kwargs(
                limit=1000,
                offset=0,
                q=None,
                map_name=None,
                status=None,
                min_kills=None,
                max_deaths=None,
                min_assists=None,
                min_kd=None,
                steam_query=None,
                rounds_min=None,
                rounds_max=None,
                duration_min=None,
                duration_max=None,
                date_from=None,
                date_to=None,
            )
        )
    )

    assert response == {"ids": [11, 9, 3], "limit": 1000, "offset": 0, "q": None}
    assert calls == [
        {
            "name_query": None,
            "filters": None,
            "limit": 1000,
            "offset": 0,
        }
    ]


def test_batch_summary_reports_corrupt_result_as_item_error(monkeypatch):
    monkeypatch.setattr(
        main.demo_db,
        "get_demo_list_items",
        AsyncMock(
            return_value=[{
                "id": 7,
                "path": "broken.dem",
                "filename": "broken.dem",
                "players": [],
                "result": None,
                "result_error": "损坏的解析结果",
            }]
        ),
    )

    with pytest.raises(main.HTTPException) as exc_info:
        _run(main.batch_demo_summary(main.BatchSummaryBody(ids=[7])))

    assert exc_info.value.status_code == 400
    assert exc_info.value.detail["failed"] == [{
        "id": 7,
        "filename": "broken.dem",
        "reason": "损坏的解析结果",
    }]
