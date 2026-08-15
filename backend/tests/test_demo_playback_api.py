import asyncio
import sys
from pathlib import Path
from types import SimpleNamespace

import pytest
from fastapi import HTTPException

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from app.features.demo_playback import api as playback_api


def _configured_cs2(tmp_path: Path):
    cs2 = tmp_path / "game" / "bin" / "win64" / "cs2.exe"
    cs2.parent.mkdir(parents=True)
    cs2.write_bytes(b"exe")
    return SimpleNamespace(cs2_path=str(cs2))


def test_launch_maps_running_process_to_stable_409(monkeypatch, tmp_path: Path):
    cfg = _configured_cs2(tmp_path)
    demo = tmp_path / "match.dem"
    demo.write_bytes(b"demo")
    monkeypatch.setattr(playback_api, "load_config", lambda: cfg)
    monkeypatch.setattr(playback_api, "ensure_cs2_path", lambda value: value)
    monkeypatch.setattr(
        playback_api.demo_playback_service,
        "launch",
        lambda *_args, **_kwargs: (_ for _ in ()).throw(playback_api.DemoPlaybackCs2RunningError()),
    )

    with pytest.raises(HTTPException) as exc_info:
        playback_api.launch_cs2_play_demo(demo, playback_api.DemoPlaybackOptionsBody())

    assert exc_info.value.status_code == 409
    assert exc_info.value.detail == {"code": "DEMO_PLAYBACK_CS2_RUNNING"}


def test_launch_forwards_pov_session_options(monkeypatch, tmp_path: Path):
    cfg = _configured_cs2(tmp_path)
    demo = tmp_path / "match.dem"
    demo.write_bytes(b"demo")
    captured = {}
    monkeypatch.setattr(playback_api, "load_config", lambda: cfg)
    monkeypatch.setattr(playback_api, "ensure_cs2_path", lambda value: value)

    def fake_launch(path, config, options):
        captured.update(path=path, config=config, options=options)
        return {"ok": True, "pov_hud_enabled": options.enabled}

    monkeypatch.setattr(playback_api.demo_playback_service, "launch", fake_launch)
    body = playback_api.DemoPlaybackOptionsBody(
        pov_hud=playback_api.DemoPlaybackPovBody(enabled=True, radar_mode=-1, teamcounter_numeric=True),
    )

    result = playback_api.launch_cs2_play_demo(demo, body)

    assert result == {"ok": True, "pov_hud_enabled": True}
    assert captured["path"] == demo
    assert captured["config"] is cfg
    assert captured["options"] == playback_api.DemoPlaybackPovOptions(
        enabled=True,
        radar_mode=-1,
        teamcounter_numeric=True,
    )


def test_preflight_delegates_to_playback_service(monkeypatch, tmp_path: Path):
    cfg = _configured_cs2(tmp_path)
    monkeypatch.setattr(playback_api, "load_config", lambda: cfg)
    monkeypatch.setattr(playback_api, "ensure_cs2_path", lambda value: value)
    monkeypatch.setattr(
        playback_api.demo_playback_service,
        "preflight",
        lambda config: {"ok": False, "cs2_running": config is cfg},
    )

    result = asyncio.run(playback_api.demo_playback_preflight())

    assert result == {"ok": False, "cs2_running": True}


def test_playback_status_returns_measured_session_report(monkeypatch):
    monkeypatch.setattr(
        playback_api.demo_playback_service,
        "session_status",
        lambda session_id: {
            "found": True,
            "session_id": session_id,
            "state": "completed",
            "restore": {"verified": True},
        },
    )

    result = asyncio.run(playback_api.demo_playback_status("session-123"))

    assert result == {
        "found": True,
        "session_id": "session-123",
        "state": "completed",
        "restore": {"verified": True},
    }
