import asyncio
import logging
import time
from dataclasses import dataclass, field
from typing import Optional

from ..models import RecordingPlan, RecordingSegment, Perspective
from .obs_client import OBSClient, OBSRecordError
from .demo_controller import gototick, demo_resume, demo_pause, DemoSeekError
from .spec_controller import spec_player
from .gsi_verifier import verify_spec_target

logger = logging.getLogger(__name__)


async def _record_until_tick(
    segment: RecordingSegment,
    tick_rate: float,
    abort_event: Optional[asyncio.Event] = None,
    *,
    overhead_sec: float = 0.0,
) -> str:
    """
    Wait until the demo reaches segment.end_tick, then return "done".
    Checks abort_event every second so the recording can be interrupted mid-sleep.

    overhead_sec: time already elapsed (spec switch + preroll) since demo_resume.
    The demo has been running during that overhead, so the recording window shrinks by that amount.
    """
    base_duration = (segment.end_tick - segment.start_tick) / tick_rate
    duration_sec = max(0.1, base_duration - overhead_sec)
    logger.debug(
        "[RecordingV3] record_until_tick: base=%.2fs overhead=%.2fs sleeping=%.2fs",
        base_duration, overhead_sec, duration_sec,
    )
    elapsed = 0.0
    chunk = 1.0
    while elapsed < duration_sec:
        if abort_event and abort_event.is_set():
            logger.info("[RecordingV3] record_until_tick: abort signalled at %.2fs / %.2fs", elapsed, duration_sec)
            return "aborted"
        await asyncio.sleep(min(chunk, duration_sec - elapsed))
        elapsed += chunk
    return "sleep_fallback"


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
    def __init__(self, obs_client: OBSClient, abort_event: Optional[asyncio.Event] = None):
        self._obs = obs_client
        self._abort_event = abort_event

    def _is_aborted(self) -> bool:
        return self._abort_event is not None and self._abort_event.is_set()

    async def execute(self, plan: RecordingPlan) -> ExecutionResult:
        result = ExecutionResult(request_id=plan.request_id)
        active_segments = [s for s in plan.segments if not s.disabled]

        logger.info(
            "[RecordingV3] execute: %d active segment(s) for request %s",
            len(active_segments), plan.request_id,
        )
        for s in active_segments:
            logger.info(
                "[RecordingV3]   seg %d: perspective=%s player=%r steamid=%s "
                "ticks=%d-%d final_round=%s",
                s.segment_index, s.perspective, s.target_player_name,
                s.target_steamid64 or "(empty)", s.start_tick, s.end_tick, s.is_final_round,
            )

        if not active_segments:
            result.warnings.append("No active segments to record")
            result.success = True
            return result

        obs_recording_started = False
        final_output_path: Optional[str] = None

        for i, segment in enumerate(active_segments):
            if self._is_aborted():
                logger.info("[RecordingV3] abort signalled before segment %d; stopping", segment.segment_index)
                break

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

            # Pre-roll: ticks from seek_tick to segment start_tick that run before OBS starts
            pre_roll_sec = max(0.0, (segment.start_tick - seek_tick) / plan.tick_rate)

            try:
                # Resume demo first — spec_player only takes effect while demo is running
                await demo_resume()

                spec_elapsed = 0.0
                if segment.target_steamid64:
                    spec_t0 = time.monotonic()
                    await spec_player(segment.target_player_name)
                    verified = await verify_spec_target(segment.target_steamid64)
                    spec_elapsed = time.monotonic() - spec_t0

                    if verified is False:
                        # GSI confirmed we are on the wrong player — abort this recording
                        logger.error(
                            "[RecordingV3] spec verify confirmed WRONG PLAYER for %s (steamid=%s); aborting recording",
                            segment.target_player_name, segment.target_steamid64,
                        )
                        await demo_pause()
                        result.segment_results.append(SegmentResult(
                            segment_index=segment.segment_index,
                            status="spec_failed",
                            start_tick=segment.start_tick,
                            end_tick=segment.end_tick,
                            perspective=segment.perspective,
                            error=f"spec confirm: wrong player spectated for {segment.target_player_name}",
                        ))
                        result.error = (
                            f"spec verify failed for {segment.target_player_name} — "
                            "recording aborted to avoid capturing wrong POV"
                        )
                        if obs_recording_started:
                            try:
                                final_output_path = await asyncio.to_thread(self._obs.stop_record)
                            except Exception:
                                pass
                        result.output_path = final_output_path
                        result.success = any(r.status == "ok" for r in result.segment_results)
                        result.warnings.extend(plan.warnings)
                        return result

                    elif verified is None:
                        # GSI still silent after demo resumed — unusual; proceed with warning
                        logger.warning(
                            "[RecordingV3] spec verify inconclusive for %s (steamid=%s); "
                            "GSI silent even while demo running — proceeding",
                            segment.target_player_name, segment.target_steamid64,
                        )
                        result.warnings.append(
                            f"segment {segment.segment_index}: spec verify inconclusive for "
                            f"{segment.target_player_name} — GSI silent while running"
                        )

                # Remaining pre-roll: account for time spent on spec switch + verify
                remaining_preroll = max(0.05, pre_roll_sec + 0.05 - spec_elapsed)

                if not obs_recording_started:
                    logger.info(
                        "[RecordingV3] start_record segment %d (pre_roll=%.2fs spec_elapsed=%.2fs)",
                        segment.segment_index, pre_roll_sec, spec_elapsed,
                    )
                    await asyncio.sleep(remaining_preroll)
                    await asyncio.to_thread(self._obs.start_record)
                    obs_recording_started = True
                else:
                    logger.info(
                        "[RecordingV3] resume_record segment %d (pre_roll=%.2fs spec_elapsed=%.2fs)",
                        segment.segment_index, pre_roll_sec, spec_elapsed,
                    )
                    await asyncio.sleep(remaining_preroll)
                    await asyncio.to_thread(self._obs.resume_record)

                # overhead_sec: demo has been running since demo_resume (during spec switch + preroll)
                overhead_sec = spec_elapsed + remaining_preroll
                tick_result = await _record_until_tick(
                    segment, plan.tick_rate, self._abort_event, overhead_sec=overhead_sec
                )
                if tick_result == "aborted":
                    logger.info("[RecordingV3] recording aborted during segment %d", segment.segment_index)
                    if is_last:
                        output_path = await asyncio.to_thread(self._obs.stop_record)
                        final_output_path = output_path
                    else:
                        await asyncio.gather(
                            asyncio.to_thread(self._obs.pause_record),
                            demo_pause(),
                        )
                    result.segment_results.append(SegmentResult(
                        segment_index=segment.segment_index,
                        status="skipped",
                        start_tick=segment.start_tick,
                        end_tick=segment.end_tick,
                        perspective=segment.perspective,
                        error="aborted",
                    ))
                    break

                if is_last:
                    logger.info("[RecordingV3] stop_record segment %d (last)", segment.segment_index)
                    output_path = await asyncio.to_thread(self._obs.stop_record)
                    final_output_path = output_path
                    await asyncio.to_thread(self._obs.disconnect)
                else:
                    logger.info("[RecordingV3] pause_record segment %d", segment.segment_index)
                    # Parallelize OBS pause and demo pause to minimize demo overshoot
                    # on final-round segments where end_tick is close to demo_end_tick
                    await asyncio.gather(
                        asyncio.to_thread(self._obs.pause_record),
                        demo_pause(),
                    )

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
                else:
                    # start_record may have timed out but OBS still started — check and stop
                    try:
                        status = await asyncio.to_thread(self._obs.get_record_status)
                        if status.get("outputActive"):
                            logger.warning("[RecordingV3] OBS recording detected after start_record error; stopping")
                            final_output_path = await asyncio.to_thread(self._obs.stop_record)
                    except Exception:
                        pass
                continue

            result.segment_results.append(SegmentResult(
                segment_index=segment.segment_index,
                status="ok",
                start_tick=segment.start_tick,
                end_tick=segment.end_tick,
                perspective=segment.perspective,
                output_path=final_output_path if is_last else None,
            ))

        # Post-loop cleanup: stop OBS if it was started but never stopped (e.g. last segment was spec_failed)
        if obs_recording_started and final_output_path is None:
            logger.warning("[RecordingV3] OBS still recording after all segments processed; stopping now")
            try:
                final_output_path = await asyncio.to_thread(self._obs.stop_record)
            except Exception as e:
                logger.error("[RecordingV3] post-loop stop_record failed: %s", e)

        result.output_path = final_output_path
        result.success = any(r.status == "ok" for r in result.segment_results)
        result.warnings.extend(plan.warnings)
        return result
