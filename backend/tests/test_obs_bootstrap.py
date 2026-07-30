import json
from pathlib import Path

from app.env_utils import AppConfig, OBSConfig
from app.obs_bootstrap import (
    BEGIN_FRAME_SCHEDULING_FLAG,
    ObsBootstrapRequest,
    bootstrap_obs_environment,
    enable_websocket_server_safely,
    inspect_websocket_config,
    make_obs_launcher,
    obs_launch_args,
)


def _write_ws_config(path: Path, *, enabled: bool, auth_required: bool = False) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(
        json.dumps(
            {
                "server_enabled": enabled,
                "server_port": 4455,
                "auth_required": auth_required,
                "server_password": "keep-this-secret",
                "first_load": False,
            }
        ),
        encoding="utf-8",
    )


def test_websocket_inspection_never_returns_password(tmp_path):
    config_path = tmp_path / "config.json"
    _write_ws_config(config_path, enabled=True, auth_required=True)

    state = inspect_websocket_config(config_path)

    assert state["server_enabled"] is True
    assert state["auth_required"] is True
    assert state["password_configured"] is True
    assert "server_password" not in state
    assert "keep-this-secret" not in json.dumps(state)


def test_safe_enable_backs_up_and_preserves_auth_password_and_port(tmp_path):
    config_path = tmp_path / "config.json"
    _write_ws_config(config_path, enabled=False, auth_required=True)

    result = enable_websocket_server_safely(config_path, obs_running=False)
    updated = json.loads(config_path.read_text(encoding="utf-8"))
    backup = Path(result["backup_path"])
    original = json.loads(backup.read_text(encoding="utf-8"))

    assert result["ok"] is True
    assert result["changed"] is True
    assert backup.is_file()
    assert original["server_enabled"] is False
    assert updated["server_enabled"] is True
    assert updated["server_port"] == 4455
    assert updated["auth_required"] is True
    assert updated["server_password"] == "keep-this-secret"


def test_safe_enable_refuses_to_write_while_obs_is_running(tmp_path):
    config_path = tmp_path / "config.json"
    _write_ws_config(config_path, enabled=False)

    result = enable_websocket_server_safely(config_path, obs_running=True)

    assert result == {"ok": False, "changed": False, "reason": "obs_running", "backup_path": None}
    assert json.loads(config_path.read_text(encoding="utf-8"))["server_enabled"] is False


def test_bootstrap_enables_launches_connects_and_persists(tmp_path):
    obs_exe = tmp_path / "obs64.exe"
    obs_exe.write_bytes(b"MZ")
    ws_config = tmp_path / "config.json"
    _write_ws_config(ws_config, enabled=False, auth_required=False)
    cfg = AppConfig(obs=OBSConfig(obs_path=str(obs_exe), host="localhost", port=4455, password=""))
    state = {"running": False, "persisted": False, "minimized": False}

    def launch(path: str) -> None:
        assert path == str(obs_exe)
        state["running"] = True

    result = bootstrap_obs_environment(
        cfg,
        ObsBootstrapRequest(),
        websocket_config_path=ws_config,
        process_checker=lambda _path: state["running"],
        launcher=launch,
        connection_tester=lambda _cfg: {"ok": state["running"]},
        sleep=lambda _seconds: None,
        persist_config=lambda saved: state.update(persisted=saved.obs.obs_config_verified),
        minimizer=lambda: state.update(minimized=True),
        process_wait_attempts=1,
        connection_attempts=1,
    )

    assert result["ok"] is True
    assert result["status"] == "connected"
    assert result["launched_obs"] is True
    assert result["websocket_config_changed"] is True
    assert Path(result["backup_path"]).is_file()
    assert state["persisted"] is True
    assert state["minimized"] is True


def test_bootstrap_requests_existing_password_without_launching(tmp_path):
    obs_exe = tmp_path / "obs64.exe"
    obs_exe.write_bytes(b"MZ")
    ws_config = tmp_path / "config.json"
    _write_ws_config(ws_config, enabled=True, auth_required=True)
    cfg = AppConfig(obs=OBSConfig(obs_path=str(obs_exe), password=""))
    launched = []

    result = bootstrap_obs_environment(
        cfg,
        ObsBootstrapRequest(),
        websocket_config_path=ws_config,
        process_checker=lambda _path: False,
        launcher=lambda path: launched.append(path),
        sleep=lambda _seconds: None,
    )

    assert result["ok"] is False
    assert result["status"] == "needs_password"
    assert launched == []
    assert result["websocket"]["password_configured"] is True
    assert "server_password" not in result["websocket"]


def test_bootstrap_requires_safe_restart_if_running_server_is_disabled(tmp_path):
    obs_exe = tmp_path / "obs64.exe"
    obs_exe.write_bytes(b"MZ")
    ws_config = tmp_path / "config.json"
    _write_ws_config(ws_config, enabled=False)
    cfg = AppConfig(obs=OBSConfig(obs_path=str(obs_exe)))

    result = bootstrap_obs_environment(
        cfg,
        ObsBootstrapRequest(),
        websocket_config_path=ws_config,
        process_checker=lambda _path: True,
        connection_tester=lambda _cfg: {"ok": False, "error": "connection refused"},
        sleep=lambda _seconds: None,
    )

    assert result["ok"] is False
    assert result["status"] == "needs_safe_restart"
    assert json.loads(ws_config.read_text(encoding="utf-8"))["server_enabled"] is False


def test_browser_frame_pacing_is_off_by_default():
    assert obs_launch_args(AppConfig(obs=OBSConfig())) == []


