import asyncio
from types import SimpleNamespace
from unittest.mock import AsyncMock, Mock

import pytest
from fastapi import HTTPException

from app import cs2_config_backup, obs_director
from app.env_utils import AppConfig
from app.recording import api


@pytest.fixture
def queue_api(monkeypatch, tmp_path):
    cfg = AppConfig(
        cs2_path=str(tmp_path / "never-launch.exe"),
        recording_skybox="cartoon3", recording_map_material="waxed_reflection",
    )
    monkeypatch.setattr(api, "load_config", lambda: cfg)
    monkeypatch.setattr(api, "ensure_cs2_path", lambda value: value)
    monkeypatch.setattr(cs2_config_backup, "is_cs2_running", lambda: False)
    monkeypatch.setattr(cs2_config_backup, "is_restore_required", lambda: False)
    monkeypatch.setattr(api, "OBSClient", Mock(return_value=Mock()))
    monkeypatch.setattr(api, "OBSFadeController", Mock(return_value=Mock(setup=AsyncMock(return_value=True))))
    monkeypatch.setattr(api, "resolve_working_demo_path", AsyncMock(side_effect=HTTPException(404, "test demo")))
    monkeypatch.setattr(api, "prepare_recording_aliases", lambda requests, _: requests)
    monkeypatch.setattr(api, "_persist_v3_results", AsyncMock())
    monkeypatch.setattr(api, "_queue_abort_event", None)
    captured = []

    async def execute(_requests, **kwargs):
        captured.append(kwargs["warmup"])
        return []

    monkeypatch.setattr(obs_director, "OBSDirector", Mock(return_value=Mock(execute_plan_queue=execute)))
    dto = SimpleNamespace(
        request_id="vpk-options",
        demo=SimpleNamespace(demo_path=str(tmp_path / "missing.dem"), demo_filename="missing.dem"),
        options=api.RecordingOptions(), player_aliases={},
    )

    def submit(**kwargs):
        body = api.QueueRecordingRequest.model_construct(requests=[dto], **kwargs)
        asyncio.run(api.execute_recording_queue(body))
        return captured[-1]

    return submit


@pytest.mark.parametrize("pov", [False, True])
@pytest.mark.parametrize("voice", ["mute", "team", "enemy", "all"])
@pytest.mark.parametrize("keyboard", [False, True])
@pytest.mark.parametrize("appearance", ["default", "waxed_reflection", "rain"])
def test_explicit_session_options_override_saved_and_warmup_values(queue_api, pov, voice, keyboard, appearance):
    material = "waxed_reflection" if appearance == "waxed_reflection" else "default"
    weather = "rain" if appearance == "rain" else "default"
    warmup = queue_api(
        # Stale/older warmup fields must not override an explicit current switch.
        warmup={"skybox_id": "chroma_blue", "map_material_id": "waxed_reflection", "weather_effect_id": "rain"},
        pov_hud={"enabled": pov, "voice_mode": voice, "input_hud_enabled": keyboard},
        skybox={"id": "default"}, map_material={"id": material}, weather={"id": weather},
    )
    assert warmup.pov_hud_enabled is pov
    assert warmup.recording_hud_enabled is (pov or voice != "mute" or keyboard)
    assert warmup.pov_voice_mode == voice
    assert warmup.input_hud_enabled is keyboard
    assert warmup.skybox_id == "default"
    assert warmup.map_material_id == material
    assert warmup.weather_effect_id == weather


def test_rain_keeps_explicit_skybox_and_rejects_waxed_overlap(queue_api):
    warmup = queue_api(
        pov_hud={"enabled": False, "voice_mode": "mute", "input_hud_enabled": False},
        skybox={"id": "cartoon4"}, map_material={"id": "default"}, weather={"id": "rain"},
    )
    assert warmup.skybox_id == "cartoon4"
    assert not warmup.recording_hud_enabled
    with pytest.raises(HTTPException) as exc:
        queue_api(map_material={"id": "waxed_reflection"}, weather={"id": "rain"})
    assert exc.value.status_code == 422


def test_omitted_effect_fields_use_saved_preset(queue_api):
    warmup = queue_api()
    assert warmup.skybox_id == "cartoon3"
    assert warmup.map_material_id == "waxed_reflection"
    assert warmup.weather_effect_id == "default"
