import asyncio
import logging
from typing import Optional

from fastapi import APIRouter, HTTPException
from pydantic import BaseModel
from .models import RecordingRequestDTO, RecordingPlan
from .plan_builder import build_plan
from .normalizer import NormalizationError
from ..env_utils import OBSConfig, load_config, ensure_cs2_path
from .executor.obs_client import OBSClient, OBSConnectionError
from .executor.recording_executor import RecordingExecutor, ExecutionResult
from .services.result_writer import write_result

logger = logging.getLogger(__name__)
router = APIRouter(prefix="/api/recording", tags=["recording"])

# Module-level abort event for the V3 queue; set when a queue is running, cleared in finally.
_queue_abort_event: Optional[asyncio.Event] = None


def get_queue_abort_event() -> Optional[asyncio.Event]:
    """Return the current V3 queue abort event, or None if idle."""
    return _queue_abort_event

@router.post("/plan", response_model=dict)
async def create_recording_plan(dto: RecordingRequestDTO) -> dict:
    try:
        plan = build_plan(dto)
    except NormalizationError as e:
        raise HTTPException(status_code=422, detail=str(e))
    except ValueError as e:
        raise HTTPException(status_code=400, detail=str(e))

    # Compute per-segment debug metadata for UI display
    def _seg_debug(s):
        meta: dict = dict(s.metadata)
        meta["anchor_preserved"] = (
            s.is_final_round
            and bool(s.anchor_ticks)
            and any("guard_skipped" in w or "anchor_preserved" in w for w in plan.warnings
                    if f"segment {s.segment_index}:" in w)
        )
        meta["demo_exit_guard_applied"] = (
            s.is_final_round and s.safe_end_tick is not None
        )
        meta["target_steamid64_missing"] = not bool(s.target_steamid64)
        return {
            "segment_index": s.segment_index,
            "source_type": s.source_type,
            "perspective": s.perspective,
            "start_tick": s.start_tick,
            "end_tick": s.end_tick,
            "anchor_ticks": s.anchor_ticks,
            "safe_seek_tick": s.safe_seek_tick,
            "safe_end_tick": s.safe_end_tick,
            "round": s.round,
            "is_final_round": s.is_final_round,
            "target_player_name": s.target_player_name,
            "target_steamid64": s.target_steamid64,
            "disabled": s.disabled,
            "disabled_reason": s.disabled_reason,
            **meta,
        }

    return {
        "request_id": plan.request_id,
        "request_type": plan.request_type,
        "demo_path": plan.demo_path,
        "tick_rate": plan.tick_rate,
        "estimated_duration_sec": plan.estimated_duration_sec,
        "warnings": plan.warnings,
        "active_segments": [_seg_debug(s) for s in plan.segments],
        "disabled_segments": [_seg_debug(s) for s in plan.disabled_segments],
        "summary": {
            "active_count": len(plan.segments),
            "disabled_count": len(plan.disabled_segments),
            "final_round_segments": sum(1 for s in plan.segments if s.is_final_round),
            "victim_segments_disabled_no_steamid": sum(
                1 for s in plan.disabled_segments
                if s.disabled_reason == "missing_victim_steamid64"
            ),
            "guard_skipped_warnings": sum(
                1 for w in plan.warnings if "guard_skipped" in w
            ),
        },
    }


@router.post("/execute", response_model=dict)
async def execute_recording(dto: RecordingRequestDTO) -> dict:
    """
    Build a RecordingPlan and execute it using OBS + CS2.
    Returns execution result summary.
    """
    try:
        plan = build_plan(dto)
    except NormalizationError as e:
        raise HTTPException(status_code=422, detail=str(e))
    except ValueError as e:
        raise HTTPException(status_code=400, detail=str(e))

    config = load_config()
    obs_cfg = config.obs if hasattr(config, "obs") else OBSConfig()
    obs_client = OBSClient(obs_cfg)

    try:
        obs_client.connect()
    except OBSConnectionError as e:
        raise HTTPException(status_code=503, detail=f"OBS connection failed: {e}")

    executor = RecordingExecutor(obs_client)
    result = await executor.execute(plan)

    try:
        write_result(result)
    except Exception as e:
        logging.getLogger(__name__).warning("Failed to write result: %s", e)

    return {
        "success": result.success,
        "request_id": result.request_id,
        "output_path": result.output_path,
        "warnings": result.warnings,
        "error": result.error,
        "segments": [
            {
                "segment_index": s.segment_index,
                "status": s.status,
                "error": s.error,
            }
            for s in result.segment_results
        ],
    }


class QueueRecordingRequest(BaseModel):
    requests: list[RecordingRequestDTO]
    warmup: Optional[dict] = None
    obs: Optional[dict] = None
    pov_hud: Optional[dict] = None  # {enabled: bool, radar_mode: int, teamcounter_numeric: bool}


