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


def test_analyze_batch_defers_replay_parquet(monkeypatch):
    from app import parse_worker

    class _FakeResult:
        def to_dict(self):
            return {"clips": [{"id": "a"}]}

    class _FakeAnalyzer:
        has_player_keyboard_input = None
        analysis_workspace = {"rounds": [{"round_number": 1, "start_tick": 1, "end_tick": 64}]}

        def __init__(self, _path):
            pass

        def analyze_multi_players(self, _players, freeze_to_death_rounds=None):
            return {"alpha": _FakeResult()}

    monkeypatch.setattr(parse_worker, "DemoAnalyzer", _FakeAnalyzer)

    def fail_materialize(**_kwargs):
        raise AssertionError("analyze_batch must not materialize replay parquet")

    monkeypatch.setattr(
        "app.features.demo_analysis.replay_match_cache.materialize_match_replay_parquet_impl",
        fail_materialize,
    )

    result = parse_worker._run(
        {
            "action": "analyze_batch",
            "dem_path": "match.dem",
            "target_players": ["alpha"],
        }
    )

    assert result["alpha"] == {"clips": [{"id": "a"}]}
    assert result["__has_player_keyboard_input__"] is None
    assert result["__analysis_workspace__"]["replay_cache"] == {
        "status": "deferred",
        "reason": "materialized on first 2D replay open",
    }
