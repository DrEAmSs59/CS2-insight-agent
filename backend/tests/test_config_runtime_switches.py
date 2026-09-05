"""PUT /api/config 的录制选项回归测试。"""

import asyncio
import sys
from pathlib import Path

import pytest
from fastapi import HTTPException

_BACKEND_ROOT = Path(__file__).resolve().parents[1]
if str(_BACKEND_ROOT) not in sys.path:
    sys.path.insert(0, str(_BACKEND_ROOT))

from app.api import config as config_api
from app.env_utils import AppConfig, OBSConfig


def _round_trip(monkeypatch, payload: config_api.ConfigPayload, *, initial: AppConfig | None = None) -> AppConfig:
    cfg = initial or AppConfig(obs=OBSConfig())
    saved: list[AppConfig] = []
    monkeypatch.setattr(config_api, "load_config", lambda: cfg)
    monkeypatch.setattr(config_api, "save_config", lambda updated: saved.append(updated))
    asyncio.run(config_api.update_config(payload))
    assert saved, "update_config 必须落盘"
    return saved[-1]


def test_recording_skybox_is_independent_and_defaults_to_original():
    cfg = AppConfig(obs=OBSConfig())

    assert cfg.recording_skybox == "default"
    assert cfg.experimental.pov_enabled is False


def test_recording_skybox_survives_the_round_trip(monkeypatch):
    payload = config_api.ConfigPayload(recording_skybox="cartoon3")

    assert _round_trip(monkeypatch, payload).recording_skybox == "cartoon3"


def test_unknown_recording_skybox_is_rejected(monkeypatch):
    payload = config_api.ConfigPayload(recording_skybox="unknown")

    with pytest.raises(HTTPException) as exc_info:
        _round_trip(monkeypatch, payload)
    assert exc_info.value.status_code == 422


def test_recording_map_material_defaults_to_original():
    cfg = AppConfig(obs=OBSConfig())

    assert cfg.recording_map_material == "default"
    assert cfg.recording_weather_effect == "default"


def test_recording_map_material_survives_the_round_trip(monkeypatch):
    payload = config_api.ConfigPayload(recording_map_material="waxed_reflection")

    assert _round_trip(monkeypatch, payload).recording_map_material == "waxed_reflection"


def test_unknown_recording_map_material_is_rejected(monkeypatch):
    payload = config_api.ConfigPayload(recording_map_material="chrome")

    with pytest.raises(HTTPException) as exc_info:
        _round_trip(monkeypatch, payload)
    assert exc_info.value.status_code == 422


def test_recording_weather_effect_survives_the_round_trip(monkeypatch):
    payload = config_api.ConfigPayload(recording_weather_effect="rain")

    assert _round_trip(monkeypatch, payload).recording_weather_effect == "rain"


def test_recording_weather_effect_conflicts_with_waxed_material(monkeypatch):
    payload = config_api.ConfigPayload(
        recording_map_material="waxed_reflection",
        recording_weather_effect="rain",
    )

    with pytest.raises(HTTPException) as exc_info:
        _round_trip(monkeypatch, payload)
    assert exc_info.value.status_code == 422
