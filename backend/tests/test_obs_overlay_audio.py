from unittest.mock import MagicMock

from app.recording.executor.obs_client import OBSClient


def test_existing_killfx_source_is_routed_through_obs_audio():
    client = object.__new__(OBSClient)
    client._ws = MagicMock()
    client.get_video_settings = MagicMock(return_value={"base_width": 1920, "base_height": 1080})
    client.scene_has_source = MagicMock(return_value=True)
    client.set_input_settings = MagicMock()

    assert client.ensure_kb_overlay_in_scene(
        "CS2 Insight Game",
        "http://127.0.0.1:8000/overlay/killfx.html",
        source_name="CS2 Kill FX Overlay",
        reroute_audio=True,
    )

    _, settings = client.set_input_settings.call_args.args[:2]
    assert settings["reroute_audio"] is True
    assert settings["restart_when_active"] is False
