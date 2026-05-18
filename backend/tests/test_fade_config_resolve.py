"""Tests for fade config field defaults and Optional merge logic."""
import sys, os
sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))

from app.env_utils import AppConfig
from app.recording.models import RecordingOptions


def test_appconfig_defaults():
    cfg = AppConfig()
    assert cfg.obs_transition_enabled is False
    assert cfg.obs_transition_name == "Fade"
    assert cfg.obs_transition_duration_ms == 200
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


# ---------------------------------------------------------------------------
# _resolve_fade_config merge logic
# ---------------------------------------------------------------------------


def _import_resolve():
    """Import _resolve_fade_config lazily to avoid side-effects at module import time."""
    import app.recording.api as api_mod
    return api_mod._resolve_fade_config


def test_resolve_uses_appconfig_when_options_are_none():
    resolve = _import_resolve()
    cfg = AppConfig(obs_transition_enabled=True, obs_transition_name="Swipe",
                    obs_transition_duration_ms=500)
    opts = RecordingOptions()  # all None
    fc = resolve(opts, cfg)
    assert fc.enabled is True
    assert fc.transition_name == "Swipe"
    assert fc.duration_ms == 500
    assert fc.game_scene_name == "CS2 Insight Recording"
    assert fc.black_scene_name == "CS2 Insight Black"


def test_resolve_options_override_appconfig():
    resolve = _import_resolve()
    cfg = AppConfig(obs_transition_enabled=False, obs_transition_name="Fade",
                    obs_transition_duration_ms=600)
    opts = RecordingOptions(obs_transition_enabled=True,
                            obs_transition_name="Cut",
                            obs_transition_duration_ms=100)
    fc = resolve(opts, cfg)
    assert fc.enabled is True
    assert fc.transition_name == "Cut"
    assert fc.duration_ms == 100


def test_resolve_partial_override():
    resolve = _import_resolve()
    cfg = AppConfig(obs_transition_enabled=True, obs_transition_name="Fade",
                    obs_transition_duration_ms=480)
    opts = RecordingOptions(obs_transition_duration_ms=200)  # only duration overridden
    fc = resolve(opts, cfg)
    assert fc.enabled is True       # from AppConfig
    assert fc.transition_name == "Fade"  # from AppConfig
    assert fc.duration_ms == 200    # from opts
