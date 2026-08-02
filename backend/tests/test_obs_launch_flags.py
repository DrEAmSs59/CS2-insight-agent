"""锁帧标志必须落到**每一条** OBS 启动路径上。

OBS 有三个启动点：AI 调优面板走 obs_bootstrap 的可注入 launcher，而设置页的"配置检查"
和手动启动是 api/obs.py 里两处独立的 Popen。只改其中一条会让标志在最常用的路径上静默
缺席，而且缺席时没有任何报错——所以这里逐条钉住。
"""

import sys
from pathlib import Path

import pytest

_BACKEND_ROOT = Path(__file__).resolve().parents[1]
if str(_BACKEND_ROOT) not in sys.path:
    sys.path.insert(0, str(_BACKEND_ROOT))

from app.api import obs as obs_api
from app.env_utils import AppConfig, OBSConfig
from app.obs_bootstrap import BEGIN_FRAME_SCHEDULING_FLAG


@pytest.fixture
def obs_exe(tmp_path):
    exe = tmp_path / "obs64.exe"
    exe.write_bytes(b"MZ")
    return exe


@pytest.fixture
def launches(monkeypatch):
    """拦下真正的 Popen，记录每次启动的完整命令行。"""
    recorded: list[list[str]] = []
    monkeypatch.setattr(
        "app.obs_bootstrap.subprocess.Popen",
        lambda command, **_kwargs: recorded.append(list(command)),
    )
    monkeypatch.setattr(obs_api.time, "sleep", lambda _seconds: None)
    return recorded


def _config(obs_exe, *, flag: bool) -> AppConfig:
    return AppConfig(
        obs=OBSConfig(obs_path=str(obs_exe), browser_begin_frame_scheduling=flag)
    )


class TestManualLaunch:
    def test_includes_the_flag_when_enabled(self, monkeypatch, obs_exe, launches):
        monkeypatch.setattr(obs_api, "load_config", lambda: _config(obs_exe, flag=True))

        assert obs_api.obs_launch() == {"ok": True}
        assert launches == [[str(obs_exe), BEGIN_FRAME_SCHEDULING_FLAG]]

    def test_launches_bare_when_disabled(self, monkeypatch, obs_exe, launches):
        monkeypatch.setattr(obs_api, "load_config", lambda: _config(obs_exe, flag=False))

        obs_api.obs_launch()

        assert launches == [[str(obs_exe)]]


class TestConfigCheckLaunch:
    def _run(self, monkeypatch, obs_exe, *, flag: bool):
        monkeypatch.setattr(obs_api, "load_config", lambda: _config(obs_exe, flag=flag))
        # 先报"没在跑"触发启动，随后报"在跑"让等待循环立刻退出。
        states = iter([False, True])
        monkeypatch.setattr(
            obs_api, "_is_obs_process_running", lambda _path: next(states, True)
        )
        monkeypatch.setattr(obs_api, "minimize_obs_window", lambda: None)
        return obs_api.obs_config_check(None)

    def test_includes_the_flag_when_enabled(self, monkeypatch, obs_exe, launches):
        result = self._run(monkeypatch, obs_exe, flag=True)

        assert result["launched_obs"] is True
        assert launches == [[str(obs_exe), BEGIN_FRAME_SCHEDULING_FLAG]]

    def test_launches_bare_when_disabled(self, monkeypatch, obs_exe, launches):
        self._run(monkeypatch, obs_exe, flag=False)

        assert launches == [[str(obs_exe)]]

    def test_does_not_relaunch_an_already_running_obs(self, monkeypatch, obs_exe, launches):
        monkeypatch.setattr(obs_api, "load_config", lambda: _config(obs_exe, flag=True))
        monkeypatch.setattr(obs_api, "_is_obs_process_running", lambda _path: True)
        monkeypatch.setattr(obs_api, "minimize_obs_window", lambda: None)

        result = obs_api.obs_config_check(None)

        assert result["launched_obs"] is False
        assert launches == []


def test_every_popen_of_obs64_goes_through_the_shared_launcher():
    """守住结构：api/obs.py 不该再出现直接拿 obs_path 起进程的写法。

    新增启动点时忘记加标志是这次真实发生过的疏漏，靠源码断言比靠记性可靠。
    """
    source = (_BACKEND_ROOT / "app" / "api" / "obs.py").read_text(encoding="utf-8")

    assert "subprocess.Popen([obs_path]" not in source
    assert source.count("make_obs_launcher(obs_launch_args(cfg))") == 2
