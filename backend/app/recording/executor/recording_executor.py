import asyncio
import logging
import time
from dataclasses import dataclass, field
from typing import Optional

from ..models import RecordingPlan, RecordingSegment, SourceType
from .obs_client import OBSClient
from .obs_recording_controller import OBSRecordingController, OBSControlError
from .obs_fade_controller import OBSFadeController
from .demo_controller import (
    gototick, demo_resume, demo_pause,
    demo_pause_silent, demo_pause_silent_attempt, demo_pause_silent_strict, demo_resume_silent_strict,
    DemoSeekError, inject_console_sequence,
)
from .spec_controller import spec_by_slot
from .gsi_verifier import verify_spec_target

logger = logging.getLogger(__name__)

def _kb_bus(segment=None):
    """Return (bus, tick_offset) when kb overlay should fire, else (None, 0).

    Priority: if the segment carries kb_track data (injected by the queue handler
    when dto.options.kb_overlay_enabled=True), activate the bus unconditionally.
    Otherwise fall back to the global AppConfig flag.
    """
    try:
        if segment is not None and segment.metadata.get("kb_track") is not None:
            from .kb_overlay_bus import kb_overlay_bus
            try:
                from ...env_utils import load_config
                tick_off = load_config().kb_overlay_tick_offset
            except Exception:
                tick_off = 0
            return kb_overlay_bus, tick_off
        from ...env_utils import load_config
        cfg = load_config()
        if cfg.kb_overlay_enabled:
            from .kb_overlay_bus import kb_overlay_bus
            return kb_overlay_bus, cfg.kb_overlay_tick_offset
    except Exception:
        pass
    return None, 0

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


