"""The montage export directory is a persisted application preference."""

import asyncio
import sys
from pathlib import Path

_BACKEND_ROOT = Path(__file__).resolve().parents[1]
if str(_BACKEND_ROOT) not in sys.path:
    sys.path.insert(0, str(_BACKEND_ROOT))

from app.api import config as config_api
from app.env_utils import AppConfig


def test_montage_export_dir_round_trip(monkeypatch):
    cfg = AppConfig()
    saved: list[AppConfig] = []
    monkeypatch.setattr(config_api, "load_config", lambda: cfg)
    monkeypatch.setattr(config_api, "save_config", lambda updated: saved.append(updated))

    asyncio.run(
        config_api.update_config(
            config_api.ConfigPayload(montage_export_dir=r"I:\exports\montage"),
        ),
    )

    assert saved[-1].montage_export_dir == r"I:\exports\montage"


def test_montage_export_dir_can_return_to_automatic_mode(monkeypatch):
    cfg = AppConfig(montage_export_dir=r"I:\exports\montage")
    saved: list[AppConfig] = []
    monkeypatch.setattr(config_api, "load_config", lambda: cfg)
    monkeypatch.setattr(config_api, "save_config", lambda updated: saved.append(updated))

    asyncio.run(config_api.update_config(config_api.ConfigPayload(montage_export_dir="")))

    assert saved[-1].montage_export_dir == ""
