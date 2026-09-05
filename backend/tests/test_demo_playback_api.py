import asyncio
import sys
from pathlib import Path
from types import SimpleNamespace

import pytest
from fastapi import HTTPException

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from app.features.demo_playback import api as playback_api


def test_alias_roster_resolves_library_and_path(monkeypatch, tmp_path):
    from unittest.mock import AsyncMock
    path = tmp_path / "sample.dem"
    players = [{"steamid64": "76561199032006224", "name": "Etagekax", "team_number": 2}]
    monkeypatch.setattr(playback_api.demo_db, "get_demo_by_id", AsyncMock(return_value={"id": 7}))
    monkeypatch.setattr(playback_api, "_library_working_demo_path", AsyncMock(return_value=path))
    monkeypatch.setattr(playback_api, "resolve_uploaded_demo_path_async", AsyncMock(return_value=path))
    def roster(value):
        assert value == path
        return players
    monkeypatch.setattr(playback_api, "player_alias_roster", roster)
    for body in [playback_api.AliasRosterBody(id=7), playback_api.AliasRosterBody(path="sample.dem")]:
        assert asyncio.run(playback_api.demo_alias_roster(body)) == {"players": players}
    with pytest.raises(HTTPException) as exc:
        asyncio.run(playback_api.demo_alias_roster(playback_api.AliasRosterBody()))
    assert exc.value.status_code == 422


def test_aliases_are_forwarded_even_without_pov(monkeypatch, tmp_path):
    cfg = _configured_cs2(tmp_path)
    demo = tmp_path / "match.dem"
    demo.write_bytes(b"demo")
    monkeypatch.setattr(playback_api, "load_config", lambda: cfg)
    monkeypatch.setattr(playback_api, "ensure_cs2_path", lambda value: value)
    def launch(path, config, options):
        assert not options.enabled
        assert options.player_aliases == {"76561199032006224": "京介"}
        return {"ok": True}
    monkeypatch.setattr(playback_api.demo_playback_service, "launch", launch)
    playback_api.launch_cs2_play_demo(demo, playback_api.DemoPlaybackOptionsBody(player_aliases={"76561199032006224": "京介"}))


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
        pov_hud=playback_api.DemoPlaybackPovBody(
            enabled=True,
            radar_mode=-1,
            teamcounter_numeric=True,
            skybox_id="cartoon3",
            input_hud_enabled=True,
            input_hud_display_mode="active",
            input_hud_scale_percent=115,
            input_audio_enabled=True,
            input_audio_volume_percent=50,
        ),
        map_material=playback_api.DemoPlaybackMapMaterialBody(id="waxed_reflection"),
        weather_effect=playback_api.DemoPlaybackWeatherEffectBody(id="default"),
    )

    result = playback_api.launch_cs2_play_demo(demo, body)

    assert result == {"ok": True, "pov_hud_enabled": True}
    assert captured["path"] == demo
    assert captured["config"] is cfg
    assert captured["options"] == playback_api.DemoPlaybackPovOptions(
        enabled=True,
        radar_mode=-1,
        teamcounter_numeric=True,
        skybox_id="cartoon3",
        map_material_id="waxed_reflection",
        input_hud_enabled=True,
        input_hud_display_mode="active",
        input_hud_scale_percent=115,
        input_audio_enabled=True,
        input_audio_volume_percent=50,
        weather_effect_id="default",
    )


def test_launch_rejects_unavailable_skybox(monkeypatch, tmp_path: Path):
    cfg = _configured_cs2(tmp_path)
    demo = tmp_path / "match.dem"
    demo.write_bytes(b"demo")
    monkeypatch.setattr(playback_api, "load_config", lambda: cfg)
    monkeypatch.setattr(playback_api, "ensure_cs2_path", lambda value: value)

    body = playback_api.DemoPlaybackOptionsBody(
        pov_hud=playback_api.DemoPlaybackPovBody(enabled=True, skybox_id="unknown"),
    )
    with pytest.raises(HTTPException) as exc_info:
        playback_api.launch_cs2_play_demo(demo, body)

    assert exc_info.value.status_code == 422
    assert "unsupported recording skybox" in str(exc_info.value.detail)


def test_legacy_rain_puddles_maps_to_validated_rain_weather(
    monkeypatch, tmp_path: Path
):
    cfg = _configured_cs2(tmp_path)
    demo = tmp_path / "match.dem"
    demo.write_bytes(b"demo")
    captured = {}
    monkeypatch.setattr(playback_api, "load_config", lambda: cfg)
    monkeypatch.setattr(playback_api, "ensure_cs2_path", lambda value: value)
    monkeypatch.setattr(
        playback_api.demo_playback_service,
        "launch",
        lambda _path, _config, options: captured.update(options=options) or {"ok": True},
    )

    playback_api.launch_cs2_play_demo(
        demo,
        playback_api.DemoPlaybackOptionsBody(
            pov_hud=playback_api.DemoPlaybackPovBody(
                enabled=True,
                skybox_id="cartoon3",
            ),
            map_material=playback_api.DemoPlaybackMapMaterialBody(id="rain_puddles"),
        ),
    )

    assert captured["options"].skybox_id == "cartoon3"
    assert captured["options"].map_material_id == "default"
    assert captured["options"].weather_effect_id == "rain"


