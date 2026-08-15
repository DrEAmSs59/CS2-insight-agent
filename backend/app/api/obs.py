"""OBS discovery, setup, tuning and configuration API routes."""

from __future__ import annotations

import asyncio
import logging
import os
import shutil
import subprocess
import threading
import time
from pathlib import Path
from typing import Optional

from fastapi import APIRouter, Body, Depends, HTTPException

from .. import obs_config_center
from ..env_utils import (
    AppConfig,
    OBSConfig,
    detect_obs_path,
    ensure_cs2_path,
    llm_api_key_configured,
    llm_base_url_is_local_host,
    load_config,
    minimize_obs_window,
    save_config,
)
from ..obs_bootstrap import (
    ObsBootstrapRequest,
    bootstrap_obs_environment,
    make_obs_launcher,
    obs_launch_args,
)
from ..obs_tuning import (
    ObsTuningApplyRequest,
    ObsTuningPlanRequest,
    ObsTuningRecommendationRequest,
    build_change_plan as build_obs_tuning_plan,
    discover_environment as discover_obs_tuning_environment,
    recommend as recommend_obs_tuning_goal,
)
from ..obs_tuning_agent import review_tuning_plan
from ..obs_tuning_executor import apply_video_tuning_plan
from ..runtime_session import runtime_session_dependency

router = APIRouter(tags=["obs"])
logger = logging.getLogger(__name__)

# React StrictMode can send duplicate checks. Serialize all operations that may
# launch or reconfigure OBS so those requests cannot start competing processes.
_obs_launch_lock = threading.Lock()


def merge_obs_for_connection(payload: Optional[OBSConfig], saved: OBSConfig) -> OBSConfig:
    """Merge a request's public OBS fields with the stored password and defaults."""
    if payload is None:
        return saved
    host = (payload.host or "").strip() or saved.host
    try:
        port = int(payload.port)
    except (TypeError, ValueError):
        port = int(saved.port) if isinstance(saved.port, int) else saved.port
    raw_password = (payload.password or "").strip()
    if raw_password.startswith("****"):
        raw_password = ""
    password = raw_password if raw_password else saved.password
    return OBSConfig(host=host, port=port, password=password)


def _normalize_obs_path_auto_detect(cfg: AppConfig) -> None:
    if cfg.obs.obs_path and Path(cfg.obs.obs_path).is_file():
        return
    detected = detect_obs_path()
    if detected:
        cfg.obs.obs_path = detected


def _setup_status_obs_handshake_timeout_sec() -> float:
    raw = (os.environ.get("CS2_INSIGHT_SETUP_OBS_PROBE_SEC") or "").strip()
    if raw:
        try:
            return max(0.5, min(float(raw), 60.0))
        except ValueError:
            pass
    return 4.0


def _configured_ffmpeg_toolkit_report(raw_path: str) -> dict[str, object]:
    from ..ffmpeg_compatibility import inspect_ffmpeg_toolkit
    from ..framemeld import probe_framemeld
    from ..video_composer import MontageComposerError, resolve_ffmpeg_binary

    raw = str(raw_path or "").strip()
    if not raw:
        return {
            "ok": False,
            "reason": "not_configured",
            "ffmpeg_path": "",
            "framemeld_available": False,
        }
    if not Path(raw).is_file():
        return {
            "ok": False,
            "reason": "path_not_found",
            "ffmpeg_path": raw,
            "framemeld_available": False,
        }
    try:
        ffmpeg_bin = resolve_ffmpeg_binary(raw)
    except MontageComposerError:
        return {
            "ok": False,
            "reason": "not_usable",
            "ffmpeg_path": raw,
            "framemeld_available": False,
        }
    report = inspect_ffmpeg_toolkit(ffmpeg_bin)
    capability = probe_framemeld(ffmpeg_bin) if report.get("ok") else None
    return {
        **report,
        "framemeld_available": capability is not None,
        "framemeld_route": capability.route if capability is not None else None,
        "framemeld_api_version": capability.api_version if capability is not None else None,
    }


@router.get("/api/config/quick-check")
def config_quick_check():
    """Return setup flags without opening an OBS WebSocket connection."""
    cfg = ensure_cs2_path(load_config())
    obs_path = str(cfg.obs.obs_path or "").strip()
    obs_configured = bool(
        cfg.obs.obs_config_verified
        and obs_path
        and Path(obs_path).is_file()
    )
    cs2_path_ok = bool(cfg.cs2_path and Path(cfg.cs2_path).is_file())
    ffmpeg_ok = bool(_configured_ffmpeg_toolkit_report(cfg.ffmpeg_path).get("ok"))
    ai_key_ok = llm_api_key_configured(cfg.llm.api_key) or llm_base_url_is_local_host(
        cfg.llm.base_url
    )
    return {
        "obs_configured": obs_configured,
        "cs2_path_ok": cs2_path_ok,
        "ffmpeg_ok": ffmpeg_ok,
        "ai_key_ok": ai_key_ok,
        "cs2_path": cfg.cs2_path or "",
        "ffmpeg_path": cfg.ffmpeg_path or "",
    }


