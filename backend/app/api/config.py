"""Configuration, update and experimental-feature API routes."""

from __future__ import annotations

import asyncio
import logging
import os
import subprocess
import sys
from pathlib import Path
from typing import Any, Optional

from fastapi import APIRouter, HTTPException
from pydantic import BaseModel, Field

from ..app_state import application_state
from ..env_utils import (
    LLMConfig,
    OBSConfig,
    detect_cs2_path,
    detect_ffmpeg_path,
    detect_obs_path,
    ensure_cs2_path,
    get_data_dir,
    llm_api_key_configured,
    llm_base_url_is_local_host,
    load_config,
    resolve_config_path,
    save_config,
)
from ..update_info import build_update_payload, resolve_local_version_info

router = APIRouter(tags=["config"])


class ExperimentalPayload(BaseModel):
    pov_enabled: Optional[bool] = None


class ConfigPayload(BaseModel):
    obs: Optional[OBSConfig] = None
    llm: Optional[LLMConfig] = None
    ffmpeg_path: Optional[str] = None
    montage_encoder: Optional[str] = None
    cs2_path: Optional[str] = None
    demo_directory: Optional[str] = None
    demo_cache_directory: Optional[str] = None
    demo_watch_paths: Optional[list[str]] = None
    demo_watch_scan_depth: Optional[int] = Field(default=None, ge=0, le=32)
    ai_mode: Optional[bool] = None
    obs_agent_auto_prepare: Optional[bool] = None
    locale: Optional[str] = None
    expected_parse_players: Optional[list[str]] = None
    recording_global_pacing: Optional[dict[str, Any]] = None
    default_record_warmup: Optional[dict[str, Any]] = None
    cs2_extra_launch_args: Optional[str] = None
    cs2_extra_launch_args_user_configured: Optional[bool] = None
    record_inject_console_lines: Optional[str] = None
    record_inject_console_lines_user_configured: Optional[bool] = None
    obs_transition_enabled: Optional[bool] = None
    obs_transition_name: Optional[str] = None
    obs_transition_duration_ms: Optional[int] = None
    kb_overlay_enabled: Optional[bool] = None
    kb_overlay_tick_offset: Optional[int] = None
    kb_overlay_position: Optional[str] = None
    kill_fx_enabled: Optional[bool] = None
    kill_fx_tick_offset: Optional[int] = None
    experimental: Optional[ExperimentalPayload] = None
    steam_api_key: Optional[str] = None
    steam_id64: Optional[str] = None
    steam_cdn_assets_enabled: Optional[bool] = None
    match_mode: Optional[str] = None
    match_count: Optional[int] = None
    update_check_frequency: Optional[str] = None
    last_update_check_at: Optional[str] = None
    latency_calibration_enabled: Optional[bool] = None


@router.get("/api/config")
def get_config():
    cfg = ensure_cs2_path(load_config())
    data = cfg.model_dump()
    if data["llm"]["api_key"]:
        data["llm"]["api_key"] = "****" + data["llm"]["api_key"][-4:]
    if data.get("steam_api_key"):
        raw = data["steam_api_key"]
        data["steam_api_key"] = "****" + raw[-4:] if len(raw) >= 4 else "****"
    obs_pw = (data.get("obs") or {}).get("password") or ""
    if obs_pw:
        data.setdefault("obs", {})
        data["obs"]["password"] = "****" + str(obs_pw)[-4:] if len(str(obs_pw)) > 4 else "****"

    from ..env_utils import resolve_effective_locale

    data["effective_locale"] = resolve_effective_locale(data.get("locale", "auto"))
    return data


@router.get("/api/app/update-info")
def get_app_update_info(force: bool = False):
    """Compare the local version with the latest GitHub release."""
    current, source = resolve_local_version_info()
    payload = build_update_payload(current, source, force_refresh=bool(force))
    if payload.get("checked_at"):
        try:
            cfg = load_config()
            cfg.last_update_check_at = payload["checked_at"]
            save_config(cfg)
        except Exception:
            pass
    return payload


