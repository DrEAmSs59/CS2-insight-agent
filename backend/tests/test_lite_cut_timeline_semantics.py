import json
from pathlib import Path

import pytest

from app.features.lite_cut.project_codec import project_contract_path
from app.features.lite_cut.timeline_math import (
    clip_canvas_fit,
    clip_media_timeline_duration_sec,
    clip_preserve_pitch,
    clip_reverse,
    clip_source_time_for_timeline,
    clip_speed_segments,
    clip_timeline_duration_sec,
    clip_timeline_time_for_source,
)
from app.features.lite_cut import timeline as legacy_timeline


def timeline_semantics_path():
    return Path(__file__).resolve().parents[2] / "data" / "lite_cut_timeline_semantics.json"


@pytest.mark.parametrize("fixture", json.loads(timeline_semantics_path().read_text(encoding="utf-8"))["clip_time_cases"])
def test_shared_clip_time_semantics(fixture):
    clip = fixture["clip"]
    assert [list(segment) for segment in clip_speed_segments(clip)] == fixture["expected_segments"]
    for source, expected in fixture["source_to_timeline"]:
        assert clip_timeline_time_for_source(clip, source) == pytest.approx(expected, abs=1e-6)
    for timeline, expected in fixture["timeline_to_source"]:
        assert clip_source_time_for_timeline(clip, timeline) == pytest.approx(expected, abs=1e-6)
    assert clip_media_timeline_duration_sec(clip) == pytest.approx(fixture["media_timeline_duration"], abs=1e-6)
    assert clip_timeline_duration_sec(clip) == pytest.approx(fixture["timeline_duration"], abs=1e-6)
    assert clip_reverse(clip) is fixture["reverse"]
    assert clip_preserve_pitch(clip) is fixture["preserve_pitch"]
    assert clip_canvas_fit(clip) == fixture["canvas_fit"]

    assert legacy_timeline._clip_speed_segments(clip) == clip_speed_segments(clip)
    assert legacy_timeline._clip_timeline_duration_sec(clip) == pytest.approx(clip_timeline_duration_sec(clip), abs=1e-6)
