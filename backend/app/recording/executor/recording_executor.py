import asyncio
import logging
import time
from dataclasses import dataclass, field
from typing import Optional

from ..models import RecordingPlan, RecordingSegment, SourceType
from .obs_client import OBSClient
from .obs_recording_controller import OBSRecordingController, OBSControlError
from .demo_controller import (
    gototick, demo_resume, demo_pause,
    demo_pause_silent_strict, demo_resume_silent_strict,
    DemoSeekError,
)
from .spec_controller import spec_player
from .gsi_verifier import verify_spec_target

logger = logging.getLogger(__name__)

# Seconds seeked before each segment's start_tick to absorb spec_player / GSI-verify
# overhead without consuming the user-configured highlight_pre_sec recording window.
PREPARE_PREROLL_SEC: float = 5.0

# Poll interval for the round-segment tick watcher.
_TICK_WATCHER_POLL_SEC: float = 0.1
# Log the tick watcher status every N polls (0.1s * 50 = 5s).
_TICK_WATCHER_LOG_EVERY: int = 50


def _get_gsi_current_round() -> Optional[int]:
    """Return the current round number from the latest GSI payload, or None."""
    try:
        from ...gsi_ready import gsi_status
        status = gsi_status()
        payload = status.get("last_payload") if isinstance(status, dict) else None
        if not isinstance(payload, dict) or not payload:
            return None
        map_obj = payload.get("map")
        if not isinstance(map_obj, dict):
            return None
        val = map_obj.get("round")
        if val is None:
            return None
        return int(val)
    except Exception:
        return None


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

    overhead_sec: net ticks already consumed relative to start_tick.
      = spec_elapsed - pre_roll_sec
      Positive → demo is ahead of start_tick → recording window shrinks.
      Negative → demo is behind start_tick → recording window grows.
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
            logger.info(
                "[RecordingV3] record_until_tick: abort signalled at %.2fs / %.2fs",
                elapsed, duration_sec,
            )
            return "aborted"
        await asyncio.sleep(min(chunk, duration_sec - elapsed))
        elapsed += chunk
    return "done"


async def _record_until_tick_round_segment(
    segment: RecordingSegment,
    tick_rate: float,
    abort_event: Optional[asyncio.Event],
    warnings: list[str],
) -> str:
    """
    Round-segment tick watcher: stops OBS as soon as the estimated demo tick
    reaches segment.end_tick, or immediately when GSI reports the round has
    advanced beyond the target round.

    Primary tick source: wall-clock elapsed × tick_rate (estimated current tick).
    Secondary guard: GSI map.round — fires when the demo enters the next round,
    which is earlier than end_tick for non-last rounds clamped to next_round_start.

    If GSI data is unavailable throughout, a warning is appended but recording
    proceeds via the wall-clock estimate (not a silent fallback — the warning
    is visible in ExecutionResult.warnings).
    """
    target_round: Optional[int] = segment.round
    end_tick = segment.end_tick
    start_tick = segment.start_tick
    seg_idx = segment.segment_index

    base_duration = max(0.1, (end_tick - start_tick) / tick_rate)
    # Hard deadline: full duration + 10 s grace so a stalled GSI can't block forever.
    hard_deadline = time.monotonic() + base_duration + 10.0

    gsi_seen = False
    gsi_unavailable_warned = False
    poll_count = 0
    t0 = time.monotonic()

    logger.info(
        "[RecordingV3][TickWatcher] segment=%d start=%d end=%d duration=%.2fs round=%s",
        seg_idx, start_tick, end_tick, base_duration, target_round,
    )

    while True:
        if abort_event and abort_event.is_set():
            logger.info(
                "[RecordingV3][TickWatcher] segment=%d abort signalled", seg_idx,
            )
            return "aborted"

        await asyncio.sleep(_TICK_WATCHER_POLL_SEC)
        poll_count += 1
        elapsed = time.monotonic() - t0
        estimated_tick = start_tick + int(elapsed * tick_rate)

        if poll_count % _TICK_WATCHER_LOG_EVERY == 0:
            logger.info(
                "[RecordingV3][TickWatcher] segment=%d current_tick=%d target_end=%d elapsed=%.1fs",
                seg_idx, estimated_tick, end_tick, elapsed,
            )

        # GSI round guard: fire as soon as the demo has entered a later round.
        gsi_round = _get_gsi_current_round()
        if gsi_round is not None:
            gsi_seen = True
            if target_round is not None and gsi_round > target_round:
                logger.info(
                    "[RecordingV3][TickWatcher] segment=%d GSI round advanced to %d > target %d "
                    "at estimated_tick=%d; stopping OBS",
                    seg_idx, gsi_round, target_round, estimated_tick,
                )
                return "done"
        else:
            if not gsi_seen and not gsi_unavailable_warned and elapsed > 5.0:
                # GSI has been silent for 5 s since recording started.
                msg = (
                    f"segment {seg_idx}: round_segment_requires_current_tick — "
                    "GSI silent; using wall-clock tick estimate (may drift during freeze/pause)"
                )
                warnings.append(msg)
                logger.warning("[RecordingV3][TickWatcher] %s", msg)
                gsi_unavailable_warned = True

        # Wall-clock tick estimate: primary stop condition.
        if estimated_tick >= end_tick:
            logger.info(
                "[RecordingV3][TickWatcher] segment=%d current_tick=%d target_end=%d; "
                "reached end_tick; stopping OBS",
                seg_idx, estimated_tick, end_tick,
            )
            return "done"

        # Hard deadline guard.
        if time.monotonic() >= hard_deadline:
            logger.warning(
                "[RecordingV3][TickWatcher] segment=%d hard deadline exceeded; stopping OBS",
                seg_idx,
            )
            return "done"


