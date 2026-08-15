import asyncio
import sys
from pathlib import Path

import pytest

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from app import demo_parse_isolation
from app.env_utils import AppConfig, LLMConfig
from app.features.demo_analysis import api as demo_analysis_api
from app.features.demo_analysis import inspection


@pytest.fixture(autouse=True)
def bypass_demo_library_lookup(monkeypatch):
    """Keep direct-path API tests independent from the library database."""

    async def not_in_library(_path):
        return None

    monkeypatch.setattr(demo_analysis_api.demo_db, "get_demo_by_path", not_in_library)
    monkeypatch.setattr(demo_analysis_api.demo_db, "get_demo_by_cached_path", not_in_library)


def _run_parse_multi(*, players: list[str], filename: str = "match.dem", locale: str = "zh") -> dict:
    request = demo_analysis_api.ParseMultiRequest(target_players=players, locale=locale)
    return asyncio.run(demo_analysis_api.parse_demo_multi(request, filename))


def test_parse_demo_multi_uses_one_shared_worker(monkeypatch, tmp_path):
    demo_path = tmp_path / "match.dem"
    demo_path.write_bytes(b"demo")
    monkeypatch.setattr(inspection, "UPLOAD_DIR", tmp_path)
    monkeypatch.setattr(demo_analysis_api, "load_config", AppConfig)

    calls: list[tuple[str, list[str], list[int] | None]] = []
    expected = {
        "alpha": {"clips": [{"id": "a"}], "match_meta": {"map_name": "de_nuke"}},
        "bravo": {"clips": [{"id": "b"}], "match_meta": {"map_name": "de_nuke"}},
    }

    def fake_analyze_multi(dem_path, target_players, freeze_to_death_rounds):
        calls.append((dem_path, target_players, freeze_to_death_rounds))
        return expected

    monkeypatch.setattr(demo_parse_isolation, "analyze_multi_isolated", fake_analyze_multi)

    response = _run_parse_multi(players=["alpha", "bravo"])

    assert response == {
        "players": expected,
        "analysis_workspace": None,
        "has_player_keyboard_input": None,
    }
    assert calls == [(str(demo_path), ["alpha", "bravo"], None)]


def test_parse_demo_multi_defers_ai_review_until_player_is_selected(monkeypatch, tmp_path):
    from app import ai_reviewer

    demo_path = tmp_path / "match.dem"
    demo_path.write_bytes(b"demo")
    monkeypatch.setattr(inspection, "UPLOAD_DIR", tmp_path)
    monkeypatch.setattr(
        demo_analysis_api,
        "load_config",
        lambda: AppConfig(ai_mode=True, llm=LLMConfig(api_key="test-key")),
    )

    parsed = {
        "alpha": {"clips": [{"id": "a"}], "match_meta": {"target_player": "alpha"}},
        "bravo": {"clips": [{"id": "b"}], "match_meta": {"target_player": "bravo"}},
    }
    monkeypatch.setattr(demo_parse_isolation, "analyze_multi_isolated", lambda *_args: parsed)

    reviewed_players: list[tuple[str, str]] = []

    async def fake_enrich(clips, match_meta, _llm, *, locale):
        reviewed_players.append((match_meta["target_player"], locale))
        return [dict(clip, reviewed=True) for clip in clips]

    monkeypatch.setattr(ai_reviewer, "enrich_clips_dicts_with_reviewer", fake_enrich)

    response = _run_parse_multi(players=["alpha", "bravo"], locale="en")

    assert reviewed_players == []
    assert response["players"]["alpha"]["clips"] == [{"id": "a"}]
    assert response["players"]["bravo"]["clips"] == [{"id": "b"}]

    request = demo_analysis_api.PlayerClipReviewRequest(
        clips=response["players"]["alpha"]["clips"],
        match_meta=response["players"]["alpha"]["match_meta"],
        locale="en",
    )
    reviewed = asyncio.run(demo_analysis_api.review_demo_player_clips(request))

    assert reviewed_players == [("alpha", "en")]
    assert reviewed == {"clips": [{"id": "a", "reviewed": True}], "reviewed": True}


def test_parse_demo_multi_extracts_shared_analysis_workspace(monkeypatch, tmp_path):
    demo_path = tmp_path / "match.dem"
    demo_path.write_bytes(b"demo")
    monkeypatch.setattr(inspection, "UPLOAD_DIR", tmp_path)
    monkeypatch.setattr(demo_analysis_api, "load_config", AppConfig)
    workspace = {"version": 1, "map_name": "de_mirage", "players": [], "rounds": []}
    parsed = {
        "__analysis_workspace__": workspace,
        "__has_player_keyboard_input__": False,
        "alpha": {"clips": [], "match_meta": {"target_player": "alpha"}},
    }
    monkeypatch.setattr(demo_parse_isolation, "analyze_multi_isolated", lambda *_args: parsed)

    response = _run_parse_multi(players=["alpha"])

    assert response["analysis_workspace"] == workspace
    assert response["has_player_keyboard_input"] is False
    assert "__analysis_workspace__" not in response["players"]
    assert "__has_player_keyboard_input__" not in response["players"]


def test_parse_demo_multi_returns_stable_timeout_code(monkeypatch, tmp_path):
    demo_path = tmp_path / "match.dem"
    demo_path.write_bytes(b"demo")
    monkeypatch.setattr(inspection, "UPLOAD_DIR", tmp_path)

    def fake_analyze_multi(*_args):
        raise demo_parse_isolation.IsolatedParseError(
            "解析超时，worker stderr contains implementation details"
        )

    monkeypatch.setattr(demo_parse_isolation, "analyze_multi_isolated", fake_analyze_multi)

    with pytest.raises(demo_analysis_api.HTTPException) as exc_info:
        _run_parse_multi(players=["alpha"])

    assert exc_info.value.status_code == 500
    assert exc_info.value.detail == {"code": "DEMO_ANALYSIS_TIMEOUT"}


def test_parse_demo_multi_returns_stable_missing_file_code(monkeypatch, tmp_path):
    monkeypatch.setattr(inspection, "UPLOAD_DIR", tmp_path)

    with pytest.raises(demo_analysis_api.HTTPException) as exc_info:
        _run_parse_multi(players=["alpha"], filename="missing.dem")

    assert exc_info.value.status_code == 404
    assert exc_info.value.detail == {"code": "DEMO_FILE_NOT_FOUND"}


def test_parse_demo_multi_rejects_empty_success(monkeypatch, tmp_path):
    demo_path = tmp_path / "match.dem"
    demo_path.write_bytes(b"demo")
    monkeypatch.setattr(inspection, "UPLOAD_DIR", tmp_path)
    monkeypatch.setattr(demo_parse_isolation, "analyze_multi_isolated", lambda *_args: {})

    with pytest.raises(demo_analysis_api.HTTPException) as exc_info:
        _run_parse_multi(players=["alpha"])

    assert exc_info.value.status_code == 500
    assert exc_info.value.detail == {"code": "DEMO_ANALYSIS_EMPTY"}
