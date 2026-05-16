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

@router.post("/plan", response_model=RecordingPlan)
async def create_recording_plan(dto: RecordingRequestDTO) -> RecordingPlan:
    try:
        return build_plan(dto)
    except NormalizationError as e:
        raise HTTPException(status_code=422, detail=str(e))
    except ValueError as e:
        raise HTTPException(status_code=400, detail=str(e))


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
    warmup_extras = None
    if req.warmup:
        try:
            warmup_extras = RecordingWarmupExtras(**req.warmup)
        except Exception as e:
            logger.warning("[RecordingV3] warmup parse failed: %s", e)

    director = OBSDirector(
        obs_cfg,
        cfg.cs2_path,
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

    return results
