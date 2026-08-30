import sys
import time
from pathlib import Path
from types import SimpleNamespace

import pytest

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from app import demo_playback_service as playback
from app import pov_hud_manager


class _FakePovManager:
    instances = []

    def __init__(self, _config):
        self.installed = 0
        self.installed_demo_paths = []
        self.advanced_playback_flags = []
        self.skybox_ids = []
        self.map_material_ids = []
        self.restored = 0
        self.needs_restore = False
        self.__class__.instances.append(self)

    def status(self):
        return {
            "needs_restore": self.needs_restore,
            "warnings": [],
            "original_gameinfo_sha256": "a" * 64 if self.needs_restore else None,
        }

    def install(
        self,
        *,
        demo_path=None,
        advanced_playback_enabled=False,
        skybox_id="default",
        map_material_id="default",
    ):
        self.installed += 1
        self.installed_demo_paths.append(demo_path)
        self.advanced_playback_flags.append(bool(advanced_playback_enabled))
        self.skybox_ids.append(skybox_id)
        self.map_material_ids.append(map_material_id)
        self.needs_restore = True

    def restore(self):
        self.restored += 1
        self.needs_restore = False
        return self.verify_restoration("a" * 64)

    def verify_restoration(self, expected_gameinfo_sha256=None):
        restored = not self.needs_restore
        return {
            "verified": restored,
            "gameinfo_restored": restored,
            "pov_vpk_removed": restored,
            "expected_gameinfo_sha256": expected_gameinfo_sha256,
            "actual_gameinfo_sha256": expected_gameinfo_sha256 if restored else "b" * 64,
            "error": "" if restored else "not restored",
        }


class _FakeProcess:
    def __init__(self):
        self.waited = 0

    def wait(self):
        self.waited += 1
        return 0


class _DeferredThread:
    def __init__(self, *, target, args, **_kwargs):
        self.target = target
        self.args = args

    def start(self):
        return None


def _paths(tmp_path: Path):
    game_root = tmp_path / "game"
    cs2 = game_root / "bin" / "win64" / "cs2.exe"
    cs2.parent.mkdir(parents=True)
    cs2.write_bytes(b"exe")
    (game_root / "csgo").mkdir()
    demo = tmp_path / "match.dem"
    demo.write_bytes(b"demo")
    return SimpleNamespace(cs2_path=str(cs2)), demo, game_root


@pytest.fixture(autouse=True)
def _playback_fakes(monkeypatch):
    _FakePovManager.instances.clear()
    monkeypatch.setattr(playback, "PovHudManager", _FakePovManager)
    monkeypatch.setattr(playback, "is_cs2_running", lambda: False)
    monkeypatch.setattr(
        playback,
        "ensure_demo_compatible",
        lambda _path: SimpleNamespace(
            cached=False,
            report=SimpleNamespace(outcome="clean", removed_messages=0),
        ),
    )
    monkeypatch.setattr(playback, "snapshot_user_configs", lambda _cs2_path: {})
    monkeypatch.setattr(playback.threading, "Thread", _DeferredThread)


def test_launch_is_blocked_when_cs2_is_running(monkeypatch, tmp_path: Path):
    cfg, demo, _game_root = _paths(tmp_path)
    monkeypatch.setattr(playback, "is_cs2_running", lambda: True)
    popen = pytest.fail
    monkeypatch.setattr(playback.subprocess, "Popen", popen)

    with pytest.raises(playback.DemoPlaybackCs2RunningError):
        playback.DemoPlaybackService().launch(demo, cfg)


def test_normal_playback_uses_unique_demo_and_cleans_it(monkeypatch, tmp_path: Path):
    cfg, demo, game_root = _paths(tmp_path)
    calls = []
    process = _FakeProcess()

    def fake_popen(argv, **kwargs):
        calls.append((argv, kwargs))
        return process

    monkeypatch.setattr(playback.subprocess, "Popen", fake_popen)
    service = playback.DemoPlaybackService()
    result = service.launch(demo, cfg)

    session = service._active
    assert result["ok"] is True
    assert result["pov_hud_enabled"] is False
    assert session is not None and session.copied_demo.is_file()
    argv, kwargs = calls[0]
    predict_index = argv.index("+cl_demo_predict")
    assert argv[predict_index:predict_index + 2] == ["+cl_demo_predict", "0"]
    assert predict_index < argv.index("+playdemo")
    assert argv[-2] == "+playdemo"
    assert argv[-1] == session.copied_demo.name
    assert kwargs["cwd"] == str(game_root)
    assert kwargs["env"]["SteamAppId"] == "730"

    session.started_at_monotonic = time.monotonic() - 4
    service._monitor_session(session)
    assert process.waited == 1
    assert not session.copied_demo.exists()
    assert service._active is None


