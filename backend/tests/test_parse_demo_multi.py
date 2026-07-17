import asyncio
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from app import demo_parse_isolation, main
from app.env_utils import AppConfig, LLMConfig


def _run_parse_multi(*, players: list[str], filename: str = "match.dem", locale: str = "zh") -> dict:
    request = main.ParseMultiRequest(target_players=players, locale=locale)
    return asyncio.run(main.parse_demo_multi(request, filename))


def test_parse_demo_multi_uses_one_shared_worker(monkeypatch, tmp_path):
    demo_path = tmp_path / "match.dem"
    demo_path.write_bytes(b"demo")
    monkeypatch.setattr(main, "UPLOAD_DIR", tmp_path)
    monkeypatch.setattr(main, "load_config", AppConfig)

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

    assert response == {"players": expected}
    assert calls == [(str(demo_path), ["alpha", "bravo"], None)]


def test_parse_demo_multi_keeps_per_player_ai_review(monkeypatch, tmp_path):
    from app import ai_reviewer

    demo_path = tmp_path / "match.dem"
    demo_path.write_bytes(b"demo")
    monkeypatch.setattr(main, "UPLOAD_DIR", tmp_path)
    monkeypatch.setattr(
        main,
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

    assert sorted(reviewed_players) == [("alpha", "en"), ("bravo", "en")]
    assert response["players"]["alpha"]["clips"] == [{"id": "a", "reviewed": True}]
    assert response["players"]["bravo"]["clips"] == [{"id": "b", "reviewed": True}]
