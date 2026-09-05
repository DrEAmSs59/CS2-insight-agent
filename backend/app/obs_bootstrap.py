"""Deterministic OBS startup and WebSocket preparation for AI tuning.

This module deliberately owns a very small mutation surface:

* it may launch the detected OBS executable;
* while OBS is not running, it may back up and enable the existing
  obs-websocket configuration;
* after a successful authenticated connection it persists the verified OBS
  path and port in the application config.

It never changes authentication, passwords, profiles, scenes, audio, stream
settings, or recording settings.
"""

from __future__ import annotations

import json
import os
import shutil
import subprocess
import sys
import time
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Callable, Optional

from pydantic import BaseModel, Field

from .env_utils import AppConfig, detect_obs_path, minimize_obs_window, save_config
from .obs_director import OBSDirector


class ObsBootstrapRequest(BaseModel):
    allow_websocket_config_write: bool = True
    launch_if_needed: bool = True
    password: Optional[str] = Field(default=None, max_length=512)


def resolve_websocket_config_path(*, appdata_dir: Optional[Path] = None) -> Optional[Path]:
    if appdata_dir is not None:
        return appdata_dir / "obs-studio" / "plugin_config" / "obs-websocket" / "config.json"
    if sys.platform == "win32":
        raw = (os.environ.get("APPDATA") or "").strip()
        return Path(raw) / "obs-studio" / "plugin_config" / "obs-websocket" / "config.json" if raw else None
    return Path.home() / ".config" / "obs-studio" / "plugin_config" / "obs-websocket" / "config.json"


def inspect_websocket_config(config_path: Optional[Path] = None) -> dict[str, Any]:
    path = config_path or resolve_websocket_config_path()
    base: dict[str, Any] = {
        "path": str(path) if path else None,
        "exists": bool(path and path.is_file()),
        "readable": False,
        "server_enabled": None,
        "port": None,
        "auth_required": None,
        "password_configured": False,
    }
    if not path or not path.is_file():
        return base
    try:
        raw = json.loads(path.read_text(encoding="utf-8-sig"))
        if not isinstance(raw, dict):
            raise ValueError("obs-websocket config root is not an object")
        port_raw = raw.get("server_port")
        try:
            port = int(port_raw) if port_raw is not None else None
        except (TypeError, ValueError):
            port = None
        base.update(
            {
                "readable": True,
                "server_enabled": bool(raw.get("server_enabled")),
                "port": port if port and 1 <= port <= 65535 else None,
                "auth_required": bool(raw.get("auth_required")),
                "password_configured": bool(str(raw.get("server_password") or "").strip()),
            }
        )
    except Exception as exc:  # noqa: BLE001
        base["error"] = str(exc)
    return base