def test_pov_playback_installs_cfg_and_restores_after_exit(monkeypatch, tmp_path: Path):
    cfg, demo, _game_root = _paths(tmp_path)
    process = _FakeProcess()
    calls = []
    monkeypatch.setattr(
        playback.subprocess,
        "Popen",
        lambda argv, **kwargs: calls.append((argv, kwargs)) or process,
    )
    service = playback.DemoPlaybackService()
    result = service.launch(
        demo,
        cfg,
        playback.DemoPlaybackPovOptions(
            enabled=True,
            radar_mode=-1,
            teamcounter_numeric=True,
            skybox_id="cartoon3",
            map_material_id="waxed_reflection",
        ),
    )

    session = service._active
    manager = _FakePovManager.instances[-1]
    assert result["pov_hud_enabled"] is True
    assert manager.installed == 1
    assert manager.installed_demo_paths == [demo]
    assert manager.advanced_playback_flags == [True]
    assert manager.skybox_ids == ["cartoon3"]
    assert manager.map_material_ids == ["waxed_reflection"]
    assert result["recording_skybox_id"] == "cartoon3"
    assert result["recording_map_material_id"] == "waxed_reflection"
    assert session is not None and session.copied_cfg is not None
    cfg_text = session.copied_cfg.read_text(encoding="ascii")
    assert "demoui false" not in cfg_text
    assert "sv_cheats 1" in cfg_text
    assert cfg_text.index("sv_cheats 1") < cfg_text.index("playdemo ")
    assert cfg_text.rstrip().endswith(f'playdemo "{session.copied_demo.stem}.dem"\ndemoui true')
    assert "demo_ui_mode" not in cfg_text
    assert "cl_draw_only_deathnotices false" in cfg_text
    assert "snd_disable_radar_visualize 0" in cfg_text
    assert "cl_drawhud_force_radar -1" in cfg_text
    assert "cl_teamcounter_playercount_instead_of_avatars true" in cfg_text
    assert "mat_fullbright 0" in cfg_text
    assert "r_rendersun 0" in cfg_text
    assert "r_directlighting 0" in cfg_text
    assert "r_indirectlighting 1" in cfg_text
    argv = calls[0][0]
    predict_index = argv.index("+cl_demo_predict")
    assert argv[predict_index:predict_index + 2] == ["+cl_demo_predict", "0"]
    assert predict_index < argv.index("+exec")
    assert argv[-2:] == ["+exec", session.copied_demo.stem]

    session.started_at_monotonic = time.monotonic() - 4
    service._monitor_session(session)
    assert manager.restored == 1
    assert not session.copied_demo.exists()
    assert not session.copied_cfg.exists()
    assert service._active is None
    status = service.session_status(result["session_id"])
    assert status["state"] == "completed"
    assert status["restore"]["verified"] is True
    assert status["restore"]["gameinfo_restored"] is True
    assert status["restore"]["pov_vpk_removed"] is True

    manager.needs_restore = True
    rechecked = service.session_status(result["session_id"])
    assert rechecked["state"] == "restore_failed"
    assert rechecked["restore"]["verified"] is False


def test_chroma_pov_playback_redirects_only_the_disposable_demo_copy(
    monkeypatch,
    tmp_path: Path,
):
    cfg, demo, _game_root = _paths(tmp_path)
    original = demo.read_bytes()
    process = _FakeProcess()
    calls = []

    def fake_prepare(source, destination, **kwargs):
        calls.append((Path(source), Path(destination), kwargs))
        Path(destination).write_bytes(b"redirected-handle-demo")
        return SimpleNamespace(
            manifest_report=SimpleNamespace(rewritten_chroma_sky_references=2),
            handle_report=SimpleNamespace(
                fields_rewritten=28,
                input_sha256="1" * 64,
                output_sha256="2" * 64,
            ),
        )

    monkeypatch.setattr(playback, "prepare_chroma_demo_copy", fake_prepare)
    monkeypatch.setattr(
        playback,
        "_detect_chroma_demo_map_name",
        lambda _path: "de_ancient",
    )
    monkeypatch.setattr(playback.subprocess, "Popen", lambda *_args, **_kwargs: process)

    service = playback.DemoPlaybackService()
    service.launch(
        demo,
        cfg,
        playback.DemoPlaybackPovOptions(
            enabled=True,
            skybox_id="chroma_blue",
        ),
    )

    session = service._active
    assert session is not None
    assert demo.read_bytes() == original
    assert session.copied_demo.read_bytes() == b"redirected-handle-demo"
    assert len(calls) == 1
    source, destination, kwargs = calls[0]
    assert source == demo
    assert destination == session.copied_demo
    assert kwargs == {"map_name": "de_ancient"}

    session.started_at_monotonic = time.monotonic() - 4
    service._monitor_session(session)


