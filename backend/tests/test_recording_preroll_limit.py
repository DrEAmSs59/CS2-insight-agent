import pytest
from pydantic import ValidationError

from app.env_utils import AppConfig
from app.recording.models import RecordingOptions

PRE_FIELDS = ["highlight_pre_sec", "timeline_kill_pre_sec", "death_pre_sec",
              "kill_compilation_pre_sec", "death_compilation_pre_sec"]


@pytest.mark.parametrize("field", PRE_FIELDS)
@pytest.mark.parametrize("value, expected", [(0, 0), (2, 2), (10, 10), (20, 10), (60, 10), ("20", 10)])
def test_legacy_request_padding_is_capped_without_rejecting_saved_settings(field, value, expected):
    options = RecordingOptions.model_validate({field: value})
    assert getattr(options, field) == expected
    assert options.kill_compilation_post_sec == 1.5
    assert options.kill_compilation_jump_cut_threshold_sec == 10


@pytest.mark.parametrize("field", PRE_FIELDS)
@pytest.mark.parametrize("value", [-1, float("nan"), float("inf"), "invalid"])
def test_invalid_padding_is_still_rejected(field, value):
    with pytest.raises(ValidationError):
        RecordingOptions.model_validate({field: value})


def test_saved_config_is_limited_without_changing_other_pacing_fields():
    original = {"pre_first_sec": 20, "post_last_sec": 10, "max_gap_sec": 2, "default_victim_pov": True}
    cfg = AppConfig.model_validate({"recording_global_pacing": original})
    assert cfg.recording_global_pacing == {**original, "pre_first_sec": 10}
    assert original["pre_first_sec"] == 20
    assert AppConfig().recording_global_pacing == {}


def test_event_defaults_and_round_timing_are_unchanged():
    options = RecordingOptions()
    assert [getattr(options, field) for field in PRE_FIELDS] == [3, 3, 3, 2, 2]
    assert options.round_freeze_preroll_sec == 3
