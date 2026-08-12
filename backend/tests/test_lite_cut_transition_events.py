from __future__ import annotations

from app.features.lite_cut.project_codec import serialize_project_body
from app.features.lite_cut.transition_events import (
    normalized_transition_project,
    project_events_to_render_nodes,
    resolve_transition_event,
)


def _body() -> dict:
    return {
        "schema_version": 3,
        "tracks": [
            {"id": "v2", "type": "video", "label": "V2", "clips": [{"id": "b", "timeline_start": 4, "trim_in": 0, "trim_out": 6}]},
            {"id": "v1", "type": "video", "label": "V1", "clips": [{"id": "a", "timeline_start": 0, "trim_in": 0, "trim_out": 4}]},
        ],
        "overlays": [],
        "transitions": [{
            "id": "edge-a-b",
            "type": "fade",
            "duration_sec": 2,
            "easing": "linear",
            "from": {"kind": "clip", "track_id": "v1", "id": "a"},
            "to": {"kind": "clip", "track_id": "v2", "id": "b"},
        }],
    }


def test_cross_track_boundary_is_centered_on_the_cut() -> None:
    body = _body()
    event = resolve_transition_event(body, body["transitions"][0])
    assert event is not None
    assert event["mode"] == "boundary"
    assert event["cut_sec"] == 4
    assert event["start_sec"] == 3
    assert event["end_sec"] == 5
    projected = project_events_to_render_nodes(body)
    assert projected["tracks"][0]["clips"][0]["_transition_events"][0]["stack"] == "upper"
    assert projected["tracks"][1]["clips"][0]["_transition_events"][0]["stack"] == "lower"


def test_serialization_uses_from_alias_for_canonical_events() -> None:
    body = _body()
    serialized = serialize_project_body(body)
    assert serialized["transitions"][0]["from"]["id"] == "a"
    assert "from_" not in serialized["transitions"][0]


def test_detached_transition_is_removed_from_runtime_project() -> None:
    body = _body()
    body["tracks"][0]["clips"][0]["timeline_start"] = 5
    normalized = normalized_transition_project(body)
    assert normalized["transitions"] == []


def test_runtime_project_persists_the_effective_duration() -> None:
    body = _body()
    body["transitions"] = [{
        "id": "a-enter",
        "type": "fade",
        "duration_sec": 10,
        "from": None,
        "to": {"kind": "clip", "track_id": "v1", "id": "a"},
    }]
    normalized = normalized_transition_project(body)
    assert normalized["transitions"][0]["duration_sec"] == 4


def test_runtime_project_keeps_one_owner_per_material_edge() -> None:
    body = _body()
    body["transitions"].extend([
        {
            "id": "duplicate-out",
            "type": "flash",
            "duration_sec": 1,
            "from": {"kind": "clip", "track_id": "v1", "id": "a"},
            "to": None,
        },
        {
            "id": "duplicate-in",
            "type": "zoom",
            "duration_sec": 1,
            "from": None,
            "to": {"kind": "clip", "track_id": "v2", "id": "b"},
        },
    ])
    normalized = normalized_transition_project(body)
    assert [event["id"] for event in normalized["transitions"]] == ["edge-a-b"]