@router.post("/api/config/detect-encoder")
async def detect_encoder():
    from ..montage_encoder import diagnose_encoders
    from ..video_composer import MontageComposerError, resolve_ffmpeg_binary

    cfg = load_config()
    try:
        ffmpeg_bin = resolve_ffmpeg_binary(cfg.ffmpeg_path)
    except MontageComposerError as exc:
        raise HTTPException(400, str(exc)) from exc
    result = await asyncio.to_thread(diagnose_encoders, ffmpeg_bin)
    result["ffmpeg_path"] = str(ffmpeg_bin)
    return result


@router.post("/api/config/detect-cs2")
def detect_cs2_save():
    path = detect_cs2_path()
    if not path:
        raise HTTPException(
            404,
            "未找到 CS2（cs2.exe）。请确认已安装游戏，或在侧栏手动填写 cs2.exe 的完整路径。",
        )
    cfg = load_config()
    cfg.cs2_path = path
    save_config(cfg)
    return {"cs2_path": path}


@router.post("/api/config/detect-ffmpeg")
def detect_ffmpeg_save():
    path = detect_ffmpeg_path()
    if not path:
        raise HTTPException(
            404,
            "未找到 FFmpeg（ffmpeg.exe）。请安装 FFmpeg 并确保其在系统 PATH 中，或在设置中手动填写完整路径。",
        )
    cfg = load_config()
    cfg.ffmpeg_path = path
    save_config(cfg)
    return {"ffmpeg_path": path}


def open_directory(folder: str, failure_message: str) -> dict[str, Any]:
    try:
        if sys.platform == "win32":
            os.startfile(folder)  # noqa: S606
        elif sys.platform == "darwin":
            subprocess.run(["open", folder], check=False, timeout=30)
        else:
            subprocess.run(["xdg-open", folder], check=False, timeout=30)
        return {"ok": True, "path": folder}
    except Exception as exc:  # noqa: BLE001
        logging.warning("open directory failed: %s", exc)
        return {"ok": False, "path": folder, "message": failure_message}


@router.post("/api/config/open-dir")
def open_config_data_dir():
    folder = str(resolve_config_path().parent.resolve())
    return open_directory(folder, "无法自动打开目录，请手动复制路径。")


@router.post("/api/config/open-logs")
def open_log_directory():
    logs_dir = get_data_dir() / "logs"
    logs_dir.mkdir(parents=True, exist_ok=True)
    folder = str(logs_dir.resolve())
    return open_directory(folder, "无法自动打开日志目录，请手动复制路径。")


def _get_dir_size(path: Path) -> int:
    if not path.is_dir():
        return 0
    total = 0
    try:
        for entry in path.rglob("*"):
            if entry.is_file():
                try:
                    total += entry.stat().st_size
                except OSError:
                    pass
    except OSError:
        pass
    return total


def _format_size(byte_count: int) -> str:
    if byte_count < 1024:
        return f"{byte_count} B"
    if byte_count < 1024 * 1024:
        return f"{byte_count / 1024:.1f} KB"
    if byte_count < 1024 * 1024 * 1024:
        return f"{byte_count / (1024 * 1024):.1f} MB"
    return f"{byte_count / (1024 * 1024 * 1024):.2f} GB"


@router.get("/api/config/data-dir-info")
def get_data_dir_info():
    return build_data_dir_info(get_data_dir())


def build_data_dir_info(data_dir: Path) -> dict[str, Any]:
    size_bytes = _get_dir_size(data_dir)
    return {
        "path": str(data_dir.resolve()),
        "logs_path": str((data_dir / "logs").resolve()),
        "exists": data_dir.exists(),
        "size_bytes": size_bytes,
        "size_str": _format_size(size_bytes),
    }


@router.post("/api/config/detect-obs")
def detect_obs_path_save():
    path = detect_obs_path()
    if not path:
        raise HTTPException(
            404,
            "未找到 OBS（obs64.exe）。请确认已安装 OBS，或在 OBS 配置中心手动填写完整路径。",
        )
    cfg = load_config()
    cfg.obs.obs_path = path
    save_config(cfg)
    return {"obs_path": path}