@router.get("/api/config/ffmpeg-check")
def ffmpeg_montage_gate_check():
    return _configured_ffmpeg_toolkit_report(load_config().ffmpeg_path)


@router.get("/api/status/setup")
def setup_status():
    """Run the full setup check, including a real OBS WebSocket handshake."""
    from ..obs_director import OBSDirector
    cfg = ensure_cs2_path(load_config())
    cs2_path_ok = bool(cfg.cs2_path and Path(cfg.cs2_path).is_file())
    ffmpeg_ok = bool(_configured_ffmpeg_toolkit_report(cfg.ffmpeg_path).get("ok"))
    ai_key_ok = llm_api_key_configured(cfg.llm.api_key) or llm_base_url_is_local_host(
        cfg.llm.base_url
    )

    obs_connected = False
    try:
        director = OBSDirector(
            cfg.obs,
            cfg.cs2_path,
            cs2_extra_launch_args=cfg.cs2_extra_launch_args,
            record_inject_console_lines=cfg.record_inject_console_lines,
        )
        result = director.test_obs_connection(
            handshake_timeout_sec=_setup_status_obs_handshake_timeout_sec()
        )
        obs_connected = bool(result.get("ok", False))
        if obs_connected:
            _normalize_obs_path_auto_detect(cfg)
            cfg.obs.obs_config_verified = True
            save_config(cfg)
    except Exception:
        obs_connected = False

    return {
        "obs_connected": obs_connected,
        "cs2_path_ok": cs2_path_ok,
        "ffmpeg_ok": ffmpeg_ok,
        "ai_key_ok": ai_key_ok,
        "cs2_path": cfg.cs2_path or "",
        "ffmpeg_path": cfg.ffmpeg_path or "",
    }


@router.post("/api/obs/config-check")
def obs_config_check(payload: OBSConfig | None = Body(default=None)):
    """Validate the OBS path, launch it if needed, then test WebSocket access."""
    cfg = load_config()
    obs_use = merge_obs_for_connection(payload, cfg.obs)
    obs_path = (obs_use.obs_path or cfg.obs.obs_path or "").strip()
    logger.info("[OBS config-check] obs_path=%r", obs_path)

    launched_obs = False
    if obs_path and Path(obs_path).is_file():
        with _obs_launch_lock:
            running = _is_obs_process_running(obs_path)
            logger.info("[OBS config-check] Path OK, OBS already running=%s", running)
            if not running:
                logger.info("[OBS config-check] Launching OBS: %s", obs_path)
                try:
                    make_obs_launcher(obs_launch_args(cfg))(obs_path)
                    launched_obs = True
                    for _attempt in range(30):
                        if _is_obs_process_running(obs_path):
                            break
                        time.sleep(0.5)
                    else:
                        logger.warning("[OBS config-check] OBS did not appear after 15s; continuing anyway")
                    time.sleep(1)
                except Exception as exc:
                    logger.error("[OBS config-check] Failed to launch OBS: %s", exc)
                    return {"path_ok": False, "error": f"无法启动 OBS: {exc}"}
    elif obs_path:
        logger.warning("[OBS config-check] Path configured but file not found: %s", obs_path)
        return {"path_ok": False, "error": "OBS 路径不存在"}
    else:
        logger.info("[OBS config-check] No obs_path configured, skipping launch")
        return {
            "path_ok": False,
            "connected": False,
            "error": "请先配置 OBS 路径，再点击配置检查",
        }

    connected = False
    try:
        from ..obs_director import OBSDirector

        director = OBSDirector(obs_use, cfg.cs2_path)
        for _attempt in range(15):
            result = director.test_obs_connection()
            if result.get("ok"):
                connected = True
                break
            time.sleep(1)
        else:
            logger.warning("[OBS config-check] WebSocket connection failed after 15 retries")
        if connected:
            _normalize_obs_path_auto_detect(cfg)
            cfg.obs.obs_config_verified = True
            save_config(cfg)
    except Exception as exc:
        logger.warning("[OBS config-check] OBS connection test exception: %s", exc)

    if connected:
        minimize_obs_window()
    return {
        "path_ok": True,
        "connected": connected,
        "launched_obs": launched_obs,
    }