def enable_websocket_server_safely(
    config_path: Path,
    *,
    obs_running: bool,
) -> dict[str, Any]:
    """Enable only ``server_enabled`` after a byte-for-byte backup.

    The caller must prove OBS is stopped. Authentication, password, port and
    every unknown key are preserved.
    """

    if obs_running:
        return {"ok": False, "changed": False, "reason": "obs_running", "backup_path": None}
    state = inspect_websocket_config(config_path)
    if not state["exists"]:
        return {"ok": False, "changed": False, "reason": "config_missing", "backup_path": None}
    if not state["readable"]:
        return {"ok": False, "changed": False, "reason": "config_unreadable", "backup_path": None}
    if state["server_enabled"]:
        return {"ok": True, "changed": False, "reason": "already_enabled", "backup_path": None, "state": state}

    raw = json.loads(config_path.read_text(encoding="utf-8-sig"))
    backup_dir = config_path.parent / ".cs2-insight-backups"
    backup_dir.mkdir(parents=True, exist_ok=True)
    stamp = datetime.now(timezone.utc).strftime("%Y%m%dT%H%M%S%fZ")
    backup_path = backup_dir / f"config.before-enable.{stamp}.json"
    shutil.copy2(config_path, backup_path)

    raw["server_enabled"] = True
    temp_path = config_path.with_name(f".{config_path.name}.{os.getpid()}.tmp")
    try:
        temp_path.write_text(json.dumps(raw, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
        shutil.copymode(config_path, temp_path)
        os.replace(temp_path, config_path)
    finally:
        if temp_path.exists():
            temp_path.unlink()

    updated = inspect_websocket_config(config_path)
    if not updated.get("server_enabled"):
        return {
            "ok": False,
            "changed": True,
            "reason": "readback_failed",
            "backup_path": str(backup_path),
            "state": updated,
        }
    return {
        "ok": True,
        "changed": True,
        "reason": "enabled",
        "backup_path": str(backup_path),
        "state": updated,
    }


def make_obs_launcher() -> Callable[[str], None]:
    """造一个 OBS 启动器，保持 ``Callable[[str], None]`` 这个注入点不变。"""
    def launch(obs_path: str) -> None:
        subprocess.Popen([obs_path], cwd=str(Path(obs_path).parent))

    return launch


def _default_process_checker(obs_path: str) -> bool:
    if sys.platform != "win32":
        return False
    try:
        exe_name = Path(obs_path).name
        result = subprocess.run(
            ["tasklist", "/FI", f"IMAGENAME eq {exe_name}", "/NH", "/FO", "CSV"],
            capture_output=True,
            text=True,
            timeout=8,
            creationflags=getattr(subprocess, "CREATE_NO_WINDOW", 0),
        )
        return exe_name.lower() in (result.stdout or "").lower()
    except Exception:  # noqa: BLE001
        return False


def _default_launcher(obs_path: str) -> None:
    make_obs_launcher()(obs_path)


def _default_connection_tester(app_cfg: AppConfig) -> dict[str, Any]:
    director = OBSDirector(app_cfg.obs, app_cfg.cs2_path)
    return director.test_obs_connection(handshake_timeout_sec=1.5)


def _event(step: str, status: str, message: str) -> dict[str, str]:
    return {"step": step, "status": status, "message": message}


def bootstrap_obs_environment(
    app_cfg: AppConfig,
    request: ObsBootstrapRequest,
    *,
    websocket_config_path: Optional[Path] = None,
    process_checker: Callable[[str], bool] = _default_process_checker,
    launcher: Optional[Callable[[str], None]] = None,
    connection_tester: Callable[[AppConfig], dict[str, Any]] = _default_connection_tester,
    sleep: Callable[[float], None] = time.sleep,
    persist_config: Callable[[AppConfig], None] = save_config,
    minimizer: Callable[[], None] = minimize_obs_window,
    process_wait_attempts: int = 30,
    connection_attempts: int = 15,
) -> dict[str, Any]:
    events: list[dict[str, str]] = []
    saved_path = str(app_cfg.obs.obs_path or "").strip()
    obs_path = saved_path if saved_path and Path(saved_path).is_file() else (detect_obs_path() or "")
    if not obs_path or not Path(obs_path).is_file():
        events.append(_event("detect_install", "blocked", "未找到可用的 OBS 可执行文件"))
        return {"ok": False, "status": "install_not_found", "events": events}
    events.append(_event("detect_install", "ok", "已识别 OBS 安装位置"))

    app_cfg.obs.obs_path = obs_path
    if request.password is not None and request.password.strip():
        app_cfg.obs.password = request.password.strip()

    running = bool(process_checker(obs_path))
    events.append(_event("check_process", "ok", "OBS 已运行" if running else "OBS 当前未运行"))

    ws_path = websocket_config_path or resolve_websocket_config_path()
    ws_state = inspect_websocket_config(ws_path)
    if ws_state["readable"]:
        events.append(_event("inspect_websocket", "ok", "已读取 WebSocket 状态（密码已隐藏）"))
        if ws_state.get("port"):
            app_cfg.obs.port = int(ws_state["port"])
    elif ws_state["exists"]:
        events.append(_event("inspect_websocket", "warning", "WebSocket 配置存在但无法安全读取"))
    else:
        events.append(_event("inspect_websocket", "pending", "尚未生成 WebSocket 配置，将在 OBS 首次启动后验证"))

    if running:
        connected = connection_tester(app_cfg)
        if connected.get("ok"):
            app_cfg.obs.obs_config_verified = True
            persist_config(app_cfg)
            minimizer()
            events.append(_event("connect_websocket", "ok", "OBS WebSocket 已连接"))
            return {
                "ok": True,
                "status": "connected",
                "launched_obs": False,
                "websocket_config_changed": False,
                "backup_path": None,
                "events": events,
                "websocket": inspect_websocket_config(ws_path),
            }
        if ws_state.get("server_enabled") is False:
            events.append(_event("enable_websocket", "blocked", "OBS 运行中，不能覆盖其 WebSocket 配置"))
            return {
                "ok": False,
                "status": "needs_safe_restart",
                "events": events,
                "websocket": ws_state,
            }
        if ws_state.get("auth_required") and not str(app_cfg.obs.password or "").strip():
            events.append(_event("connect_websocket", "blocked", "WebSocket 需要密码"))
            return {"ok": False, "status": "needs_password", "events": events, "websocket": ws_state}
        events.append(_event("connect_websocket", "failed", connected.get("error") or "WebSocket 连接失败"))
        return {
            "ok": False,
            "status": "invalid_password" if ws_state.get("auth_required") else "connection_failed",
            "events": events,
            "websocket": ws_state,
        }

    config_changed = False
    backup_path: Optional[str] = None
    if ws_state.get("server_enabled") is False:
        if not request.allow_websocket_config_write:
            events.append(_event("enable_websocket", "blocked", "需要批准后才能启用 WebSocket"))
            return {"ok": False, "status": "needs_websocket_enable", "events": events, "websocket": ws_state}
        if not ws_path:
            events.append(_event("enable_websocket", "failed", "无法定位 WebSocket 配置文件"))
            return {"ok": False, "status": "websocket_config_unavailable", "events": events, "websocket": ws_state}
        try:
            enabled = enable_websocket_server_safely(ws_path, obs_running=False)
        except Exception as exc:  # noqa: BLE001
            events.append(_event("enable_websocket", "failed", f"WebSocket 配置备份或写入失败：{exc}"))
            return {
                "ok": False,
                "status": "websocket_config_failed",
                "events": events,
                "backup_path": None,
                "websocket": inspect_websocket_config(ws_path),
            }
        if not enabled.get("ok"):
            events.append(_event("enable_websocket", "failed", "WebSocket 配置备份或回读失败"))
            return {
                "ok": False,
                "status": "websocket_config_failed",
                "events": events,
                "backup_path": enabled.get("backup_path"),
                "websocket": enabled.get("state") or ws_state,
            }
        config_changed = bool(enabled.get("changed"))
        backup_path = enabled.get("backup_path")
        ws_state = enabled.get("state") or inspect_websocket_config(ws_path)
        events.append(_event("enable_websocket", "ok", "已备份并启用 WebSocket 服务"))
    else:
        events.append(_event("enable_websocket", "skipped", "WebSocket 服务无需修改"))

    if ws_state.get("auth_required") and not str(app_cfg.obs.password or "").strip():
        events.append(_event("connect_websocket", "blocked", "WebSocket 需要现有密码；Agent 未读取或修改密码"))
        return {
            "ok": False,
            "status": "needs_password",
            "events": events,
            "websocket_config_changed": config_changed,
            "backup_path": backup_path,
            "websocket": ws_state,
        }

    if not request.launch_if_needed:
        events.append(_event("launch_obs", "blocked", "需要批准后才能启动 OBS"))
        return {
            "ok": False,
            "status": "needs_launch",
            "events": events,
            "websocket_config_changed": config_changed,
            "backup_path": backup_path,
            "websocket": ws_state,
        }

    try:
        (launcher or make_obs_launcher())(obs_path)
        events.append(_event("launch_obs", "ok", "已启动 OBS，正在等待 WebSocket"))
    except Exception as exc:  # noqa: BLE001
        events.append(_event("launch_obs", "failed", f"OBS 启动失败：{exc}"))
        return {
            "ok": False,
            "status": "launch_failed",
            "events": events,
            "websocket_config_changed": config_changed,
            "backup_path": backup_path,
            "websocket": ws_state,
        }

    for _ in range(max(0, process_wait_attempts)):
        if process_checker(obs_path):
            break
        sleep(0.5)

    last_connection: dict[str, Any] = {"ok": False, "error": "OBS WebSocket 尚未就绪"}
    for _ in range(max(1, connection_attempts)):
        last_connection = connection_tester(app_cfg)
        if last_connection.get("ok"):
            app_cfg.obs.obs_config_verified = True
            persist_config(app_cfg)
            minimizer()
            events.append(_event("connect_websocket", "ok", "OBS WebSocket 已连接并完成回读"))
            return {
                "ok": True,
                "status": "connected",
                "launched_obs": True,
                "websocket_config_changed": config_changed,
                "backup_path": backup_path,
                "events": events,
                "websocket": inspect_websocket_config(ws_path),
            }
        sleep(1.0)

    events.append(_event("connect_websocket", "failed", last_connection.get("error") or "WebSocket 连接失败"))
    return {
        "ok": False,
        "status": "invalid_password" if ws_state.get("auth_required") else "connection_failed",
        "launched_obs": True,
        "websocket_config_changed": config_changed,
        "backup_path": backup_path,
        "events": events,
        "websocket": ws_state,
    }