@router.post("/api/config/test-llm")
async def test_llm_connection():
    cfg = load_config()
    llm = cfg.llm
    base_url_raw = (llm.base_url or "").strip()
    if base_url_raw and llm_base_url_is_local_host(base_url_raw):
        root = base_url_raw.rstrip("/").removesuffix("/v1").rstrip("/")
        probe_urls = list(dict.fromkeys((f"{root}/api/tags", f"{root}/v1/models")))

        def _ping_one(url: str) -> tuple[bool, str]:
            import urllib.error
            import urllib.request

            try:
                request = urllib.request.Request(url, headers={"Accept": "application/json"})  # noqa: S310
                with urllib.request.urlopen(request, timeout=4.0) as response:  # noqa: S310
                    return True, f"HTTP {response.getcode()} {url}"
            except urllib.error.HTTPError as exc:
                return False, f"HTTP {exc.code} {url}"
            except Exception as exc:  # noqa: BLE001
                return False, str(exc)[:200]

        def _ping_local() -> tuple[bool, str]:
            last_error = "无可用探测 URL"
            for url in probe_urls:
                ok, detail = _ping_one(url)
                if ok:
                    return True, detail
                last_error = detail
            return False, last_error

        ok, detail = await asyncio.to_thread(_ping_local)
        return {"ok": ok, "detail": detail}

    api_key = (llm.api_key or "").strip()
    if not llm_api_key_configured(llm.api_key):
        return {"ok": False, "detail": "请填写 API 密钥并保存后再测试。"}
    if api_key.startswith("****"):
        return {
            "ok": False,
            "detail": "配置文件中的密钥为脱敏占位（****…），请在设置中重新粘贴完整 API 密钥并保存后再测试。",
        }

    from openai import APIConnectionError, APIError, APITimeoutError, AsyncOpenAI, RateLimitError

    base_url = (llm.base_url or "").strip() or None
    model = (llm.model or "").strip() or "gpt-4o-mini"
    try:
        client = AsyncOpenAI(api_key=api_key, base_url=base_url, timeout=12.0)
        response = await asyncio.wait_for(
            client.chat.completions.create(
                model=model,
                messages=[{"role": "user", "content": "ping"}],
                max_tokens=2,
            ),
            timeout=18.0,
        )
        ok = bool(response.choices)
        return {"ok": ok, "detail": "连接成功" if ok else "未收到模型输出"}
    except asyncio.TimeoutError:
        return {"ok": False, "detail": "请求超时"}
    except (APIConnectionError, APITimeoutError, RateLimitError, APIError) as exc:
        return {"ok": False, "detail": str(exc)[:300]}
    except Exception as exc:  # noqa: BLE001
        logging.warning("test_llm: %s", exc)
        return {"ok": False, "detail": str(exc)[:300]}