def test_pov_playback_snapshots_and_restores_player_configs(monkeypatch, tmp_path: Path):
    cfg, demo, _game_root = _paths(tmp_path)
    process = _FakeProcess()
    original_snapshot = {tmp_path / "cs2_machine_convars.vcfg": b'"cl_hud_color" "8"'}
    calls = []

    monkeypatch.setattr(playback, "snapshot_user_configs", lambda _cs2_path: original_snapshot)
    monkeypatch.setattr(
        playback,
        "write_persistent_backup_from_snap",
        lambda snapshot: calls.append(("backup", snapshot)) or (tmp_path / "backup"),
    )
    monkeypatch.setattr(
        playback,
        "restore_user_config_snapshot",
        lambda snapshot: calls.append(("restore", snapshot)) or {
            "ok": True,
            "verified": True,
            "checked": 1,
            "restored": 1,
            "failed": [],
            "source": "manifest",
        },
    )
    monkeypatch.setattr(playback.subprocess, "Popen", lambda *_args, **_kwargs: process)

    service = playback.DemoPlaybackService()
    result = service.launch(demo, cfg, playback.DemoPlaybackPovOptions(enabled=True))
    session = service._active
    assert session is not None
    session.started_at_monotonic = time.monotonic() - 4
    service._monitor_session(session)

    assert calls == [
        ("backup", original_snapshot),
        ("restore", original_snapshot),
    ]
    status = service.session_status(result["session_id"])
    assert status["state"] == "completed"
    assert status["player_config_restore"]["verified"] is True
    assert status["player_config_restore"]["state"] == "restored"


def test_pov_launch_failure_restores_player_configs(monkeypatch, tmp_path: Path):
    cfg, demo, _game_root = _paths(tmp_path)
    original_snapshot = {tmp_path / "cs2_user_keys.vcfg": b'"ALT" "toggleradarscale"'}
    restored = []

    monkeypatch.setattr(playback, "snapshot_user_configs", lambda _cs2_path: original_snapshot)
    monkeypatch.setattr(
        playback,
        "write_persistent_backup_from_snap",
        lambda _snapshot: tmp_path / "backup",
    )
    monkeypatch.setattr(
        playback,
        "restore_user_config_snapshot",
        lambda snapshot: restored.append(snapshot) or {
            "ok": True,
            "verified": True,
            "checked": 1,
            "restored": 0,
            "failed": [],
            "source": "manifest",
        },
    )
    monkeypatch.setattr(
        playback.subprocess,
        "Popen",
        lambda *_args, **_kwargs: (_ for _ in ()).throw(OSError("launch failed")),
    )

    with pytest.raises(OSError, match="launch failed"):
        playback.DemoPlaybackService().launch(
            demo,
            cfg,
            playback.DemoPlaybackPovOptions(enabled=True),
        )

    assert restored == [original_snapshot]


def test_playback_is_blocked_when_player_config_backup_cannot_be_created(
    monkeypatch,
    tmp_path: Path,
):
    cfg, demo, _game_root = _paths(tmp_path)
    snapshot = {tmp_path / "cs2_machine_convars.vcfg": b'"cl_hud_color" "8"'}
    monkeypatch.setattr(playback, "snapshot_user_configs", lambda _cs2_path: snapshot)
    monkeypatch.setattr(playback, "write_persistent_backup_from_snap", lambda _snapshot: None)
    monkeypatch.setattr(playback.subprocess, "Popen", pytest.fail)

    with pytest.raises(RuntimeError, match="player config backup"):
        playback.DemoPlaybackService().launch(
            demo,
            cfg,
            playback.DemoPlaybackPovOptions(enabled=True),
        )


def test_pov_launch_failure_rolls_back_files(monkeypatch, tmp_path: Path):
    cfg, demo, _game_root = _paths(tmp_path)
    monkeypatch.setattr(
        playback.subprocess,
        "Popen",
        lambda *_args, **_kwargs: (_ for _ in ()).throw(OSError("launch failed")),
    )
    service = playback.DemoPlaybackService()

    with pytest.raises(OSError, match="launch failed"):
        service.launch(demo, cfg, playback.DemoPlaybackPovOptions(enabled=True))

    manager = _FakePovManager.instances[-1]
    assert manager.installed == 1
    assert manager.restored == 1
    assert list((tmp_path / "game" / "csgo").glob("_insight_preview_*")) == []
    assert service._active is None


def test_normal_playback_repairs_orphaned_pov_residue_before_launch(
    monkeypatch,
    tmp_path: Path,
):
    cfg, demo, game_root = _paths(tmp_path)
    csgo = game_root / "csgo"
    gameinfo = csgo / "gameinfo.gi"
    gameinfo.write_text(
        'FileSystem\n{\n  SearchPaths\n  {\n    Game csgo/pov.vpk\n    Game csgo\n  }\n}\n',
        encoding="utf-8",
    )
    (csgo / "pov.vpk").write_bytes(b"residue")
    process = _FakeProcess()

    monkeypatch.setattr(playback, "PovHudManager", pov_hud_manager.PovHudManager)
    monkeypatch.setattr(pov_hud_manager.sys, "platform", "win32")
    monkeypatch.setattr(pov_hud_manager, "is_cs2_running", lambda: False)
    monkeypatch.setattr(playback.subprocess, "Popen", lambda *_args, **_kwargs: process)

    service = playback.DemoPlaybackService()
    result = service.launch(demo, cfg)

    assert result["ok"] is True
    assert "csgo/pov.vpk" not in gameinfo.read_text(encoding="utf-8")
    assert not (csgo / "pov.vpk").exists()
    session = service._active
    assert session is not None
    session.started_at_monotonic = time.monotonic() - 4
    service._monitor_session(session)
