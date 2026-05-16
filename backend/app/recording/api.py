from fastapi import APIRouter, HTTPException
from .models import RecordingRequestDTO, RecordingPlan
from .plan_builder import build_plan
from .normalizer import NormalizationError

router = APIRouter(prefix="/api/recording", tags=["recording"])

@router.post("/plan", response_model=RecordingPlan)
async def create_recording_plan(dto: RecordingRequestDTO) -> RecordingPlan:
    try:
        return build_plan(dto)
    except NormalizationError as e:
        raise HTTPException(status_code=422, detail=str(e))
    except ValueError as e:
        raise HTTPException(status_code=400, detail=str(e))
