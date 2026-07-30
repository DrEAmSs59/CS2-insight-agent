"""PUT /api/config 是逐字段赋值的白名单，漏接的字段会被静默丢弃而不是报错。

锁帧与时序自检两个开关都要走这条路，所以这里守的是"存进去还在"这件事本身。
"""

import asyncio
import sys
from pathlib import Path

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


def test_latency_calibration_survives_the_round_trip(monkeypatch):
    payload = config_api.ConfigPayload(latency_calibration_enabled=True)

    assert _round_trip(monkeypatch, payload).latency_calibration_enabled is True


def test_omitting_latency_calibration_leaves_it_alone(monkeypatch):
    # 别的设置页保存时不带这个字段，不能把诊断开关顺手关掉。
    initial = AppConfig(obs=OBSConfig(), latency_calibration_enabled=True)
    payload = config_api.ConfigPayload(cs2_path="C:/games/cs2.exe")

    assert _round_trip(monkeypatch, payload, initial=initial).latency_calibration_enabled is True


def test_switches_are_exposed_to_the_settings_page(monkeypatch):
    # 设置页靠 GET 回显开关状态；被 model_dump 漏掉就会永远显示成关闭。
    cfg = AppConfig(obs=OBSConfig(browser_begin_frame_scheduling=True), latency_calibration_enabled=True)
    monkeypatch.setattr(config_api, "load_config", lambda: cfg)
    monkeypatch.setattr(config_api, "ensure_cs2_path", lambda value: value)

    data = config_api.get_config()

    assert data["obs"]["browser_begin_frame_scheduling"] is True
    assert data["latency_calibration_enabled"] is True
