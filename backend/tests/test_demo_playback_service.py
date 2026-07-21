import sys
import time
from pathlib import Path
from types import SimpleNamespace

import pytest

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from app import demo_playback_service as playback


class _FakePovManager:
    instances = []

    def __init__(self, _config):
        self.installed = 0
        self.restored = 0
        self.needs_restore = False
        self.__class__.instances.append(self)

    def status(self):
        return {
            "needs_restore": self.needs_restore,
            "warnings": [],
            "original_gameinfo_sha256": "a" * 64 if self.needs_restore else None,
        }

    def install(self):
        self.installed += 1
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
        playback.DemoPlaybackPovOptions(enabled=True, radar_mode=-1, teamcounter_numeric=True),
    )

    session = service._active
    manager = _FakePovManager.instances[-1]
    assert result["pov_hud_enabled"] is True
    assert manager.installed == 1
    assert session is not None and session.copied_cfg is not None
    cfg_text = session.copied_cfg.read_text(encoding="ascii")
    assert "cl_draw_only_deathnotices false" in cfg_text
    assert "cl_drawhud_force_radar -1" in cfg_text
    assert "cl_teamcounter_playercount_instead_of_avatars true" in cfg_text
    assert calls[0][0][-2:] == ["+exec", session.copied_demo.stem]

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