def _is_obs_process_running(obs_path: str) -> bool:
    try:
        executable_name = Path(obs_path).name
        result = subprocess.run(
            ["tasklist", "/FI", f"IMAGENAME eq {executable_name}", "/NH", "/FO", "CSV"],
            capture_output=True,
            text=True,
            timeout=10,
        )
        return executable_name.lower() in result.stdout.lower()
    except Exception:
        return False


@router.post("/api/obs/is-running")
def obs_is_running():
    obs_path = (load_config().obs.obs_path or "").strip()
    running = _is_obs_process_running(obs_path) if obs_path else False
    return {"running": running, "obs_path": obs_path}


@router.post("/api/obs/launch")
def obs_launch():
    cfg = load_config()
    obs_path = (cfg.obs.obs_path or "").strip()
    if not obs_path or not Path(obs_path).is_file():
        raise HTTPException(400, "OBS 路径未配置或文件不存在")
    try:
        make_obs_launcher(obs_launch_args(cfg))(obs_path)
        time.sleep(2)
    except Exception as exc:
        raise HTTPException(400, f"无法启动 OBS: {exc}") from exc
    return {"ok": True}


@router.get("/api/obs-config/status")
def obs_config_status():
    return obs_config_center.get_status_payload(load_config().obs)


@router.get("/api/obs-tuning/discovery")
def obs_tuning_discovery():
    cfg = load_config()
    payload = discover_obs_tuning_environment(cfg)
    payload["ai_mode_enabled"] = bool(cfg.ai_mode)
    payload["auto_prepare_enabled"] = bool(cfg.obs_agent_auto_prepare)
    return payload


@router.post("/api/obs-tuning/bootstrap")
def obs_tuning_bootstrap(payload: ObsBootstrapRequest):
    with _obs_launch_lock:
        return bootstrap_obs_environment(load_config(), payload)


@router.post("/api/obs-tuning/recommendation")
def obs_tuning_recommendation(payload: ObsTuningRecommendationRequest):
    cfg = load_config()
    discovery = payload.discovery or discover_obs_tuning_environment(cfg)
    return recommend_obs_tuning_goal(payload.goal, discovery)


@router.post("/api/obs-tuning/plan")
async def obs_tuning_plan(payload: ObsTuningPlanRequest):
    cfg = load_config()
    discovery = await asyncio.to_thread(discover_obs_tuning_environment, cfg)
    recommendation = recommend_obs_tuning_goal(payload.goal, discovery)
    plan = build_obs_tuning_plan(payload.goal, discovery, recommendation)
    plan["ai_review"] = await review_tuning_plan(
        cfg.llm, payload.goal, discovery, recommendation
    )
    return plan


@router.post("/api/obs-tuning/apply")
def obs_tuning_apply(
    payload: ObsTuningApplyRequest,
    _runtime_session: None = Depends(runtime_session_dependency),
):
    if not _obs_launch_lock.acquire(timeout=5.0):
        raise HTTPException(409, "上一次 OBS 自动设置仍在收尾，请稍等几秒后重新检查；不会重复开始录制。")
    try:
        return apply_video_tuning_plan(load_config(), payload)
    finally:
        _obs_launch_lock.release()


@router.post("/api/obs-config/diagnose")
def obs_config_diagnose(payload: Optional[OBSConfig] = Body(default=None)):
    cfg = load_config()
    return obs_config_center.diagnose(merge_obs_for_connection(payload, cfg.obs))


@router.post("/api/obs-config/calibrate")
def obs_config_calibrate():
    try:
        return obs_config_center.calibrate(load_config().obs)
    except ValueError as exc:
        raise HTTPException(400, str(exc)) from exc


@router.get("/api/obs-config/backups")
def obs_config_backups_list():
    return {"ok": True, "items": obs_config_center.list_backups()}


@router.post("/api/obs-config/backups/{backup_id}/restore")
def obs_config_restore_backup(
    backup_id: str,
    payload: Optional[OBSConfig] = Body(default=None),
):
    cfg = load_config()
    try:
        return obs_config_center.restore_backup(
            backup_id, merge_obs_for_connection(payload, cfg.obs)
        )
    except ValueError as exc:
        raise HTTPException(400, str(exc)) from exc


@router.delete("/api/obs-config/backups/{backup_id}")
def obs_config_delete_backup(backup_id: str):
    try:
        return obs_config_center.delete_backup(backup_id)
    except ValueError as exc:
        raise HTTPException(400, str(exc)) from exc


@router.post("/api/obs-config/backups/open-folder")
def obs_config_open_backup_folder():
    return obs_config_center.open_backup_folder()
