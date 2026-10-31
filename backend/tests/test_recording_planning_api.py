"""Recording planning stays rule-based, including requests saved by older clients."""
import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient

from app.recording.api import router
from app.recording.models import RecordingRequestDTO
from app.recording.plan_builder import build_plan


@pytest.fixture
def client():
    app = FastAPI()
    app.include_router(router)
    with TestClient(app) as client:
        yield client


def _request(tmp_path, request_type, interleaved):
    player = {"name": "player", "steamid64": "1", "spec_slot": 1}
    victim = {"name": "opponent", "steamid64": "2", "spec_slot": 2}
    return {
        "request_id": "manual-plan",
        "request_type": request_type,
        "source_type": "kill",
        "demo": {
            "demo_path": str(tmp_path / "missing.dem"),
            "demo_filename": "missing.dem",
            "map_name": "de_mirage",
            "tick_rate": 64,
            "first_tick": 0,
            "demo_end_tick": 50000,
            "final_round": 10,
            "final_round_start_tick": 0,
            "final_round_end_tick": 0,
        },
        "target_player": player,
        "events": [
            {"event_type": "kill", "tick": tick, "round": 5,
             "killer": player, "victim": victim, "target_player": player,
             "perspective": "killer"}
            for tick in (10000, 10400, 18000)
        ],
        "options": {"enable_victim_pov": True, "interleave_pov_pairs": interleaved},
    }


def test_removed_preview_endpoint_is_not_registered_or_advertised(client):
    assert client.post("/api/recording/ai-director/preview", json={}).status_code == 404
    schema = client.get("/openapi.json").json()
    assert "/api/recording/ai-director/preview" not in schema["paths"]
    assert "use_ai_director" not in schema["components"]["schemas"]["RecordingOptions"]["properties"]


@pytest.mark.parametrize("request_type", ["highlight", "kill_compilation"])
@pytest.mark.parametrize("interleaved", [False, True])
def test_legacy_ai_option_does_not_change_manual_preview_or_execution(client, tmp_path, request_type, interleaved):
    payload = _request(tmp_path, request_type, interleaved)
    expected = client.post("/api/recording/plan", json=payload)
    assert expected.status_code == 200
    payload["options"]["use_ai_director"] = True
    preview = client.post("/api/recording/plan", json=payload)
    assert preview.status_code == 200
    assert preview.json() == expected.json()

    dto = RecordingRequestDTO.model_validate(payload)
    assert "use_ai_director" not in dto.options.model_dump()
    plan = build_plan(dto)
    assert [(s["start_tick"], s["end_tick"], s["perspective"]) for s in preview.json()["active_segments"]] == [
        (s.start_tick, s.end_tick, s.perspective.value) for s in plan.segments
    ]
    perspectives = [s.perspective.value for s in plan.segments]
    if interleaved:
        assert perspectives == ["killer", "victim"] * 3
    else:
        assert perspectives == ["killer"] * 2 + ["victim"] * 3