def test_browser_frame_pacing_adds_the_cold_start_flag():
    cfg = AppConfig(obs=OBSConfig(browser_begin_frame_scheduling=True))

    assert obs_launch_args(cfg) == [BEGIN_FRAME_SCHEDULING_FLAG]


def test_launcher_passes_extra_arguments_to_obs(monkeypatch, tmp_path):
    obs_exe = tmp_path / "obs64.exe"
    obs_exe.write_bytes(b"MZ")
    calls: list[dict] = []
    monkeypatch.setattr(
        "app.obs_bootstrap.subprocess.Popen",
        lambda command, **kwargs: calls.append({"command": command, "kwargs": kwargs}),
    )

    make_obs_launcher([BEGIN_FRAME_SCHEDULING_FLAG])(str(obs_exe))

    assert calls[0]["command"] == [str(obs_exe), BEGIN_FRAME_SCHEDULING_FLAG]
    assert calls[0]["kwargs"]["cwd"] == str(tmp_path)


def test_cold_start_uses_configured_launch_flags(monkeypatch, tmp_path):
    # 不注入 launcher 时走内建启动器，配置里的标志必须真的落到命令行上。
    obs_exe = tmp_path / "obs64.exe"
    obs_exe.write_bytes(b"MZ")
    ws_config = tmp_path / "config.json"
    _write_ws_config(ws_config, enabled=True, auth_required=False)
    cfg = AppConfig(obs=OBSConfig(obs_path=str(obs_exe), browser_begin_frame_scheduling=True))
    commands: list[list[str]] = []
    monkeypatch.setattr(
        "app.obs_bootstrap.subprocess.Popen",
        lambda command, **_kwargs: commands.append(list(command)),
    )

    result = bootstrap_obs_environment(
        cfg,
        ObsBootstrapRequest(),
        websocket_config_path=ws_config,
        process_checker=lambda _path: bool(commands),
        connection_tester=lambda _cfg: {"ok": bool(commands)},
        sleep=lambda _seconds: None,
        persist_config=lambda _saved: None,
        minimizer=lambda: None,
        process_wait_attempts=1,
        connection_attempts=1,
    )

    assert result["ok"] is True
    assert commands == [[str(obs_exe), BEGIN_FRAME_SCHEDULING_FLAG]]
    launch = [event for event in result["events"] if event["step"] == "launch_obs"]
    assert "锁帧已开启" in launch[0]["message"]


def test_warns_when_running_obs_predates_the_flag(tmp_path):
    # 标志只能冷启动给。OBS 已经在跑时必须提示重启，否则校准出的偏置对不上这次录制。
    obs_exe = tmp_path / "obs64.exe"
    obs_exe.write_bytes(b"MZ")
    ws_config = tmp_path / "config.json"
    _write_ws_config(ws_config, enabled=True)
    cfg = AppConfig(obs=OBSConfig(obs_path=str(obs_exe), browser_begin_frame_scheduling=True))

    result = bootstrap_obs_environment(
        cfg,
        ObsBootstrapRequest(),
        websocket_config_path=ws_config,
        process_checker=lambda _path: True,
        flag_probe=lambda: False,
        connection_tester=lambda _cfg: {"ok": True},
        sleep=lambda _seconds: None,
        persist_config=lambda _saved: None,
        minimizer=lambda: None,
    )

    pacing = [event for event in result["events"] if event["step"] == "browser_frame_pacing"]
    assert pacing == [{"step": "browser_frame_pacing", "status": "warning", "message": "OBS 已在运行且未启用浏览器源锁帧，需重启 OBS 才生效"}]


def test_unreadable_command_line_is_reported_as_unknown_not_as_off(tmp_path):
    # OBS 以管理员身份运行时读不到命令行，"未知"不能被当成"没开"。
    obs_exe = tmp_path / "obs64.exe"
    obs_exe.write_bytes(b"MZ")
    ws_config = tmp_path / "config.json"
    _write_ws_config(ws_config, enabled=True)
    cfg = AppConfig(obs=OBSConfig(obs_path=str(obs_exe), browser_begin_frame_scheduling=True))

    result = bootstrap_obs_environment(
        cfg,
        ObsBootstrapRequest(),
        websocket_config_path=ws_config,
        process_checker=lambda _path: True,
        flag_probe=lambda: None,
        connection_tester=lambda _cfg: {"ok": True},
        sleep=lambda _seconds: None,
        persist_config=lambda _saved: None,
        minimizer=lambda: None,
    )

    (pacing,) = [event for event in result["events"] if event["step"] == "browser_frame_pacing"]
    assert pacing["status"] == "warning"
    assert "未知" in pacing["message"]


def test_no_pacing_event_when_the_flag_is_not_requested(tmp_path):
    obs_exe = tmp_path / "obs64.exe"
    obs_exe.write_bytes(b"MZ")
    ws_config = tmp_path / "config.json"
    _write_ws_config(ws_config, enabled=True)
    cfg = AppConfig(obs=OBSConfig(obs_path=str(obs_exe)))
    probed: list[bool] = []

    result = bootstrap_obs_environment(
        cfg,
        ObsBootstrapRequest(),
        websocket_config_path=ws_config,
        process_checker=lambda _path: True,
        flag_probe=lambda: probed.append(True) or False,
        connection_tester=lambda _cfg: {"ok": True},
        sleep=lambda _seconds: None,
        persist_config=lambda _saved: None,
        minimizer=lambda: None,
    )

    assert [event for event in result["events"] if event["step"] == "browser_frame_pacing"] == []
    # 没请求这个标志就不该为它去查进程命令行。
    assert probed == []
