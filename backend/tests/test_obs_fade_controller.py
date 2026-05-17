"""Unit tests for OBSFadeController."""
import asyncio
import sys, os
sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))

from unittest.mock import MagicMock, patch, call
import pytest

from app.recording.executor.obs_fade_controller import OBSFadeController, FadeConfig
from app.env_utils import OBSConfig


def _make_config(enabled=True, name="Fade", duration_ms=350,
                 game="CS2 Insight Recording", black="CS2 Insight Black"):
    return FadeConfig(
        enabled=enabled,
        transition_name=name,
        duration_ms=duration_ms,
        game_scene_name=game,
        black_scene_name=black,
    )


def _make_obs_config():
    return OBSConfig(host="localhost", port=4455, password="")


def _run(coro):
    return asyncio.get_event_loop().run_until_complete(coro)


# ---------------------------------------------------------------------------
# setup()
# ---------------------------------------------------------------------------

def test_setup_disabled_returns_false():
    cfg = _make_config(enabled=False)
    ctrl = OBSFadeController(_make_obs_config(), cfg)
    result = _run(ctrl.setup())
    assert result is False
    assert ctrl.is_ready is False


def test_setup_creates_scenes_when_missing():
    cfg = _make_config()
    ctrl = OBSFadeController(_make_obs_config(), cfg)

    mock_client = MagicMock()
    mock_client.get_scene_names.return_value = []          # no scenes exist
    mock_client.get_scene_transition_list.return_value = ["Fade", "Cut"]
    mock_client.scene_has_source.return_value = False

    with patch.object(ctrl, "_new_client", return_value=mock_client):
        result = _run(ctrl.setup())

    assert result is True
    assert ctrl.is_ready is True
    # Both scenes must have been created
    create_calls = [c.args[0] for c in mock_client.create_scene.call_args_list]
    assert "CS2 Insight Recording" in create_calls
    assert "CS2 Insight Black" in create_calls


def test_setup_skips_create_for_existing_scenes():
    cfg = _make_config()
    ctrl = OBSFadeController(_make_obs_config(), cfg)

    mock_client = MagicMock()
    mock_client.get_scene_names.return_value = ["CS2 Insight Recording", "CS2 Insight Black"]
    mock_client.get_scene_transition_list.return_value = ["Fade"]
    mock_client.scene_has_source.return_value = True  # game capture already in scene

    with patch.object(ctrl, "_new_client", return_value=mock_client):
        result = _run(ctrl.setup())

    assert result is True
    mock_client.create_scene.assert_not_called()


def test_setup_fallback_on_exception():
    cfg = _make_config()
    ctrl = OBSFadeController(_make_obs_config(), cfg)

    mock_client = MagicMock()
    mock_client.get_scene_names.side_effect = RuntimeError("OBS unavailable")

    with patch.object(ctrl, "_new_client", return_value=mock_client):
        result = _run(ctrl.setup())

    assert result is False
    assert ctrl.is_ready is False


# ---------------------------------------------------------------------------
# fade_to_black() / fade_to_game()
# ---------------------------------------------------------------------------

def test_fade_to_black_not_ready_returns_true():
    cfg = _make_config()
    ctrl = OBSFadeController(_make_obs_config(), cfg)
    # is_ready is False by default (setup not called)
    result = _run(ctrl.fade_to_black())
    assert result is True  # no-op, not an error


def test_fade_to_game_not_ready_returns_true():
    cfg = _make_config()
    ctrl = OBSFadeController(_make_obs_config(), cfg)
    result = _run(ctrl.fade_to_game())
    assert result is True


def test_fade_to_black_calls_obs_and_sleeps():
    cfg = _make_config(duration_ms=100)
    ctrl = OBSFadeController(_make_obs_config(), cfg)
    ctrl._ready = True  # bypass setup

    mock_client = MagicMock()

    async def run():
        with patch.object(ctrl, "_new_client", return_value=mock_client):
            with patch("asyncio.sleep") as mock_sleep:
                result = await ctrl.fade_to_black()
                mock_sleep.assert_called_once_with(0.1)
        return result

    result = _run(run())
    assert result is True
    mock_client.set_current_scene_transition.assert_called_once_with("Fade", 100)
    mock_client.set_current_program_scene.assert_called_once_with("CS2 Insight Black")


def test_fade_to_game_targets_game_scene():
    cfg = _make_config(duration_ms=200, game="MyGame")
    ctrl = OBSFadeController(_make_obs_config(), cfg)
    ctrl._ready = True

    mock_client = MagicMock()

    async def run():
        with patch.object(ctrl, "_new_client", return_value=mock_client):
            with patch("asyncio.sleep"):
                return await ctrl.fade_to_game()

    result = _run(run())
    assert result is True
    mock_client.set_current_program_scene.assert_called_once_with("MyGame")


def test_fade_to_black_returns_false_on_exception():
    cfg = _make_config()
    ctrl = OBSFadeController(_make_obs_config(), cfg)
    ctrl._ready = True

    mock_client = MagicMock()
    mock_client.set_current_scene_transition.side_effect = RuntimeError("OBS error")

    async def run():
        with patch.object(ctrl, "_new_client", return_value=mock_client):
            return await ctrl.fade_to_black()

    result = _run(run())
    assert result is False  # fallback, not exception
