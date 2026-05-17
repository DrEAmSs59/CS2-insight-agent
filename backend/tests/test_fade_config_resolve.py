"""Tests for fade config field defaults and Optional merge logic."""
import sys, os
sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))

from app.env_utils import AppConfig
from app.recording.models import RecordingOptions


def test_appconfig_defaults():
    cfg = AppConfig()
    assert cfg.obs_transition_enabled is False
    assert cfg.obs_transition_name == "Fade"
    assert cfg.obs_transition_duration_ms == 350
    assert cfg.obs_game_scene_name == "CS2 Insight Recording"
    assert cfg.obs_black_scene_name == "CS2 Insight Black"


def test_recording_options_defaults():
    opts = RecordingOptions()
    assert opts.obs_transition_enabled is None
    assert opts.obs_transition_name is None
    assert opts.obs_transition_duration_ms is None


def test_appconfig_custom():
    cfg = AppConfig(
        obs_transition_enabled=True,
        obs_transition_name="Swipe",
        obs_transition_duration_ms=500,
        obs_game_scene_name="MyGame",
        obs_black_scene_name="MyBlack",
    )
    assert cfg.obs_transition_enabled is True
    assert cfg.obs_transition_name == "Swipe"
    assert cfg.obs_transition_duration_ms == 500
    assert cfg.obs_game_scene_name == "MyGame"
    assert cfg.obs_black_scene_name == "MyBlack"


def test_recording_options_override():
    opts = RecordingOptions(
        obs_transition_enabled=True,
        obs_transition_name="Cut",
        obs_transition_duration_ms=200,
    )
    assert opts.obs_transition_enabled is True
    assert opts.obs_transition_name == "Cut"
    assert opts.obs_transition_duration_ms == 200