@router.post("/queue", response_model=list[dict])
async def execute_recording_queue(req: QueueRecordingRequest) -> list[dict]:
    """
    [RecordingV3] Execute a batch of RecordingRequestDTOs through the new
    build_plan → RecordingExecutor pipeline.

    Groups requests by demo path (one CS2 session per unique demo), launches
    CS2 via OBSDirector infrastructure, then records each plan segment using
    the new RecordingExecutor.
    """
    import tempfile
    from pathlib import Path
    from ..obs_director import OBSDirector, CS2AlreadyRunningError, CS2NotReadyError, RecordingWarmupExtras
    from ..cs2_config_backup import is_cs2_running, is_restore_required

    def _resolve_demo_path(p: str) -> Path:
        raw = (p or "").strip()
        if not raw:
            raise HTTPException(400, "Demo 路径为空")
        cand = Path(raw)
        if cand.is_file():
            return cand.resolve()
        upload_dir = Path(tempfile.gettempdir()) / "cs2_insight_demos"
        dest = (upload_dir / cand.name).resolve()
        if dest.is_file():
            return dest
        raise HTTPException(404, f"未找到 Demo 文件: {raw}")

    def _merge_obs(payload: Optional[OBSConfig], saved: OBSConfig) -> OBSConfig:
        if payload is None:
            return saved
        host = (payload.host or "").strip() or saved.host
        try:
            port = int(payload.port)
        except (TypeError, ValueError):
            port = int(saved.port) if isinstance(saved.port, int) else saved.port
        raw_pw = (payload.password or "").strip()
        if raw_pw.startswith("****"):
            raw_pw = ""
        password = raw_pw if raw_pw else saved.password
        return OBSConfig(host=host, port=port, password=password)

    logger.info("[RecordingV3] /queue received %d requests", len(req.requests))

    if not req.requests:
        return []

    cfg = load_config()
    cfg = ensure_cs2_path(cfg)

    if not cfg.cs2_path:
        raise HTTPException(
            400,
            "未配置 CS2 路径且自动探测失败。请在左侧「CS2 路径」中填写 cs2.exe 完整路径，或点击「自动探测」。",
        )
    if is_cs2_running():
        raise HTTPException(409, "CS2 正在运行，请先关闭 CS2 再开始录制。")
    if is_restore_required():
        raise HTTPException(
            409,
            "检测到上次录制可能异常退出，玩家配置尚未恢复。请先点击「一键恢复玩家配置」，恢复完成后再开始新的录制。",
        )

    # Resolve OBS config (merge request-level obs override with saved config).
    obs_cfg_override = None
    if req.obs:
        try:
            obs_cfg_override = OBSConfig(**req.obs)
        except Exception:
            pass
    obs_cfg = _merge_obs(obs_cfg_override, cfg.obs)

    # Resolve demo paths: replace filename/relative refs with absolute paths.
    resolved_requests = []
    for dto in req.requests:
        try:
            abs_path = _resolve_demo_path(dto.demo.demo_path or dto.demo.demo_filename)
        except HTTPException as e:
            logger.warning("[RecordingV3] demo not found for request %s: %s", dto.request_id, e.detail)
            resolved_requests.append(dto)  # keep as-is; executor will fail gracefully
            continue
        # Replace demo_path with resolved absolute path
        updated_demo = dto.demo.model_copy(update={"demo_path": str(abs_path)})
        resolved_requests.append(dto.model_copy(update={"demo": updated_demo}))

    # Build warmup extras from request warmup dict.
    # Merge pov_hud fields into warmup_extras so execute_plan_queue sees them.
    warmup_extras = None
    if req.warmup:
        try:
            warmup_extras = RecordingWarmupExtras(**req.warmup)
        except Exception as e:
            logger.warning("[RecordingV3] warmup parse failed: %s", e)

    if req.pov_hud and req.pov_hud.get("enabled"):
        pov_hud_cfg = req.pov_hud
        if warmup_extras is None:
            warmup_extras = RecordingWarmupExtras()
        # Patch warmup extras with POV HUD settings
        import dataclasses
        warmup_extras = dataclasses.replace(
            warmup_extras,
            pov_hud_enabled=True,
            pov_radar_mode=int(pov_hud_cfg.get("radar_mode", 0)),
            pov_teamcounter_numeric=bool(pov_hud_cfg.get("teamcounter_numeric", False)),
        )
        logger.info("[RecordingV3] POV HUD enabled: radar_mode=%s, teamcounter_numeric=%s",
                    warmup_extras.pov_radar_mode, warmup_extras.pov_teamcounter_numeric)

    global _queue_abort_event
    if _queue_abort_event is not None:
        raise HTTPException(409, "已有录制任务进行中，请先中止或等待结束。")

    abort_ev = asyncio.Event()
    _queue_abort_event = abort_ev

    director = OBSDirector(
        obs_cfg,
        cfg.cs2_path,
        abort_event=abort_ev,
        cs2_extra_launch_args=cfg.cs2_extra_launch_args,
        record_inject_console_lines=cfg.record_inject_console_lines,
        spec_player_verify=cfg.spec_player_verify,
    )

    try:
        results = await director.execute_plan_queue(resolved_requests, warmup=warmup_extras)
    except CS2AlreadyRunningError as e:
        raise HTTPException(409, str(e)) from e
    except CS2NotReadyError as e:
        raise HTTPException(409, str(e)) from e
    except Exception as e:
        logger.exception("[RecordingV3] execute_plan_queue failed")
        raise HTTPException(500, f"录制失败: {e}") from e
    finally:
        _queue_abort_event = None

    return results
