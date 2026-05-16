import asyncio
import logging
from dataclasses import dataclass, field
from typing import Optional

from ..models import RecordingPlan
from .obs_client import OBSClient, OBSRecordError
from .demo_controller import gototick, demo_resume, demo_pause, DemoSeekError
from .spec_controller import spec_player
from .gsi_verifier import verify_spec_target

logger = logging.getLogger(__name__)


@dataclass
class SegmentResult:
    segment_index: int
    status: str  # "ok" | "seek_failed" | "spec_failed" | "skipped"
    start_tick: int
    end_tick: int
    perspective: str
    output_path: Optional[str] = None
    error: Optional[str] = None


@dataclass
class ExecutionResult:
    request_id: str
    output_path: Optional[str] = None
    segment_results: list[SegmentResult] = field(default_factory=list)
    warnings: list[str] = field(default_factory=list)
    success: bool = False
    error: Optional[str] = None


class RecordingExecutor:
    def __init__(self, obs_client: OBSClient):
        self._obs = obs_client

    async def execute(self, plan: RecordingPlan) -> ExecutionResult:
        result = ExecutionResult(request_id=plan.request_id)
        active_segments = [s for s in plan.segments if not s.disabled]

        if not active_segments:
            result.warnings.append("No active segments to record")
            result.success = True
            return result

        obs_recording_started = False
        final_output_path: Optional[str] = None

        for i, segment in enumerate(active_segments):
            is_last = (i == len(active_segments) - 1)

            seek_tick = segment.safe_seek_tick
            try:
                await gototick(seek_tick)
            except DemoSeekError as e:
                result.segment_results.append(SegmentResult(
                    segment_index=segment.segment_index,
                    status="seek_failed",
                    start_tick=segment.start_tick,
                    end_tick=segment.end_tick,
                    perspective=segment.perspective,
                    error=str(e),
                ))
                continue

            if segment.target_steamid64:
                await spec_player(segment.target_player_name)
                verified = await verify_spec_target(segment.target_steamid64)
                if not verified:
                    result.segment_results.append(SegmentResult(
                        segment_index=segment.segment_index,
                        status="spec_failed",
                        start_tick=segment.start_tick,
                        end_tick=segment.end_tick,
                        perspective=segment.perspective,
                        error=f"GSI verify failed for {segment.target_steamid64}",
                    ))
                    continue

            duration_sec = max(0.1, (segment.end_tick - segment.start_tick) / plan.tick_rate)

            try:
                if not obs_recording_started:
                    await demo_resume()
                    await asyncio.sleep(0.1)
                    await asyncio.to_thread(self._obs.start_record)
                    obs_recording_started = True
                else:
                    await demo_resume()
                    await asyncio.sleep(0.1)
                    await asyncio.to_thread(self._obs.resume_record)

                await asyncio.sleep(duration_sec)

                if is_last:
                    output_path = await asyncio.to_thread(self._obs.stop_record)
                    final_output_path = output_path
                    await asyncio.to_thread(self._obs.disconnect)
                else:
                    await asyncio.to_thread(self._obs.pause_record)
                    await asyncio.sleep(0.08)  # brief settle after pause
                    await demo_pause()

            except (OBSRecordError, Exception) as e:
                logger.error("Segment %d record error: %s", segment.segment_index, e)
                result.segment_results.append(SegmentResult(
                    segment_index=segment.segment_index,
                    status="skipped",
                    start_tick=segment.start_tick,
                    end_tick=segment.end_tick,
                    perspective=segment.perspective,
                    error=str(e),
                ))
                if obs_recording_started:
                    try:
                        await asyncio.to_thread(self._obs.stop_record)
                    except Exception:
                        pass
                    obs_recording_started = False
                continue

            result.segment_results.append(SegmentResult(
                segment_index=segment.segment_index,
                status="ok",
                start_tick=segment.start_tick,
                end_tick=segment.end_tick,
                perspective=segment.perspective,
                output_path=final_output_path if is_last else None,
            ))

        result.output_path = final_output_path
        result.success = any(r.status == "ok" for r in result.segment_results)
        result.warnings.extend(plan.warnings)
        return result
