"""PUT /api/config 是逐字段赋值的白名单，漏接的字段会被静默丢弃而不是报错。

锁帧与时序自检仍走配置文件 / API（设置页已下线），这里守的是"显式写入还在、
省略不覆盖"两件事。
"""

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


def test_defaults_are_off():
    cfg = AppConfig(obs=OBSConfig())

    assert cfg.obs.browser_begin_frame_scheduling is False
    assert cfg.latency_calibration_enabled is False


def test_begin_frame_scheduling_survives_the_round_trip(monkeypatch):
    payload = config_api.ConfigPayload(obs=OBSConfig(browser_begin_frame_scheduling=True))

    assert _round_trip(monkeypatch, payload).obs.browser_begin_frame_scheduling is True


def test_begin_frame_scheduling_can_be_turned_back_off(monkeypatch):
    initial = AppConfig(obs=OBSConfig(browser_begin_frame_scheduling=True))
    payload = config_api.ConfigPayload(obs=OBSConfig(browser_begin_frame_scheduling=False))

    assert _round_trip(monkeypatch, payload, initial=initial).obs.browser_begin_frame_scheduling is False


def test_omitting_begin_frame_scheduling_from_obs_update_leaves_it_alone(monkeypatch):
    # 设置页保存 OBS 主机/端口时不能把诊断用的锁帧开关顺手关掉。
    initial = AppConfig(obs=OBSConfig(browser_begin_frame_scheduling=True))
    payload = config_api.ConfigPayload(obs=OBSConfig(host="localhost", port=4455, password=""))

    assert _round_trip(monkeypatch, payload, initial=initial).obs.browser_begin_frame_scheduling is True


def test_latency_calibration_survives_the_round_trip(monkeypatch):
    payload = config_api.ConfigPayload(latency_calibration_enabled=True)

    assert _round_trip(monkeypatch, payload).latency_calibration_enabled is True


def test_omitting_latency_calibration_leaves_it_alone(monkeypatch):
    # 别的设置页保存时不带这个字段，不能把诊断开关顺手关掉。
    initial = AppConfig(obs=OBSConfig(), latency_calibration_enabled=True)
    payload = config_api.ConfigPayload(cs2_path="C:/games/cs2.exe")

    assert _round_trip(monkeypatch, payload, initial=initial).latency_calibration_enabled is True


def test_switches_are_exposed_via_get_config(monkeypatch):
    # 调试仍靠 GET / 配置文件读写；被 model_dump 漏掉就无法再打开。
    cfg = AppConfig(obs=OBSConfig(browser_begin_frame_scheduling=True), latency_calibration_enabled=True)
    monkeypatch.setattr(config_api, "load_config", lambda: cfg)
    monkeypatch.setattr(config_api, "ensure_cs2_path", lambda value: value)

    data = config_api.get_config()

    assert data["obs"]["browser_begin_frame_scheduling"] is True
    assert data["latency_calibration_enabled"] is True


def test_recording_skybox_is_independent_and_defaults_to_original():
    cfg = AppConfig(obs=OBSConfig())

    assert cfg.recording_skybox == "default"
    assert cfg.experimental.pov_enabled is False


def test_recording_skybox_survives_the_round_trip(monkeypatch):
    payload = config_api.ConfigPayload(recording_skybox="xuejing")

    assert _round_trip(monkeypatch, payload).recording_skybox == "xuejing"


def test_unknown_recording_skybox_is_rejected(monkeypatch):
    payload = config_api.ConfigPayload(recording_skybox="unknown")

    with pytest.raises(HTTPException) as exc_info:
        _round_trip(monkeypatch, payload)
    assert exc_info.value.status_code == 422


def test_recording_map_material_defaults_to_original():
    cfg = AppConfig(obs=OBSConfig())

    assert cfg.recording_map_material == "default"


def test_recording_map_material_survives_the_round_trip(monkeypatch):
    payload = config_api.ConfigPayload(recording_map_material="waxed_reflection")

    assert _round_trip(monkeypatch, payload).recording_map_material == "waxed_reflection"


def test_unknown_recording_map_material_is_rejected(monkeypatch):
    payload = config_api.ConfigPayload(recording_map_material="chrome")

    with pytest.raises(HTTPException) as exc_info:
        _round_trip(monkeypatch, payload)
    assert exc_info.value.status_code == 422
