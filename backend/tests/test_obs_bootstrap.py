import json
from pathlib import Path

from app.env_utils import AppConfig, OBSConfig
from app.obs_bootstrap import (
    ObsBootstrapRequest,
    bootstrap_obs_environment,
    enable_websocket_server_safely,
    inspect_websocket_config,
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