@dataclass
class SegmentResult:
    segment_index: int
    status: str  # "ok" | "seek_failed" | "spec_failed" | "skipped" | "silent_resume_failed"
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
    # Timing and OBS output info — used by obs_director for post-recording rename
    recording_started_at: Optional[float] = None   # wall time just before first StartRecord
    recording_stopped_at: Optional[float] = None   # wall time just after last StopRecord
    obs_record_directory: Optional[str] = None     # OBS output directory (from GetRecordDirectory)


class RecordingExecutor:
    def __init__(self, obs_client: OBSClient, abort_event: Optional[asyncio.Event] = None):
        self._obs = obs_client
        self._abort_event = abort_event
        # Controller is created per-execute call so it always holds the current client.
        self._ctrl: Optional[OBSRecordingController] = None

    def _is_aborted(self) -> bool:
        return self._abort_event is not None and self._abort_event.is_set()

    async def _stop_obs_and_console_pause(self, is_last: bool) -> Optional[str]:
        """
        End-of-segment boundary: concurrently send demo_pause_silent_strict + OBS
        PauseRecord/StopRecord, then fall back to console demo_pause if the key tap
        failed (safe because OBS is confirmed paused/stopped at that point).

        Returns:
          - outputPath (str or None) when is_last=True
          - None when is_last=False (pause case)
        Populates self._obs_force_stopped when PauseRecord fell back to StopRecord.
        """
        if is_last:
            silent_result, obs_result = await asyncio.gather(
                demo_pause_silent_strict(),
                self._ctrl.stop_record_safe(),
                return_exceptions=True,
            )
            output_path: Optional[str] = None
            if isinstance(obs_result, Exception):
                logger.error("[RecordingV3] stop_record_safe raised: %s", obs_result)
            else:
                output_path = obs_result

        else:
            silent_result, pause_result = await asyncio.gather(
                demo_pause_silent_strict(),
                self._ctrl.pause_record_safe(),
                return_exceptions=True,
            )
            if isinstance(pause_result, Exception):
                logger.error("[RecordingV3] pause_record_safe raised: %s", pause_result)
                pause_result = "error"

            if pause_result == "fallback_stopped":
                # PauseRecord fell back to StopRecord — no more segments can resume.
                self._obs_force_stopped = True
                logger.warning(
                    "[RecordingV3] PauseRecord fell back to StopRecord; "
                    "no further segments can be resumed in this output file"
                )
            output_path = None

        # Console fallback for demo pause — only AFTER OBS is confirmed paused/stopped.
        if isinstance(silent_result, Exception) or not silent_result:
            logger.warning(
                "[RecordingV3] demo_pause_silent_strict failed; using console demo_pause "
                "(OBS is now paused/stopped — safe to use console)"
            )
            await demo_pause()

        return output_path if is_last else None

    async def execute(self, plan: RecordingPlan) -> ExecutionResult:
        result = ExecutionResult(request_id=plan.request_id)
        active_segments = [s for s in plan.segments if not s.disabled]

        # Lazy-create controller using the client provided at construction time.
        self._ctrl = OBSRecordingController(self._obs.config, self._obs)
        self._obs_force_stopped = False  # set True when pause_record_safe fallback-stops

        # Fetch OBS record directory now, while obs_client is connected.
        # This is used by obs_director for file scan / rename after recording ends.
        try:
            obs_dir = await asyncio.to_thread(self._obs.get_record_directory)
            if obs_dir:
                result.obs_record_directory = obs_dir
                logger.info("[RecordingV3] OBS record directory: %s", obs_dir)
            else:
                logger.warning("[RecordingV3] OBS record directory not available (GetRecordDirectory returned None)")
        except Exception as _dir_e:
            logger.warning("[RecordingV3] get_record_directory failed: %s", _dir_e)

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

            # If a mid-sequence fallback StopRecord occurred, no further segments can resume.
            if self._obs_force_stopped:
                logger.warning(
                    "[RecordingV3] skipping segment %d: OBS was force-stopped mid-sequence",
                    segment.segment_index,
                )
                result.warnings.append(
                    f"segment {segment.segment_index}: skipped — OBS force-stopped mid-sequence"
                )
                break

            is_last = (i == len(active_segments) - 1)

            # ── 1. Seek ──────────────────────────────────────────────────────
            # OBS is paused/stopped at this point — console commands are safe.
            #
            # prepare_seek_tick: always 5 s before start_tick so that spec_player /
            # GSI-verify run in the prepare window, not the recording window.
            #
            # Exception: if the planner / FinalRoundGuard already set a specific
            # safe_seek_tick that is earlier than start_tick, that value already
            # encodes timing intent (e.g. locked to round freeze-end) — use it.
            prepare_ticks = int(PREPARE_PREROLL_SEC * plan.tick_rate)
            if segment.safe_seek_tick < segment.start_tick:
                seek_tick = segment.safe_seek_tick
            else:
                seek_tick = max(0, segment.start_tick - prepare_ticks)

            logger.info(
                "[RecordingV3] prepare_seek segment %d  prepare_tick=%d  start_tick=%d  preroll=%.2fs",
                segment.segment_index, seek_tick, segment.start_tick,
                (segment.start_tick - seek_tick) / plan.tick_rate,
            )

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

            # Pre-roll duration: ticks between seek_tick and start_tick.
            pre_roll_sec = max(0.0, (segment.start_tick - seek_tick) / plan.tick_rate)

            try:
                # ── 2. Resume demo so spec_player and GSI work ──────────────
                # OBS is paused/stopped — console is safe here.
                await demo_resume()

                spec_elapsed = 0.0
                if segment.target_steamid64 or segment.target_player_name:
                    spec_t0 = time.monotonic()
                    await spec_player(segment.target_player_name)

                    if segment.target_steamid64:
                        verified = await verify_spec_target(segment.target_steamid64)
                        spec_elapsed = time.monotonic() - spec_t0

                        if verified is False:
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
                                await self._ctrl.stop_record_safe()
                            result.output_path = final_output_path
                            result.success = any(r.status == "ok" for r in result.segment_results)
                            result.warnings.extend(plan.warnings)
                            return result

                        elif verified is None:
                            logger.warning(
                                "[RecordingV3] spec verify inconclusive for %s (steamid=%s); "
                                "GSI silent while running — proceeding",
                                segment.target_player_name, segment.target_steamid64,
                            )
                            result.warnings.append(
                                f"segment {segment.segment_index}: spec verify inconclusive for "
                                f"{segment.target_player_name} — GSI silent while running"
                            )
                            spec_elapsed = time.monotonic() - spec_t0
                    else:
                        spec_elapsed = time.monotonic() - spec_t0

                # ── 3. Wait for demo to reach start_tick, then pause ────────
                # spec_player / GSI-verify run while the demo is playing inside
                # the 5 s prepare window.  Sleep the remaining time so the demo
                # reaches start_tick before OBS begins recording.
                remaining_wait = max(0.0, pre_roll_sec - spec_elapsed)
                logger.info(
                    "[RecordingV3] spec_elapsed=%.2fs  remaining_to_start=%.2fs",
                    spec_elapsed, remaining_wait,
                )
                if remaining_wait > 0.05:
                    await asyncio.sleep(remaining_wait)

                await demo_pause()
                logger.info("[RecordingV3] reached effective start_tick; starting OBS")

                # ── 4. Start or Resume OBS recording ────────────────────────
                # Hot path: StartRecord/ResumeRecord returns immediately on success.
                # DO NOT call GetRecordStatus here — that delay would be recorded.
                if not obs_recording_started:
                    logger.info(
                        "[RecordingV3] start_record segment %d (spec_elapsed=%.2fs pre_roll=%.2fs remaining_wait=%.2fs)",
                        segment.segment_index, spec_elapsed, pre_roll_sec, remaining_wait,
                    )
                    result.recording_started_at = time.time()
                    await self._ctrl.start_record_safe()
                    obs_recording_started = True
                else:
                    logger.info(
                        "[RecordingV3] resume_record segment %d (spec_elapsed=%.2fs pre_roll=%.2fs remaining_wait=%.2fs)",
                        segment.segment_index, spec_elapsed, pre_roll_sec, remaining_wait,
                    )
                    await self._ctrl.resume_record_safe()

                # ── 5. Resume demo IMMEDIATELY after OBS start/resume ────────
                # Strict: no console fallback — OBS is now recording.
                # If the key tap fails, abort this segment without console pollution.
                resume_ok = await demo_resume_silent_strict()
                if not resume_ok:
                    logger.error(
                        "[RecordingV3] demo_resume_silent_strict FAILED for segment %d; "
                        "aborting segment to avoid blank recording",
                        segment.segment_index,
                    )
                    # OBS is recording a frozen frame — pause/stop it immediately.
                    if is_last:
                        final_output_path = await self._ctrl.stop_record_safe()
                        await asyncio.to_thread(self._obs.disconnect)
                    else:
                        pause_r = await self._ctrl.pause_record_safe()
                        if pause_r == "fallback_stopped":
                            self._obs_force_stopped = True
                    # After OBS is paused/stopped, console is safe again.
                    await demo_pause()
                    result.segment_results.append(SegmentResult(
                        segment_index=segment.segment_index,
                        status="silent_resume_failed",
                        start_tick=segment.start_tick,
                        end_tick=segment.end_tick,
                        perspective=segment.perspective,
                        error="demo_resume_silent_strict failed — KP_6 tap not delivered",
                    ))
                    result.warnings.append(
                        f"segment {segment.segment_index}: silent_resume_failed — "
                        "KP_6 tap not delivered; segment skipped to avoid blank footage"
                    )
                    if self._obs_force_stopped:
                        break
                    continue

                # ── 6. Wait until end_tick ────────────────────────────────
                # Round segments use the tick watcher (100ms poll + GSI round guard)
                # so they stop at the precise round boundary rather than relying on
                # a coarse 1-second wall-clock sleep.
                if segment.source_type == SourceType.round:
                    tick_result = await _record_until_tick_round_segment(
                        segment, plan.tick_rate, self._abort_event, result.warnings,
                    )
                else:
                    tick_result = await _record_until_tick(
                        segment, plan.tick_rate, self._abort_event, overhead_sec=0.0,
                    )

                if tick_result == "aborted":
                    logger.info("[RecordingV3] recording aborted during segment %d", segment.segment_index)
                    logger.info("[RecordingV3][ABORT] abort requested")

                    # Concurrent: silent pause + OBS stop (OBS is recording — no console).
                    # Console fallback happens after OBS confirms stopped (inside helper).
                    final_output_path = None
                    if is_last:
                        final_output_path = await self._stop_obs_and_console_pause(is_last=True)
                        await asyncio.to_thread(self._obs.disconnect)
                    else:
                        await self._stop_obs_and_console_pause(is_last=False)
                        await self._ctrl.force_stop_recording()

                    logger.info("[RecordingV3][ABORT] demo_pause sent and OBS stopped")
                    result.segment_results.append(SegmentResult(
                        segment_index=segment.segment_index,
                        status="skipped",
                        start_tick=segment.start_tick,
                        end_tick=segment.end_tick,
                        perspective=segment.perspective,
                        error="aborted",
                    ))
                    break

                # ── 7. End of segment: concurrent demo_pause_silent_strict + OBS ──
                # Both fire at the same time to minimise the window between
                # demo pausing and OBS pausing/stopping.
                # Console fallback (if key tap fails) happens AFTER OBS confirms paused/stopped.
                logger.info(
                    "[RecordingV3] end_segment %d (%s)",
                    segment.segment_index, "stop" if is_last else "pause",
                )
                obs_stop_path = await self._stop_obs_and_console_pause(is_last=is_last)
                if is_last:
                    result.recording_stopped_at = time.time()
                    final_output_path = obs_stop_path
                    await asyncio.to_thread(self._obs.disconnect)

                # ── 5b. OBS pause confirmation before next segment's console ─
                # After pause_record_safe returns "ok" or "ok_recovered", OBS is
                # confirmed paused. If it returned "fallback_stopped", the next
                # segment loop iteration will see self._obs_force_stopped=True and break.
                # Either way, gototick/spec_player console calls are safe from here.

            except OBSControlError as e:
                logger.error("Segment %d OBS control error: %s", segment.segment_index, e)
                result.segment_results.append(SegmentResult(
                    segment_index=segment.segment_index,
                    status="skipped",
                    start_tick=segment.start_tick,
                    end_tick=segment.end_tick,
                    perspective=segment.perspective,
                    error=str(e),
                ))
                # OBSControlError means OBS didn't start. Demo is paused from step 3.
                # No OBS to stop here.
                continue

            except Exception as e:
                logger.error("Segment %d record error: %s", segment.segment_index, e)
                result.segment_results.append(SegmentResult(
                    segment_index=segment.segment_index,
                    status="skipped",
                    start_tick=segment.start_tick,
                    end_tick=segment.end_tick,
                    perspective=segment.perspective,
                    error=str(e),
                ))
                # Use force_stop to handle any ambiguous OBS state.
                if obs_recording_started:
                    try:
                        final_output_path = await self._ctrl.stop_record_safe()
                    except Exception:
                        pass
                    obs_recording_started = False
                else:
                    try:
                        await self._ctrl.force_stop_recording()
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

        # Post-loop: force-stop if OBS was started but never stopped cleanly.
        if obs_recording_started and final_output_path is None and not self._obs_force_stopped:
            logger.warning("[RecordingV3] OBS still recording after all segments; force stopping")
            await self._ctrl.force_stop_recording()

        result.output_path = final_output_path
        result.success = any(r.status == "ok" for r in result.segment_results)
        result.warnings.extend(plan.warnings)
        return result
