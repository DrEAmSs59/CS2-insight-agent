import asyncio
import sys
from pathlib import Path
from types import SimpleNamespace

import pytest
from fastapi import HTTPException

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from app import main


def _configured_cs2(tmp_path: Path):
    cs2 = tmp_path / "game" / "bin" / "win64" / "cs2.exe"
    cs2.parent.mkdir(parents=True)
    cs2.write_bytes(b"exe")
    return SimpleNamespace(cs2_path=str(cs2))


def test_launch_maps_running_process_to_stable_409(monkeypatch, tmp_path: Path):
    cfg = _configured_cs2(tmp_path)
    demo = tmp_path / "match.dem"
    demo.write_bytes(b"demo")
    monkeypatch.setattr(main, "load_config", lambda: cfg)
    monkeypatch.setattr(main, "ensure_cs2_path", lambda value: value)
    monkeypatch.setattr(
        main.demo_playback_service,
        "launch",
        lambda *_args, **_kwargs: (_ for _ in ()).throw(main.DemoPlaybackCs2RunningError()),
    )

    with pytest.raises(HTTPException) as exc_info:
        main._launch_cs2_play_demo(demo, main.DemoPlaybackOptionsBody())

    assert exc_info.value.status_code == 409
    assert exc_info.value.detail == {"code": "DEMO_PLAYBACK_CS2_RUNNING"}


def test_launch_forwards_pov_session_options(monkeypatch, tmp_path: Path):
    cfg = _configured_cs2(tmp_path)
    demo = tmp_path / "match.dem"
    demo.write_bytes(b"demo")
    captured = {}
    monkeypatch.setattr(main, "load_config", lambda: cfg)
    monkeypatch.setattr(main, "ensure_cs2_path", lambda value: value)

    def fake_launch(path, config, options):
        captured.update(path=path, config=config, options=options)
        return {"ok": True, "pov_hud_enabled": options.enabled}

    monkeypatch.setattr(main.demo_playback_service, "launch", fake_launch)
    body = main.DemoPlaybackOptionsBody(
        pov_hud=main.DemoPlaybackPovBody(enabled=True, radar_mode=-1, teamcounter_numeric=True),
    )

    result = main._launch_cs2_play_demo(demo, body)

    assert result == {"ok": True, "pov_hud_enabled": True}
    assert captured["path"] == demo
    assert captured["config"] is cfg
    assert captured["options"] == main.DemoPlaybackPovOptions(
        enabled=True,
        radar_mode=-1,
        teamcounter_numeric=True,
    )


def test_preflight_delegates_to_playback_service(monkeypatch, tmp_path: Path):
    cfg = _configured_cs2(tmp_path)
    monkeypatch.setattr(main, "load_config", lambda: cfg)
    monkeypatch.setattr(main, "ensure_cs2_path", lambda value: value)
    monkeypatch.setattr(
        main.demo_playback_service,
        "preflight",
        lambda config: {"ok": False, "cs2_running": config is cfg},
    )

    result = asyncio.run(main.demo_playback_preflight())

    assert result == {"ok": False, "cs2_running": True}


def test_playback_status_returns_measured_session_report(monkeypatch):
    monkeypatch.setattr(
        main.demo_playback_service,
        "session_status",
        lambda session_id: {
            "found": True,
            "session_id": session_id,
            "state": "completed",
            "restore": {"verified": True},
        },
    )

    result = asyncio.run(main.demo_playback_status("session-123"))

    assert result == {
        "found": True,
        "session_id": "session-123",
        "state": "completed",
        "restore": {"verified": True},
    }