@router.put("/api/config")
async def update_config(payload: ConfigPayload):
    cfg = load_config()
    if payload.obs:
        obs = payload.obs
        obs_fields = getattr(obs, "model_fields_set", set()) or set()
        cfg.obs.host = obs.host
        try:
            cfg.obs.port = int(obs.port)
        except (TypeError, ValueError):
            cfg.obs.port = obs.port if isinstance(obs.port, int) else cfg.obs.port
        raw_password = (obs.password or "").strip()
        if raw_password and not raw_password.startswith("****"):
            cfg.obs.password = raw_password
        if obs.obs_path is not None:
            cfg.obs.obs_path = str(obs.obs_path).strip()
        # 设置页已下线该开关；未显式传入时保留配置文件/API 调试值。
        if "browser_begin_frame_scheduling" in obs_fields:
            cfg.obs.browser_begin_frame_scheduling = bool(obs.browser_begin_frame_scheduling)
    if payload.llm:
        if payload.llm.api_key and not payload.llm.api_key.startswith("****"):
            cfg.llm = payload.llm
        else:
            cfg.llm.provider = payload.llm.provider
            cfg.llm.model = payload.llm.model
            if payload.llm.base_url is not None:
                cfg.llm.base_url = payload.llm.base_url
    if payload.cs2_path is not None:
        cfg.cs2_path = payload.cs2_path
    if payload.demo_directory is not None:
        cfg.demo_directory = str(payload.demo_directory or "").strip()
    if payload.demo_cache_directory is not None:
        # Path changes that need file migration go through /api/demo-cache/migrate.
        # Saving here only updates the setting when empty or already matching.
        cfg.demo_cache_directory = str(payload.demo_cache_directory or "").strip()
    if payload.demo_watch_paths is not None:
        cfg.demo_watch_paths = [
            str(Path(path).expanduser())
            for path in payload.demo_watch_paths
            if str(path).strip()
        ]
    if payload.demo_watch_scan_depth is not None:
        cfg.demo_watch_scan_depth = int(payload.demo_watch_scan_depth)
    if payload.ai_mode is not None:
        cfg.ai_mode = payload.ai_mode
    if payload.obs_agent_auto_prepare is not None:
        cfg.obs_agent_auto_prepare = bool(payload.obs_agent_auto_prepare)
    if payload.latency_calibration_enabled is not None:
        cfg.latency_calibration_enabled = bool(payload.latency_calibration_enabled)
    if payload.locale is not None and payload.locale in ("zh", "en", "auto"):
        cfg.locale = payload.locale
    if payload.expected_parse_players is not None:
        cleaned: list[str] = []
        for player in payload.expected_parse_players:
            if not isinstance(player, str):
                continue
            name = player.strip()
            if name and name not in cleaned:
                cleaned.append(name)
            if len(cleaned) >= 50:
                break
        cfg.expected_parse_players = cleaned
    if payload.ffmpeg_path is not None:
        cfg.ffmpeg_path = str(payload.ffmpeg_path).strip()
    if payload.montage_encoder is not None:
        cfg.montage_encoder = str(payload.montage_encoder).strip().lower() or "auto"
    if payload.recording_global_pacing is not None:
        cfg.recording_global_pacing = (
            dict(payload.recording_global_pacing)
            if isinstance(payload.recording_global_pacing, dict)
            else {}
        )
    if payload.default_record_warmup is not None:
        cfg.default_record_warmup = (
            dict(payload.default_record_warmup)
            if isinstance(payload.default_record_warmup, dict)
            else {}
        )
    if payload.cs2_extra_launch_args is not None:
        next_launch_args = str(payload.cs2_extra_launch_args)
        if payload.cs2_extra_launch_args_user_configured is not None:
            cfg.cs2_extra_launch_args = next_launch_args
            cfg.cs2_extra_launch_args_user_configured = bool(
                payload.cs2_extra_launch_args_user_configured
            )
        elif next_launch_args != cfg.cs2_extra_launch_args:
            cfg.cs2_extra_launch_args = next_launch_args
            cfg.cs2_extra_launch_args_user_configured = True
    elif payload.cs2_extra_launch_args_user_configured is not None:
        cfg.cs2_extra_launch_args_user_configured = bool(
            payload.cs2_extra_launch_args_user_configured
        )
    if payload.record_inject_console_lines is not None:
        next_inject_lines = str(payload.record_inject_console_lines)
        if payload.record_inject_console_lines_user_configured is not None:
            cfg.record_inject_console_lines = next_inject_lines
            cfg.record_inject_console_lines_user_configured = bool(
                payload.record_inject_console_lines_user_configured
            )
        elif next_inject_lines != cfg.record_inject_console_lines:
            cfg.record_inject_console_lines = next_inject_lines
            cfg.record_inject_console_lines_user_configured = True
    elif payload.record_inject_console_lines_user_configured is not None:
        cfg.record_inject_console_lines_user_configured = bool(
            payload.record_inject_console_lines_user_configured
        )
    if payload.obs_transition_enabled is not None:
        cfg.obs_transition_enabled = bool(payload.obs_transition_enabled)
    if payload.obs_transition_name is not None:
        cfg.obs_transition_name = str(payload.obs_transition_name).strip() or "Fade"
    if payload.obs_transition_duration_ms is not None:
        try:
            cfg.obs_transition_duration_ms = max(0, int(payload.obs_transition_duration_ms))
        except (TypeError, ValueError):
            pass
    if payload.kb_overlay_enabled is not None:
        cfg.kb_overlay_enabled = bool(payload.kb_overlay_enabled)
    if payload.kb_overlay_tick_offset is not None:
        try:
            cfg.kb_overlay_tick_offset = int(payload.kb_overlay_tick_offset)
        except (TypeError, ValueError):
            pass
    if payload.kb_overlay_position is not None:
        if str(payload.kb_overlay_position) in ("bottom_center", "minimap_below", "weapon_right"):
            cfg.kb_overlay_position = str(payload.kb_overlay_position)
    if payload.kill_fx_enabled is not None:
        cfg.kill_fx_enabled = bool(payload.kill_fx_enabled)
    if payload.kill_fx_tick_offset is not None:
        try:
            cfg.kill_fx_tick_offset = int(payload.kill_fx_tick_offset)
        except (TypeError, ValueError):
            pass
    if payload.experimental is not None and payload.experimental.pov_enabled is not None:
        cfg.experimental.pov_enabled = bool(payload.experimental.pov_enabled)
    if (
        payload.steam_api_key is not None
        and payload.steam_api_key
        and not payload.steam_api_key.startswith("****")
    ):
        cfg.steam_api_key = payload.steam_api_key.strip()
    if payload.steam_id64 is not None and payload.steam_id64:
        cfg.steam_id64 = payload.steam_id64.strip()
    if payload.steam_cdn_assets_enabled is not None:
        cfg.steam_cdn_assets_enabled = bool(payload.steam_cdn_assets_enabled)
    if payload.match_mode is not None and payload.match_mode in ("premier", "competitive"):
        cfg.match_mode = payload.match_mode
    if payload.match_count is not None and payload.match_count in (20, 50, 100):
        cfg.match_count = payload.match_count
    if payload.update_check_frequency is not None:
        frequency = str(payload.update_check_frequency).strip().lower()
        if frequency in ("weekly", "monthly", "never"):
            cfg.update_check_frequency = frequency
    if payload.last_update_check_at is not None:
        cfg.last_update_check_at = str(payload.last_update_check_at).strip()
    save_config(cfg)

    watcher = application_state.demo_watcher
    if watcher is not None and (
        payload.demo_watch_paths is not None or payload.demo_watch_scan_depth is not None
    ):
        watcher.configure(cfg.demo_watch_paths or [], cfg.demo_watch_scan_depth)
    return {"status": "ok"}


