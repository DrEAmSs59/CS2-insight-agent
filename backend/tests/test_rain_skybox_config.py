import asyncio

from app.api import config as config_api
from app.env_utils import AppConfig, OBSConfig


def test_rain_weather_preserves_an_explicit_skybox_override(monkeypatch):
    cfg = AppConfig(obs=OBSConfig())
    saved: list[AppConfig] = []
    monkeypatch.setattr(config_api, "load_config", lambda: cfg)
    monkeypatch.setattr(config_api, "save_config", lambda updated: saved.append(updated))

    payload = config_api.ConfigPayload(
        recording_skybox="cartoon3",
        recording_map_material="default",
        recording_weather_effect="rain",
    )
    asyncio.run(config_api.update_config(payload))

    assert saved
    assert saved[-1].recording_map_material == "default"
    assert saved[-1].recording_weather_effect == "rain"
    assert saved[-1].recording_skybox == "cartoon3"
