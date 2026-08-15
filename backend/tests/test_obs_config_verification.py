"""OBS setup verification must follow the connection settings it validated."""

from __future__ import annotations

import asyncio
import sys
from pathlib import Path

import pytest

_BACKEND_ROOT = Path(__file__).resolve().parents[1]
if str(_BACKEND_ROOT) not in sys.path:
    sys.path.insert(0, str(_BACKEND_ROOT))

from app.api import config as config_api
from app.api import obs as obs_api
from app.env_utils import AppConfig, OBSConfig


def _save_obs_update(
    monkeypatch,
    initial: AppConfig,
    **changes,
) -> AppConfig:
    payload_values = {
        "host": initial.obs.host,
        "port": initial.obs.port,
        "password": "****",
        "obs_path": initial.obs.obs_path,
    }
    payload_values.update(changes)
    saved: list[AppConfig] = []
    monkeypatch.setattr(config_api, "load_config", lambda: initial)
    monkeypatch.setattr(config_api, "save_config", lambda updated: saved.append(updated))

    asyncio.run(
        config_api.update_config(
            config_api.ConfigPayload(obs=OBSConfig(**payload_values)),
        ),
    )

    assert saved
    return saved[-1]


@pytest.mark.parametrize(
    "changes",
    [
        {"obs_path": ""},
        {"obs_path": r"D:\OBS\bin\64bit\obs64.exe"},
        {"host": "192.168.1.20"},
        {"port": 4456},
        {"password": "new-secret"},
    ],
)
def test_changing_verified_obs_connection_settings_revokes_verification(monkeypatch, changes):
    initial = AppConfig(
        obs=OBSConfig(
            host="localhost",
            port=4455,
            password="saved-secret",
            obs_path=r"C:\OBS\bin\64bit\obs64.exe",
            obs_config_verified=True,
        ),
    )

    updated = _save_obs_update(monkeypatch, initial, **changes)

    assert updated.obs.obs_config_verified is False


def test_resaving_same_obs_connection_settings_keeps_verification(monkeypatch):
    initial = AppConfig(
        obs=OBSConfig(
            host="localhost",
            port=4455,
            password="saved-secret",
            obs_path=r"C:\OBS\bin\64bit\obs64.exe",
            obs_config_verified=True,
        ),
    )

    updated = _save_obs_update(monkeypatch, initial)

    assert updated.obs.obs_config_verified is True


def test_auto_detecting_a_different_obs_path_revokes_verification(monkeypatch):
    cfg = AppConfig(
        obs=OBSConfig(
            obs_path=r"C:\OBS\bin\64bit\obs64.exe",
            obs_config_verified=True,
        ),
    )
    saved: list[AppConfig] = []
    monkeypatch.setattr(
        config_api,
        "detect_obs_path",
        lambda: r"D:\OBS\bin\64bit\obs64.exe",
    )
    monkeypatch.setattr(config_api, "load_config", lambda: cfg)
    monkeypatch.setattr(config_api, "save_config", lambda updated: saved.append(updated))

    result = config_api.detect_obs_path_save()

    assert result["obs_path"] == r"D:\OBS\bin\64bit\obs64.exe"
    assert saved[-1].obs.obs_config_verified is False


def test_quick_check_rejects_stale_verification_when_obs_path_is_empty(monkeypatch):
    cfg = AppConfig(
        obs=OBSConfig(
            obs_path="",
            obs_config_verified=True,
        ),
    )
    monkeypatch.setattr(obs_api, "load_config", lambda: cfg)
    monkeypatch.setattr(obs_api, "ensure_cs2_path", lambda value: value)

    result = obs_api.config_quick_check()

    assert result["obs_configured"] is False


def test_quick_check_rejects_stale_verification_when_obs_path_is_missing(monkeypatch, tmp_path):
    cfg = AppConfig(
        obs=OBSConfig(
            obs_path=str(tmp_path / "missing-obs64.exe"),
            obs_config_verified=True,
        ),
    )
    monkeypatch.setattr(obs_api, "load_config", lambda: cfg)
    monkeypatch.setattr(obs_api, "ensure_cs2_path", lambda value: value)

    result = obs_api.config_quick_check()

    assert result["obs_configured"] is False


def test_quick_check_accepts_verified_obs_with_existing_path(monkeypatch, tmp_path):
    obs_path = tmp_path / "obs64.exe"
    obs_path.write_bytes(b"")
    cfg = AppConfig(
        obs=OBSConfig(
            obs_path=str(obs_path),
            obs_config_verified=True,
        ),
    )
    monkeypatch.setattr(obs_api, "load_config", lambda: cfg)
    monkeypatch.setattr(obs_api, "ensure_cs2_path", lambda value: value)

    result = obs_api.config_quick_check()

    assert result["obs_configured"] is True
