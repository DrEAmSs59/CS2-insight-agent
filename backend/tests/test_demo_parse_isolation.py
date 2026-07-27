import pytest

from app import demo_parse_isolation


def test_metadata_inspection_has_a_shorter_deadline(monkeypatch):
    monkeypatch.delenv("CS2_INSIGHT_DEMO_INSPECT_TIMEOUT_SEC", raising=False)
    monkeypatch.delenv("CS2_INSIGHT_PARSE_WORKER_TIMEOUT_SEC", raising=False)

    assert demo_parse_isolation._timeout_seconds("inspect") == 30.0
    assert demo_parse_isolation._timeout_seconds("analyze_batch") == 240.0


def test_worker_deadlines_remain_developer_overridable(monkeypatch):
    monkeypatch.setenv("CS2_INSIGHT_DEMO_INSPECT_TIMEOUT_SEC", "18")
    monkeypatch.setenv("CS2_INSIGHT_PARSE_WORKER_TIMEOUT_SEC", "90")

    assert demo_parse_isolation._timeout_seconds("players") == 18.0
    assert demo_parse_isolation._timeout_seconds("analyze") == 90.0


def test_multi_player_worker_rejects_malformed_success(monkeypatch):
    monkeypatch.setattr(demo_parse_isolation, "run_parse_worker", lambda *_args, **_kwargs: [])

    with pytest.raises(demo_parse_isolation.IsolatedParseError):
        demo_parse_isolation.analyze_multi_isolated("match.dem", ["alpha"])