@router.get("/api/experimental/pov/status")
def experimental_pov_status():
    from ..pov_hud_manager import PovHudError, PovHudManager

    cfg = ensure_cs2_path(load_config())
    try:
        status = PovHudManager(cfg).status()
    except PovHudError as exc:
        raise HTTPException(400, str(exc)) from exc
    status["enabled"] = bool(cfg.experimental.pov_enabled)
    return status


@router.post("/api/experimental/pov/restore")
def experimental_pov_restore():
    from ..pov_hud_manager import PovHudError, PovHudManager

    cfg = ensure_cs2_path(load_config())
    try:
        verification = PovHudManager(cfg).restore()
    except PovHudError as exc:
        raise HTTPException(400, str(exc)) from exc
    return {"ok": bool(verification.get("verified")), "restore": verification}


class DemoCacheMigrateBody(BaseModel):
    destination: str = Field(..., min_length=1)


@router.get("/api/demo-cache")
async def get_demo_cache_status():
    from ..databases import demo_db
    from ..demo_cache import cache_status_payload

    coverage = await demo_db.demo_cache_coverage()
    return cache_status_payload(coverage)


@router.post("/api/demo-cache/migrate")
async def migrate_demo_cache(body: DemoCacheMigrateBody):
    from ..databases import demo_db
    from ..demo_cache import migrate_demo_cache_root

    try:
        result = await migrate_demo_cache_root(demo_db, body.destination)
    except ValueError as exc:
        raise HTTPException(400, str(exc)) from exc
    except RuntimeError as exc:
        raise HTTPException(409, str(exc)) from exc
    except OSError as exc:
        raise HTTPException(500, f"缓存迁移失败：{exc}") from exc
    return {"ok": True, **result}


@router.post("/api/demo-cache/clear")
async def clear_demo_cache_endpoint():
    from ..databases import demo_db
    from ..demo_cache import clear_demo_cache

    try:
        result = await clear_demo_cache(demo_db)
    except OSError as exc:
        raise HTTPException(500, f"清除缓存失败：{exc}") from exc
    return {"ok": True, **result}