def test_legacy_rain_puddles_rejects_a_separate_weather_choice(monkeypatch, tmp_path: Path):
    cfg = _configured_cs2(tmp_path)
    demo = tmp_path / "match.dem"
    demo.write_bytes(b"demo")
    captured = {}
    monkeypatch.setattr(playback_api, "load_config", lambda: cfg)
    monkeypatch.setattr(playback_api, "ensure_cs2_path", lambda value: value)
    monkeypatch.setattr(
        playback_api.demo_playback_service,
        "launch",
        lambda _path, _config, options: captured.update(options=options) or {"ok": True},
    )

    with pytest.raises(HTTPException) as exc_info:
        playback_api.launch_cs2_play_demo(
            demo,
            playback_api.DemoPlaybackOptionsBody(
                pov_hud=playback_api.DemoPlaybackPovBody(enabled=True),
                map_material=playback_api.DemoPlaybackMapMaterialBody(id="rain_puddles"),
                weather_effect=playback_api.DemoPlaybackWeatherEffectBody(id="snow"),
            ),
        )

    assert exc_info.value.status_code == 422
    assert "天气效果" in str(exc_info.value.detail)


def test_launch_rejects_unknown_map_material(monkeypatch, tmp_path: Path):
    cfg = _configured_cs2(tmp_path)
    demo = tmp_path / "match.dem"
    demo.write_bytes(b"demo")
    monkeypatch.setattr(playback_api, "load_config", lambda: cfg)
    monkeypatch.setattr(playback_api, "ensure_cs2_path", lambda value: value)

    body = playback_api.DemoPlaybackOptionsBody(
        pov_hud=playback_api.DemoPlaybackPovBody(enabled=True),
        map_material=playback_api.DemoPlaybackMapMaterialBody(id="chrome"),
    )
    with pytest.raises(HTTPException) as exc_info:
        playback_api.launch_cs2_play_demo(demo, body)

    assert exc_info.value.status_code == 422
    assert "unsupported recording map material" in str(exc_info.value.detail)


def test_launch_rejects_unknown_weather_effect(monkeypatch, tmp_path: Path):
    cfg = _configured_cs2(tmp_path)
    demo = tmp_path / "match.dem"
    demo.write_bytes(b"demo")
    monkeypatch.setattr(playback_api, "load_config", lambda: cfg)
    monkeypatch.setattr(playback_api, "ensure_cs2_path", lambda value: value)

    body = playback_api.DemoPlaybackOptionsBody(
        pov_hud=playback_api.DemoPlaybackPovBody(enabled=True),
        weather_effect=playback_api.DemoPlaybackWeatherEffectBody(id="blizzard"),
    )
    with pytest.raises(HTTPException) as exc_info:
        playback_api.launch_cs2_play_demo(demo, body)

    assert exc_info.value.status_code == 422
    assert "unsupported weather effect" in str(exc_info.value.detail)


def test_preflight_delegates_to_playback_service(monkeypatch, tmp_path: Path):
    cfg = _configured_cs2(tmp_path)
    monkeypatch.setattr(playback_api, "load_config", lambda: cfg)
    monkeypatch.setattr(playback_api, "ensure_cs2_path", lambda value: value)
    monkeypatch.setattr(
        playback_api.demo_playback_service,
        "preflight",
        lambda config: {"ok": False, "cs2_running": config is cfg},
    )
    monkeypatch.setattr(playback_api, "list_skybox_resources", lambda: [{"id": "cartoon3"}])

    result = asyncio.run(playback_api.demo_playback_preflight())

    assert result == {
        "ok": False,
        "cs2_running": True,
        "recording_skybox": "default",
        "recording_map_material": "default",
        "recording_weather_effect": "default",
        "skyboxes": [{"id": "cartoon3"}],
    }


def test_preflight_reports_bundled_rain_weather_for_rain_puddles(
    monkeypatch, tmp_path: Path
):
    cfg = _configured_cs2(tmp_path)
    cfg.recording_skybox = "cartoon3"
    cfg.recording_map_material = "rain_puddles"
    monkeypatch.setattr(playback_api, "load_config", lambda: cfg)
    monkeypatch.setattr(playback_api, "ensure_cs2_path", lambda value: value)
    monkeypatch.setattr(
        playback_api.demo_playback_service,
        "preflight",
        lambda _config: {"ok": True},
    )
    monkeypatch.setattr(playback_api, "list_skybox_resources", lambda: [])

    result = asyncio.run(playback_api.demo_playback_preflight())

    assert result["recording_skybox"] == "cartoon3"
    assert result["recording_map_material"] == "default"
    assert result["recording_weather_effect"] == "rain"


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
