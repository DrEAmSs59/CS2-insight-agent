import asyncio
import logging

from fastapi import APIRouter, HTTPException
from .models import RecordingRequestDTO, RecordingPlan
from .plan_builder import build_plan
from .normalizer import NormalizationError
from ..env_utils import OBSConfig, load_config
from .executor.obs_client import OBSClient, OBSConnectionError
from .executor.recording_executor import RecordingExecutor, ExecutionResult
from .services.result_writer import write_result

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