def _get_gsi_round_phase() -> Optional[str]:
    """Return the current round phase string from the latest GSI payload, or None.

    Possible values: "live", "over", "freezetime", "warmup", etc.
    "over" means the round has just ended; "freezetime" means the next round's
    buy-phase is active — both are reliable signals that the current round is done.
    """
    try:
        from ...gsi_ready import gsi_status
        status = gsi_status()
        payload = status.get("last_payload") if isinstance(status, dict) else None
        if not isinstance(payload, dict) or not payload:
            return None
        round_obj = payload.get("round")
        if not isinstance(round_obj, dict):
            return None
        phase = round_obj.get("phase")
        return str(phase).lower() if phase is not None else None
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
    Round-segment tick watcher: stops OBS as soon as the demo reaches segment.end_tick.

    Stop conditions (first to fire wins):
      1. GSI round.phase == "over" or "freezetime" — round has definitively ended.
      2. GSI map.round > target_round — demo entered the next round.
      3. Wall-clock estimated tick >= effective_end_tick.
      4. Hard deadline (full duration + 10 s grace).

    effective_end_tick: for alive-round segments (no target_death_tick in metadata)
    the wall-clock bound is additionally capped at next_round_start_tick from
    segment metadata, so a mis-planned end_tick can never cause the executor to
    record into the next round.
    """
    target_round: Optional[int] = segment.round
    end_tick = segment.end_tick
    start_tick = segment.start_tick
    seg_idx = segment.segment_index
    meta = segment.metadata or {}

    # Defensive cap for alive-round segments: never let the wall-clock estimate
    # run past next_round_start_tick (when the next round's freeze phase begins).
    # This is the same boundary the planner targets for alive rounds.
    meta_death_tick = meta.get("target_death_tick")
    meta_next_round_start = meta.get("next_round_start_tick")
    if meta_death_tick is None and meta_next_round_start is not None:
        effective_end_tick = min(end_tick, int(meta_next_round_start))
        if effective_end_tick != end_tick:
            logger.info(
                "[RecordingV3][TickWatcher] segment=%d capping end_tick %d → %d "
                "(next_round_start_tick from metadata)",
                seg_idx, end_tick, effective_end_tick,
            )
    else:
        effective_end_tick = end_tick

    base_duration = max(0.1, (effective_end_tick - start_tick) / tick_rate)
    # Hard deadline: full duration + 10 s grace so a stalled GSI can't block forever.
    hard_deadline = time.monotonic() + base_duration + 10.0

    gsi_seen = False
    gsi_unavailable_warned = False
    # Phase guard: only fires AFTER the round goes "live" for the first time.
    # This prevents a false stop during the pre-roll freeze window that starts
    # before freeze_end_tick — at that point GSI still reports "freezetime" for
    # the target round, which must not be misread as "the round just ended".
    phase_guard_armed = False
    poll_count = 0
    # Computed once: used by both the phase guard and the round guard below.
    is_alive_round = meta_death_tick is None
    # Final-round alive player: after the match-winning kill, CS2/GSI may emit
    # "freezetime" (end-game screen transition) and/or advance map.round beyond
    # target_round. Neither signal represents a real next round, so both GSI-based
    # stop conditions are disabled here — wall-clock timing takes over instead.
    is_final_alive = segment.is_final_round and is_alive_round
    t0 = time.monotonic()

    logger.info(
        "[RecordingV3][TickWatcher] segment=%d start=%d end=%d effective_end=%d "
        "duration=%.2fs round=%s",
        seg_idx, start_tick, end_tick, effective_end_tick, base_duration, target_round,
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
                "[RecordingV3][TickWatcher] segment=%d current_tick=%d target_end=%d elapsed=%.1fs phase_armed=%s",
                seg_idx, estimated_tick, effective_end_tick, elapsed, phase_guard_armed,
            )

        # GSI phase guard — two-phase approach:
        #   1. Arm once we see "live" (round is in active play).
        #   2. Fire on a phase that signals the recording window has closed:
        #      - Alive rounds (no target_death_tick): only stop on "freezetime",
        #        which corresponds to next_round_start_tick.  "over" fires too
        #        early (round-end scoreboard) and must be skipped so the round-end
        #        screen is included in the clip.
        #      - Death rounds: stop on either "over" or "freezetime" (existing
        #        behaviour) since the window ends shortly after the player dies.
        # This prevents a false stop when the demo seeked into the pre-roll freeze
        # window and GSI still reports "freezetime" for the current round.
        gsi_phase = _get_gsi_round_phase()
        if gsi_phase == "live" and not phase_guard_armed:
            phase_guard_armed = True
            logger.info(
                "[RecordingV3][TickWatcher] segment=%d phase guard armed at estimated_tick=%d",
                seg_idx, estimated_tick,
            )
        elif phase_guard_armed:
            # is_final_alive: disable GSI phase stop — see comment above t0.
            if not is_final_alive:
                stop_phases = ("freezetime",) if is_alive_round else ("over", "freezetime")
                if gsi_phase in stop_phases:
                    logger.info(
                        "[RecordingV3][TickWatcher] segment=%d GSI round.phase=%s at estimated_tick=%d; "
                        "stopping OBS (alive_round=%s)",
                        seg_idx, gsi_phase, estimated_tick, is_alive_round,
                    )
                    return "done"

        # GSI round guard: fire as soon as the demo has entered a later round.
        # Skip for final-round alive player — map.round may transiently exceed
        # target_round during the end-game transition and must not stop recording.
        gsi_round = _get_gsi_current_round()
        if gsi_round is not None:
            gsi_seen = True
            if target_round is not None and gsi_round > target_round:
                if is_final_alive:
                    logger.info(
                        "[RecordingV3][TickWatcher] segment=%d final_round_alive: "
                        "ignoring GSI round advance to %d (end-game transition)",
                        seg_idx, gsi_round,
                    )
                else:
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

        # Wall-clock tick estimate: stop when estimated demo tick reaches effective end.
        if estimated_tick >= effective_end_tick:
            logger.info(
                "[RecordingV3][TickWatcher] segment=%d current_tick=%d target_end=%d; "
                "reached end_tick; stopping OBS",
                seg_idx, estimated_tick, effective_end_tick,
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


# Max additional slot offsets to try after the demo-parsed base slot fails GSI verify.
# 5E / Perfect World demos are often off by +1; rarely more.
_SPEC_SLOT_MAX_OFFSET = 3


async def _spec_by_slot_with_retry(
    base_slot: Optional[int],
    player_name: str,
    target_steamid64: str,
    result_warnings: list,
    segment_index: int,
) -> "bool | None":
    """
    Switch to base_slot (pre-computed during demo parsing), then verify via GSI.
    If verification fails, increment the slot by 1 and retry up to
    _SPEC_SLOT_MAX_OFFSET times (handles 5E/PW demos that shift slots by +1).

    Returns:
        True  — verified correct player
        None  — GSI inconclusive (proceed with warning)
        False — all offsets exhausted, still wrong player
    """
    if base_slot is None:
        logger.warning(
            "[RecordingV3] no spec slot for %r (not set during parsing); skipping spec switch",
            player_name,
        )
        return None

    for offset in range(_SPEC_SLOT_MAX_OFFSET + 1):
        slot = base_slot + offset
        logger.info(
            "[RecordingV3] spec_by_slot %d (base=%d offset=%d) for %r steamid=%s",
            slot, base_slot, offset, player_name, target_steamid64,
        )
        await spec_by_slot(slot)

        if not target_steamid64:
            return None

        verified = await verify_spec_target(target_steamid64)
        if verified is True:
            if offset > 0:
                logger.info(
                    "[RecordingV3] slot offset +%d worked for %r (base=%d actual=%d)",
                    offset, player_name, base_slot, slot,
                )
            return True
        if verified is None:
            result_warnings.append(
                f"segment {segment_index}: spec verify inconclusive for "
                f"{player_name} at slot {slot} — GSI silent"
            )
            return None
        # verified is False — try next offset
        logger.warning(
            "[RecordingV3] slot %d wrong for %r (offset=%d), trying +1",
            slot, player_name, offset,
        )

    logger.error(
        "[RecordingV3] all slot offsets 0..%d failed for %r steamid=%s",
        _SPEC_SLOT_MAX_OFFSET, player_name, target_steamid64,
    )
    return False


class RecordingExecutor:
    def __init__(
        self,
        obs_client: OBSClient,
        abort_event: Optional[asyncio.Event] = None,
        fade_controller: Optional[OBSFadeController] = None,
    ):
        self._obs = obs_client
        self._abort_event = abort_event
        self._fade: Optional[OBSFadeController] = fade_controller
        # Controller is created per-execute call so it always holds the current client.
        self._ctrl: Optional[OBSRecordingController] = None
        # Tracks whether OBS program output is currently on the black scene.
        # Persists across execute() calls so the next clip skips a redundant
        # fade_to_black() when OBS was already left on black by the previous stop.
        self._obs_on_black: bool = False

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
        # Fade to black before OBS pause — only between segments, not at the final stop.
        # The very start and end of the recording use a hard cut to avoid audio fade-in/out
        # artifacts on the global Desktop Audio track during the OBS scene transition.
        if self._fade is not None and not is_last:
            ok = await self._fade.fade_to_black()
            if not ok:
                logger.warning("[RecordingV3] fade_to_black failed at segment boundary; hard-cut")
            else:
                self._obs_on_black = True

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
                    spec_ok = await _spec_by_slot_with_retry(
                        base_slot=segment.target_spec_slot,
                        player_name=segment.target_player_name,
                        target_steamid64=segment.target_steamid64,
                        result_warnings=result.warnings,
                        segment_index=segment.segment_index,
                    )
                    spec_elapsed = time.monotonic() - spec_t0

                    if spec_ok is not False and segment.voice_listen_mask is not None:
                        mask_val = segment.voice_listen_mask
                        try:
                            await asyncio.to_thread(
                                inject_console_sequence,
                                ["tv_listen_voice_indices -1", f"tv_listen_voice_indices {mask_val}"],
                            )
                        except Exception as _e:
                            logger.warning(
                                "[RecordingV3] tv_listen_voice_indices inject failed: %s", _e
                            )

                    if spec_ok is False:
                        logger.error(
                            "[RecordingV3] spec failed for %s (steamid=%s) after slot retries; aborting",
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

                # 优先用 KP_5 静默暂停（不打开控制台），避免控制台注入期间 demo 继续跑约
                # 300ms / 19 tick 导致 overlay 偏移。KP_5 tap 约 50ms，overshoot < 2 tick。
                # 失败时降级到 console pause（仍需要 0.35s 等控制台动画关闭）。
                _silent_ok = await demo_pause_silent_attempt()
                if _silent_ok:
                    # 无控制台：只需等 CS2 处理完按键（通常 < 1 game tick = 15ms）
                    await asyncio.sleep(0.05)
                else:
                    await demo_pause()
                    # 等控制台关闭动画，防止 OBS 录到控制台画面
                    await asyncio.sleep(0.35)
                logger.info("[RecordingV3] reached effective start_tick; starting OBS")
                # ── kb overlay: load ────────────────────────────────────────
                _kb_frames = segment.metadata.get("kb_track")
                logger.info(
                    "[kb_overlay] seg=%d metadata keys=%s kb_track_len=%s",
                    segment.segment_index,
                    list(segment.metadata.keys()),
                    len(_kb_frames) if _kb_frames is not None else "None(key missing)",
                )
                _bus, _tick_off = _kb_bus(segment)
                logger.info("[kb_overlay] seg=%d bus=%s tick_off=%s", segment.segment_index, _bus, _tick_off)
                if _bus:
                    await _bus.broadcast({
                        "type": "load",
                        "segment_index": segment.segment_index,
                        "start_tick": segment.start_tick,
                        "end_tick": segment.end_tick,
                        "tick_rate": plan.tick_rate,
                        "offset_ticks": _tick_off,
                        "frames": _kb_frames or [],
                    })

                # ── 4. Start or Resume OBS recording ────────────────────────
                # Hot path: StartRecord/ResumeRecord returns immediately on success.
                # DO NOT call GetRecordStatus here — that delay would be recorded.
                _bus_resume, _ = _kb_bus(segment)

                if not obs_recording_started:
                    logger.info(
                        "[RecordingV3] start_record segment %d (spec_elapsed=%.2fs pre_roll=%.2fs remaining_wait=%.2fs)",
                        segment.segment_index, spec_elapsed, pre_roll_sec, remaining_wait,
                    )
                    result.recording_started_at = time.time()
                    # Hard cut at the very start of recording — no fade-in from black.
                    # Fade transitions are reserved for mid-clip segment boundaries only,
                    # so the global Desktop Audio track is never cross-faded at clip edges.
                    await self._ctrl.start_record_safe()
                    obs_recording_started = True
                    # ── kb overlay: resume 与 demo_resume 并发，消除 50ms sleep 带来的偏移 ──
                    if _bus_resume:
                        (resume_ok, _) = await asyncio.gather(
                            demo_resume_silent_strict(),
                            _bus_resume.broadcast({"type": "resume"}),
                        )
                    else:
                        resume_ok = await demo_resume_silent_strict()
                    self._obs_on_black = False
                else:
                    logger.info(
                        "[RecordingV3] resume_record segment %d (spec_elapsed=%.2fs pre_roll=%.2fs remaining_wait=%.2fs)",
                        segment.segment_index, spec_elapsed, pre_roll_sec, remaining_wait,
                    )
                    # Pre-warm the OBS connection for fade-in *before* ResumeRecord so
                    # the scene switch fires with near-zero latency after recording resumes.
                    # Without this, the WS connection setup (~100-300 ms) is recorded as
                    # black-screen-with-audio at the start of the clip.
                    if self._fade is not None:
                        await self._fade.prime_fade_to_game()
                    await self._ctrl.resume_record_safe()

                    # ── 5b. Resume demo / fade-in / kb overlay 三路并发 ─────────
                    tasks = [demo_resume_silent_strict()]
                    if self._fade is not None:
                        tasks.append(self._fade.execute_primed_fade_to_game())
                    if _bus_resume:
                        tasks.append(_bus_resume.broadcast({"type": "resume"}))
                    results_gather = await asyncio.gather(*tasks, return_exceptions=True)
                    resume_ok = results_gather[0] if not isinstance(results_gather[0], Exception) else False
                    if self._fade is not None:
                        fade_ok = results_gather[1] if not isinstance(results_gather[1], Exception) else False
                        if not fade_ok:
                            logger.warning("[RecordingV3] fade_to_game after ResumeRecord failed; hard-cut")
                    self._obs_on_black = False

                # ── 5. Handle demo_resume_silent_strict failure ───────────────
                # Strict: no console fallback — OBS is now recording.
                # If the key tap fails, abort this segment without console pollution.
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
                    # ── kb overlay: end ─────────────────────────────────────
                    _bus, _ = _kb_bus(segment)
                    if _bus:
                        await _bus.broadcast({"type": "end"})
                else:
                    # ── kb overlay: pause ───────────────────────────────────
                    _bus, _ = _kb_bus(segment)
                    if _bus:
                        await _bus.broadcast({"type": "pause"})

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
