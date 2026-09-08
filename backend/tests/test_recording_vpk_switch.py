import asyncio
from pathlib import Path
from types import SimpleNamespace

import pytest

from app import obs_director, pov_hud_manager
from app.demo_voice_hud import DemoVoiceHudBuild, DemoVoiceHudError
from app.env_utils import OBSConfig
from app.obs_director import OBSDirector, RecordingWarmupExtras
from app.pov_hud_manager import PovHudError, PovHudManager
from app.recording import plan_builder
from app.recording.executor import obs_recording_controller


@pytest.mark.parametrize("pov_enabled", [True, False])
@pytest.mark.parametrize("failure", [None, "restore", "install"])
def test_queue_restores_before_next_demo_and_never_launches_failed_package(
    monkeypatch, tmp_path, pov_enabled, failure,
):
    events = []
    installed = []

    class Manager:
        def __init__(self, _config):
            pass

        def install(self, **kwargs):
            index = len(installed)
            events.append(f"install{index}")
            installed.append(kwargs)
            if index == 1 and failure == "install":
                raise PovHudError("VPK file locked")

        def status(self):
            return {"original_gameinfo_sha256": "a" * 64}

    def restore(*_args, **_kwargs):
        events.append("restore")
        return {"verified": failure != "restore", "error": "restore failed"}

    class Controller:
        def __init__(self, *_args):
            pass

        async def force_stop_recording(self):
            return True

    monkeypatch.setattr(pov_hud_manager, "PovHudManager", Manager)
    monkeypatch.setattr(pov_hud_manager, "restore_pov_after_cs2_exit", restore)
    monkeypatch.setattr(obs_recording_controller, "OBSRecordingController", Controller)
    monkeypatch.setattr(plan_builder, "build_plan", lambda _dto: None)
    director = OBSDirector(OBSConfig(), "")

    def launch(demo, _warmup):
        events.append(f"launch:{demo.name}")
        # A launch failure is a supported path to the next demo group. It avoids
        # involving OBS/game automation while exercising the real queue loop.
        raise RuntimeError("simulated launch failure")

    monkeypatch.setattr(director, "_launch_cs2", launch)
    monkeypatch.setattr(director, "_kill_cs2", lambda: events.append("shutdown"))
    monkeypatch.setattr(director, "_cleanup_cs2_artifacts", lambda: None)
    requests = [
        SimpleNamespace(
            request_id=str(index),
            demo=SimpleNamespace(
                demo_path=str(tmp_path / f"{name}.dem"),
                demo_filename=f"{name}.dem", map_name=name,
            ),
        )
        for index, name in enumerate(["de_dust2", "de_mirage"])
    ]
    operation = director.execute_plan_queue(requests, warmup=RecordingWarmupExtras(
        pov_hud_enabled=pov_enabled, recording_hud_enabled=True, pov_voice_mode="all",
    ))
    if failure:
        with pytest.raises(PovHudError, match="de_mirage.dem"):
            asyncio.run(operation)
        assert "launch:de_mirage.dem" not in events
    else:
        assert len(asyncio.run(operation)) == 2
        assert events[:7] == [
            "install0", "launch:de_dust2.dem", "shutdown", "restore",
            "install1", "launch:de_mirage.dem", "shutdown",
        ]
    assert events[-1] == "restore"
    for index, kwargs in enumerate(installed):
        assert kwargs["demo_path"] == Path(requests[index].demo.demo_path)
        assert kwargs["map_name"] == requests[index].demo.map_name
        assert kwargs["voice_mode"] == "all"
        assert kwargs["require_demo_hud"] is True
        assert kwargs["pov_visuals_enabled"] is pov_enabled


@pytest.mark.parametrize("pov_enabled", [True, False])
@pytest.mark.parametrize("failure", [None, "build", "template"])
def test_manager_replaces_demo_package_and_rejects_static_fallback(
    monkeypatch, tmp_path, pov_enabled, failure,
):
    monkeypatch.setattr(pov_hud_manager.sys, "platform", "win32")
    monkeypatch.setattr(pov_hud_manager, "is_cs2_running", lambda: False)
    monkeypatch.setattr(pov_hud_manager, "load_input_report", lambda _path: {})
    cs2 = tmp_path / "game/bin/win64/cs2.exe"
    cs2.parent.mkdir(parents=True)
    cs2.write_bytes(b"exe")
    csgo = tmp_path / "game/csgo"
    csgo.mkdir()
    original = b"FileSystem\n{\n SearchPaths\n {\n Game csgo\n }\n}\n"
    (csgo / "gameinfo.gi").write_bytes(original)
    assets = tmp_path / "assets"
    assets.mkdir()
    for name in ["pov_default.vpk", "pov_voice_template.vpk", "pov_advanced_playback_template.vpk"]:
        (assets / name).write_bytes(b"static")
    manager = PovHudManager(SimpleNamespace(cs2_path=str(cs2)))
    monkeypatch.setattr(manager, "get_backup_dir", lambda: tmp_path / "backup")
    monkeypatch.setattr(manager, "get_project_pov_dir", lambda: assets)

    def build(demo, _template, **_kwargs):
        if demo.stem == "de_mirage" and failure == "build":
            raise DemoVoiceHudError("payload failed")
        return DemoVoiceHudBuild(
            vpk_bytes=demo.name.encode(), voice_packets=1, speakers=1, intervals=1,
            location_changes=0, payload_bytes=1, location_parse_failed=0,
            radar_map=demo.stem,
        )

    monkeypatch.setattr(pov_hud_manager, "build_demo_voice_hud_vpk", build)
    first = tmp_path / "de_dust2.dem"
    second = tmp_path / "de_mirage.dem"
    manager.install(map_name=first.stem, demo_path=first, pov_visuals_enabled=pov_enabled, require_demo_hud=True)
    assert (csgo / "pov.vpk").read_bytes() == b"de_dust2.dem"
    if failure == "template":
        manager.get_voice_hud_template_path(pov_visuals_enabled=pov_enabled).unlink()
    if failure:
        with pytest.raises(PovHudError, match="Demo HUD"):
            manager.install(map_name=second.stem, demo_path=second, pov_visuals_enabled=pov_enabled, require_demo_hud=True)
        assert not (csgo / "pov.vpk").exists()
        assert (csgo / "gameinfo.gi").read_bytes() == original
    else:
        manager.install(map_name=second.stem, demo_path=second, pov_visuals_enabled=pov_enabled, require_demo_hud=True)
        assert (csgo / "pov.vpk").read_bytes() == b"de_mirage.dem"
        assert manager.restore()["verified"]
        assert (csgo / "gameinfo.gi").read_bytes() == original
