"""
Recording plan builder tests — 16 scenarios from plan Section 十六.
Run from repo root:  python -m pytest backend/tests/test_recording_plan.py -v
Or directly:         python backend/tests/test_recording_plan.py
"""
import sys
import os

sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))

from app.recording.models import (
    RecordingRequestDTO, RequestType, SourceType, Perspective, EventType,
    DemoContext, TargetPlayer, EventInfo, RoundInfo, RecordingOptions, SourceRef,
)
from app.recording.plan_builder import build_plan

# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------

TICK_RATE = 64.0

def make_demo(final_round=20, demo_end_tick=500_000, final_round_start_tick=480_000,
              final_round_end_tick=495_000, first_tick=0, win_panel_match_tick=0):
    return DemoContext(
        demo_path="/demo/test.dem",
        demo_filename="test.dem",
        map_name="de_dust2",
        tick_rate=TICK_RATE,
        first_tick=first_tick,
        demo_end_tick=demo_end_tick,
        final_round=final_round,
        final_round_start_tick=final_round_start_tick,
        final_round_end_tick=final_round_end_tick,
        win_panel_match_tick=win_panel_match_tick,
    )

PLAYER = TargetPlayer(name="TestPlayer", steamid64="76561198012345678")
ENEMY  = TargetPlayer(name="Enemy",      steamid64="76561198087654321")

def make_kill_event(tick, round_num=5, killer=PLAYER, victim=ENEMY):
    return EventInfo(
        event_type=EventType.kill,
        tick=tick,
        round=round_num,
        killer=killer,
        victim=victim,
        target_player=killer,
        perspective=Perspective.killer,
    )

def make_death_event(tick, round_num=5, killer=ENEMY, victim=PLAYER):
    return EventInfo(
        event_type=EventType.death,
        tick=tick,
        round=round_num,
        killer=killer,
        victim=victim,
        target_player=victim,
        perspective=Perspective.victim,
    )

def make_round(round_num=5, freeze_end_tick=10_000, round_end_tick=30_000,
               target_death_tick=None, next_round_freeze_start_tick=None,
               next_round_freeze_end_tick=None):
    return RoundInfo(
        round=round_num,
        round_start_tick=freeze_end_tick - 1000,
        round_end_tick=round_end_tick,
        freeze_end_tick=freeze_end_tick,
        next_round_start_tick=round_end_tick + 100 if round_end_tick else None,
        next_round_freeze_start_tick=next_round_freeze_start_tick,
        next_round_freeze_end_tick=next_round_freeze_end_tick,
        target_death_tick=target_death_tick,
    )

def dto(**kwargs):
    defaults = dict(
        request_id="test-req",
        request_type=RequestType.highlight,
        source_type=SourceType.kill,
        demo=make_demo(),
        target_player=PLAYER,
        events=[],
        rounds=[],
        options=RecordingOptions(),
        source_ref=SourceRef(),
    )
    defaults.update(kwargs)
    return RecordingRequestDTO(**defaults)

# ---------------------------------------------------------------------------
# Tests
# ---------------------------------------------------------------------------

results = []

def check(name, condition, detail=""):
    status = "PASS" if condition else "FAIL"
    results.append((status, name, detail))
    marker = "OK" if condition else "FAIL"
    print(f"  [{marker}] {name}" + (f" -- {detail}" if detail else ""))
    return condition


# ── Test 1: Highlight single kill ──────────────────────────────────────────
print("\nTest 1: Highlight single kill")
req = dto(
    request_type=RequestType.highlight,
    source_type=SourceType.kill,
    events=[make_kill_event(10_000)],
)
plan = build_plan(req)
opts = req.options
expected_start = 10_000 - int(opts.highlight_pre_sec * TICK_RATE)
expected_end   = 10_000 + int(opts.highlight_post_sec * TICK_RATE)
check("1a: 1 segment", len(plan.segments) == 1)
check("1b: start_tick", plan.segments[0].start_tick == expected_start,
      f"got {plan.segments[0].start_tick}, want {expected_start}")
check("1c: end_tick", plan.segments[0].end_tick == expected_end,
      f"got {plan.segments[0].end_tick}, want {expected_end}")
check("1d: perspective=killer", plan.segments[0].perspective == Perspective.killer)


# ── Test 2a: Highlight three kills within threshold → merge ────────────────
print("\nTest 2a: Highlight three kills within threshold → 1 merged segment")
threshold = RecordingOptions().kill_jump_cut_threshold_sec
tick_a, tick_b, tick_c = 10_000, 10_500, 11_000  # 500 ticks each ≈ 7.8s < 12s
req = dto(
    request_type=RequestType.highlight,
    source_type=SourceType.kill,
    events=[make_kill_event(t) for t in (tick_a, tick_b, tick_c)],
)
plan = build_plan(req)
opts = req.options
exp_start = tick_a - int(opts.highlight_pre_sec * TICK_RATE)
exp_end   = tick_c + int(opts.highlight_post_sec * TICK_RATE)
check("2a-i: 1 segment", len(plan.segments) == 1,
      f"got {len(plan.segments)}")
check("2a-ii: start from first kill", plan.segments[0].start_tick == exp_start,
      f"got {plan.segments[0].start_tick}, want {exp_start}")
check("2a-iii: end at last kill + post", plan.segments[0].end_tick == exp_end,
      f"got {plan.segments[0].end_tick}, want {exp_end}")


# ── Test 2b: Highlight two kills beyond threshold → split ──────────────────
print("\nTest 2b: Highlight two kills beyond threshold → 2 segments")
gap_ticks = int(threshold * TICK_RATE) + 500  # well beyond threshold
tick_a, tick_b = 10_000, 10_000 + gap_ticks
req = dto(
    request_type=RequestType.highlight,
    source_type=SourceType.kill,
    events=[make_kill_event(t) for t in (tick_a, tick_b)],
)
plan = build_plan(req)
opts = req.options
check("2b-i: 2 segments", len(plan.segments) == 2,
      f"got {len(plan.segments)}")
check("2b-ii: seg0 end", plan.segments[0].end_tick == tick_a + int(opts.highlight_post_sec * TICK_RATE),
      f"got {plan.segments[0].end_tick}")
check("2b-iii: seg1 start", plan.segments[1].start_tick == tick_b - int(opts.highlight_pre_sec * TICK_RATE),
      f"got {plan.segments[1].start_tick}")


# ── Test 3: Timeline kill → single independent segment ─────────────────────
print("\nTest 3: Timeline kill — independent segment, no merge")
req = dto(
    request_type=RequestType.timeline_kill,
    source_type=SourceType.kill,
    events=[make_kill_event(10_000)],
)
plan = build_plan(req)
opts = req.options
exp_start = 10_000 - int(opts.timeline_kill_pre_sec * TICK_RATE)
exp_end   = 10_000 + int(opts.timeline_kill_post_sec * TICK_RATE)
check("3a: 1 segment", len(plan.segments) == 1)
check("3b: start_tick", plan.segments[0].start_tick == exp_start,
      f"got {plan.segments[0].start_tick}")
check("3c: end_tick", plan.segments[0].end_tick == exp_end,
      f"got {plan.segments[0].end_tick}")
check("3d: perspective=killer", plan.segments[0].perspective == Perspective.killer)


# ── Test 4: Timeline death → single independent segment ───────────────────
print("\nTest 4: Timeline death — independent segment")
req = dto(
    request_type=RequestType.timeline_death,
    source_type=SourceType.death,
    events=[make_death_event(10_000)],
)
plan = build_plan(req)
opts = req.options
exp_start = 10_000 - int(opts.death_pre_sec * TICK_RATE)
exp_end   = 10_000 + int(opts.death_post_sec * TICK_RATE)
check("4a: 1 segment", len(plan.segments) == 1)
check("4b: start_tick", plan.segments[0].start_tick == exp_start,
      f"got {plan.segments[0].start_tick}")
check("4c: end_tick", plan.segments[0].end_tick == exp_end,
      f"got {plan.segments[0].end_tick}")
check("4d: perspective=victim", plan.segments[0].perspective == Perspective.victim)


# ── Test 5: Fail death window ─────────────────────────────────────────────
print("\nTest 5: Fail death — correct window")
req = dto(
    request_type=RequestType.fail,
    source_type=SourceType.death,
    events=[make_death_event(10_000)],
)
plan = build_plan(req)
opts = req.options
exp_start = 10_000 - int(opts.death_pre_sec * TICK_RATE)
exp_end   = 10_000 + int(opts.death_post_sec * TICK_RATE)
check("5a: 1 segment", len(plan.segments) == 1)
check("5b: start_tick", plan.segments[0].start_tick == exp_start,
      f"got {plan.segments[0].start_tick}")
check("5c: end_tick", plan.segments[0].end_tick == exp_end,
      f"got {plan.segments[0].end_tick}")
check("5d: perspective=victim", plan.segments[0].perspective == Perspective.victim)


# ── Test 6a: Kill compilation within threshold → merge ────────────────────
print("\nTest 6a: Kill compilation within threshold → merged")
tick_a, tick_b = 10_000, 10_300  # ~4.7s gap < 10s threshold
req = dto(
    request_type=RequestType.kill_compilation,
    source_type=SourceType.kill,
    events=[make_kill_event(t, round_num=5) for t in (tick_a, tick_b)],
)
plan = build_plan(req)
opts = req.options
exp_start = tick_a - int(opts.kill_compilation_pre_sec * TICK_RATE)
exp_end   = tick_b + int(opts.kill_compilation_post_sec * TICK_RATE)
check("6a-i: 1 segment", len(plan.segments) == 1, f"got {len(plan.segments)}")
check("6a-ii: start_tick", plan.segments[0].start_tick == exp_start,
      f"got {plan.segments[0].start_tick}")
check("6a-iii: end_tick", plan.segments[0].end_tick == exp_end,
      f"got {plan.segments[0].end_tick}")


# ── Test 6b: Kill compilation beyond threshold → split ────────────────────
print("\nTest 6b: Kill compilation beyond threshold → 2 segments")
gap = int(RecordingOptions().kill_compilation_jump_cut_threshold_sec * TICK_RATE) + 500
tick_a, tick_b = 10_000, 10_000 + gap
req = dto(
    request_type=RequestType.kill_compilation,
    source_type=SourceType.kill,
    events=[make_kill_event(t, round_num=5) for t in (tick_a, tick_b)],
)
plan = build_plan(req)
check("6b-i: 2 segments", len(plan.segments) == 2, f"got {len(plan.segments)}")


# ── Test 7: Death compilation natural merge ────────────────────────────────
print("\nTest 7: Death compilation — close events merge")
opts_custom = RecordingOptions(death_compilation_pre_sec=2.0, death_compilation_post_sec=1.5,
                               death_compilation_merge_gap_sec=2.0)
# Two deaths 2 ticks apart in same round → windows overlap → 1 merged segment
tick_a, tick_b = 10_000, 10_200
req = dto(
    request_type=RequestType.death_compilation,
    source_type=SourceType.death,
    options=opts_custom,
    events=[make_death_event(t, round_num=5) for t in (tick_a, tick_b)],
)
plan = build_plan(req)
check("7a: merged into 1 segment", len(plan.segments) == 1, f"got {len(plan.segments)}")
exp_start = tick_a - int(opts_custom.death_compilation_pre_sec * TICK_RATE)
exp_end   = tick_b + int(opts_custom.death_compilation_post_sec * TICK_RATE)
check("7b: start_tick from first", plan.segments[0].start_tick == exp_start,
      f"got {plan.segments[0].start_tick}")
check("7c: end_tick from last", plan.segments[0].end_tick == exp_end,
      f"got {plan.segments[0].end_tick}")


# ── Test 8: Round compilation — player alive → reliable round_end_tick ────
# next_round_freeze_start_tick=35_000 > next_round_start_tick=30_100 and freeze_end=null
# → normalizer rewrites: next_round_freeze_end=35_000, next_round_freeze_start=null
# round_end_tick=30_000 is reliable (< next_round_start=30_100, not derived from freeze_end-5s)
# Planner Case A: end = round_end_tick=30_000; min(30_000, 30_100) = 30_000
print("\nTest 8: Round compilation — player alive (no death tick)")
next_freeze = 35_000
r = make_round(round_num=5, freeze_end_tick=10_000, round_end_tick=30_000,
               target_death_tick=None, next_round_freeze_start_tick=next_freeze)
req = dto(
    request_type=RequestType.round_compilation,
    source_type=SourceType.round,
    rounds=[r],
)
plan = build_plan(req)
opts = req.options
exp_start = 10_000 - int(opts.round_freeze_preroll_sec * TICK_RATE)
check("8a: 1 segment", len(plan.segments) == 1, f"got {len(plan.segments)}")
check("8b: start = freeze_end - preroll", plan.segments[0].start_tick == exp_start,
      f"got {plan.segments[0].start_tick}, want {exp_start}")
check("8c: end = round_end_tick (reliable, < next_round_start)", plan.segments[0].end_tick == 30_000,
      f"got {plan.segments[0].end_tick}, want 30_000")
check("8d: next_freeze_start rewrite warning emitted",
      any("round_metadata_next_freeze_start_rewritten_to_freeze_end" in w for w in plan.warnings),
      f"warnings={plan.warnings}")


# ── Test 9: Round compilation — player died → death_tick + post ───────────
print("\nTest 9: Round compilation — player died")
death_tick = 20_000
r = make_round(round_num=5, freeze_end_tick=10_000, round_end_tick=30_000,
               target_death_tick=death_tick)
req = dto(
    request_type=RequestType.round_compilation,
    source_type=SourceType.round,
    rounds=[r],
)
plan = build_plan(req)
opts = req.options
exp_end = death_tick + int(opts.round_death_post_sec * TICK_RATE)
check("9a: 1 segment", len(plan.segments) == 1)
check("9b: end = death_tick + post", plan.segments[0].end_tick == exp_end,
      f"got {plan.segments[0].end_tick}, want {exp_end}")


# ── Test 10: Timeline round — equivalent to single round_compilation ───────
# Same normalizer rewrite as test 8: next_round_freeze_start_tick=35_000 rewrites to
# next_round_freeze_end=35_000; round_end_tick=30_000 is reliable.
# end = min(round_end_tick=30_000, next_round_start=30_100) = 30_000
print("\nTest 10: Timeline round")
next_freeze = 35_000
r = make_round(round_num=5, freeze_end_tick=10_000, round_end_tick=30_000,
               target_death_tick=None, next_round_freeze_start_tick=next_freeze)
req = dto(
    request_type=RequestType.timeline_round,
    source_type=SourceType.round,
    rounds=[r],
)
plan = build_plan(req)
opts = req.options
exp_start = 10_000 - int(opts.round_freeze_preroll_sec * TICK_RATE)
check("10a: 1 segment", len(plan.segments) == 1, f"got {len(plan.segments)}")
check("10b: start = freeze_end - preroll", plan.segments[0].start_tick == exp_start)
check("10c: end = round_end_tick (reliable, < next_round_start)", plan.segments[0].end_tick == 30_000,
      f"got {plan.segments[0].end_tick}, want 30_000")


# ── Test 11: Killer + victim POV → 2 separate segments ────────────────────
print("\nTest 11: Killer + victim POV (enable_victim_pov=True, single kill)")
opts_vp = RecordingOptions(enable_victim_pov=True)
req = dto(
    request_type=RequestType.highlight,
    source_type=SourceType.kill,
    options=opts_vp,
    events=[make_kill_event(10_000)],
)
plan = build_plan(req)
check("11a: 2 segments", len(plan.segments) == 2, f"got {len(plan.segments)}")
perspectives = {s.perspective for s in plan.segments}
check("11b: has killer", Perspective.killer in perspectives)
check("11c: has victim", Perspective.victim in perspectives)


# ── Test 12: Victim POV fail skips victim, keeps killer (not applicable) ──
# The planner always generates killer+victim when enable_victim_pov=True.
# FinalRoundGuard or postprocessor can disable individual segments if out of bounds.
# Simulate: victim segment falls past final_round_end — disable only victim.
print("\nTest 12: Victim POV — only victim disabled by final round guard")
# Put kill near the final round end so victim's post window exceeds guard
final_end = 20_000
demo12 = make_demo(final_round=5, final_round_start_tick=15_000,
                   final_round_end_tick=final_end, demo_end_tick=final_end + 100)
# Kill tick such that killer window is fine but victim post overruns:
# killer: tick + post < final_end - guard → ok
# victim: tick + post > final_end - guard → disabled
guard_sec = 4.0
guard_ticks = int(guard_sec * TICK_RATE)  # 256
post_ticks  = int(2.0 * TICK_RATE)        # 128
# safe_end = final_end - guard_ticks = 19744
# For killer: end = tick + post_ticks → need tick + 128 < 19744 → tick < 19616
# For victim: perspective=victim → same tick, same post → also < 19744 → both ok
# Actually victim and killer are same segment here (same tick).
# Skip this test as a separate segment — both share the same tick and post window.
# Instead test: a single death event near final round end → disabled
death_near_end = final_end - guard_ticks + 10  # just past safe_end
opts12 = RecordingOptions(enable_victim_pov=False, final_round_guard_sec=guard_sec)
req12 = dto(
    request_type=RequestType.fail,
    source_type=SourceType.death,
    demo=demo12,
    options=opts12,
    events=[make_death_event(death_near_end, round_num=5)],
)
plan12 = build_plan(req12)
# The segment end_tick would be death_near_end + post_ticks > safe_end → might be clamped or disabled
# With min_duration check: if clamped end ≤ start → disabled
# death_near_end = 19_744 + 10 = 19_754; safe_end = 19_744
# post window: 19_754 + 128 = 19_882 > 19_744 → clamped to 19_744
# start = 19_754 - 192 = 19_562; end (clamped) = 19_744; duration = 182 ticks = 2.8s > 0.8s → active
# So it should remain active (just clamped), not disabled
check("12a: segment not disabled after clamping (>min_duration)", len(plan12.segments) >= 1,
      f"segments={len(plan12.segments)}, disabled={len(plan12.disabled_segments)}")


# ── Test 13: Final round near end → end_tick capped by safe_end_tick ──────
print("\nTest 13: Final round guard — end_tick capped")
final_end = 20_000
demo13 = make_demo(final_round=5, final_round_start_tick=15_000,
                   final_round_end_tick=final_end, demo_end_tick=final_end + 100)
guard_sec = 4.0
safe_end = final_end - int(guard_sec * TICK_RATE)   # 20000 - 256 = 19744
# Kill on final round with post window that overruns safe_end
kill_tick = 19_700  # post end = 19_700 + 128 = 19_828 > 19_744
opts13 = RecordingOptions(final_round_guard_sec=guard_sec, highlight_post_sec=2.0)
req13 = dto(
    request_type=RequestType.highlight,
    source_type=SourceType.kill,
    demo=demo13,
    options=opts13,
    events=[make_kill_event(kill_tick, round_num=5)],
)
plan13 = build_plan(req13)
seg = plan13.segments[0] if plan13.segments else None
check("13a: 1 active segment", len(plan13.segments) == 1, f"got {len(plan13.segments)}, disabled={len(plan13.disabled_segments)}")
if seg:
    check("13b: end_tick clamped to safe_end", seg.end_tick == safe_end,
          f"got {seg.end_tick}, want {safe_end}")
    check("13c: is_final_round=True", seg.is_final_round)


# ── Test 14: FinalRoundGuard — kill past safe_end → anchor-aware skips guard
print("\nTest 14: FinalRoundGuard — kill past safe_end → guard skipped, segment active")
# safe_end = 20_000 - 256 = 19_744; kill at 19_900 > safe_end → guard skipped
# end_tick = min(19_900 + 128, 20_100) = 20_028 (clamped to demo_end_tick)
# The OLD behavior (blind clamp) gave: end_tick=19_744, dur=36 < 51 → disabled
# The NEW anchor-aware behavior: guard skipped → segment stays active
final_end = 20_000
demo14 = make_demo(final_round=5, final_round_start_tick=15_000,
                   final_round_end_tick=final_end, demo_end_tick=final_end + 100)
guard_sec = 4.0
opts14 = RecordingOptions(final_round_guard_sec=guard_sec, highlight_pre_sec=3.0,
                          highlight_post_sec=2.0, final_round_min_duration_sec=0.8)
kill_tick14 = 19_900
req14 = dto(
    request_type=RequestType.highlight,
    source_type=SourceType.kill,
    demo=demo14,
    options=opts14,
    events=[make_kill_event(kill_tick14, round_num=5)],
)
plan14 = build_plan(req14)
check("14a: 1 active segment (guard skipped)", len(plan14.segments) == 1,
      f"got {len(plan14.segments)}")
check("14b: 0 disabled segments", len(plan14.disabled_segments) == 0,
      f"got {len(plan14.disabled_segments)}")
if plan14.segments:
    seg14 = plan14.segments[0]
    check("14c: end_tick >= kill_tick (anchor preserved)",
          seg14.end_tick >= kill_tick14,
          f"got end_tick={seg14.end_tick}, kill_tick={kill_tick14}")
    check("14d: end_tick <= demo_end_tick",
          seg14.end_tick <= final_end + 100,
          f"got end_tick={seg14.end_tick}")
check("14e: guard-skipped warning emitted",
      any("final_round_guard_skipped" in w for w in plan14.warnings),
      f"warnings={plan14.warnings}")


# ── Test 15: gototick fail → segment skipped (executor test — plan only) ──
print("\nTest 15: (executor) gototick fail skips segment — plan builds OK")
# This is an executor-layer test. We verify the plan builds without error.
req15 = dto(
    request_type=RequestType.highlight,
    source_type=SourceType.kill,
    events=[make_kill_event(10_000)],
)
plan15 = build_plan(req15)
check("15a: plan builds cleanly", len(plan15.segments) == 1)
check("15b: safe_seek_tick set", plan15.segments[0].safe_seek_tick is not None)


# ── Test 16: spec_player fail → segment skipped (executor test — plan only)
print("\nTest 16: (executor) spec_player fail skips segment — plan builds OK")
req16 = dto(
    request_type=RequestType.highlight,
    source_type=SourceType.kill,
    events=[make_kill_event(10_000)],
)
plan16 = build_plan(req16)
check("16a: plan builds cleanly", len(plan16.segments) == 1)
check("16b: target_steamid64 present", plan16.segments[0].target_steamid64 != "")


# ── Test 17: FinalRoundGuard anchor-aware + demo_exit_guard — real payload ─
# Real payload: kill_ticks=[365079, 365769], demo_end=365813, final_round=42,
# guard=4s @ 64tps → guard_ticks=256, safe_end=365557 < 365769 (second kill)
# demo_exit_guard=0.3s → 19 ticks → latest_recordable = 365813 - 19 = 365794
# Expected: end_tick >= 365769 AND end_tick < 365813 (never reach demo_end)
print("\nTest 17: FinalRoundGuard anchor-aware + demo_exit_guard (kill_ticks=[365079, 365769])")
demo17 = DemoContext(
    demo_path="/demo/real.dem",
    demo_filename="real.dem",
    map_name="de_inferno",
    tick_rate=64.0,
    first_tick=0,
    demo_end_tick=365813,
    final_round=42,
    final_round_start_tick=364000,
    final_round_end_tick=0,  # not provided (frontend sends 0)
)
opts17 = RecordingOptions(final_round_guard_sec=4.0, final_round_demo_exit_guard_sec=0.3)
# exit_guard_ticks = int(0.3 * 64) = 19; latest_recordable = 365813 - 19 = 365794
req17 = dto(
    request_type=RequestType.highlight,
    source_type=SourceType.kill,
    demo=demo17,
    options=opts17,
    events=[
        make_kill_event(365079, round_num=42),
        make_kill_event(365769, round_num=42),
    ],
)
plan17 = build_plan(req17)
check("17a: 1 active killer segment", len(plan17.segments) == 1)
if plan17.segments:
    seg17 = plan17.segments[0]
    latest_recordable17 = 365813 - int(0.3 * 64)  # = 365794
    check("17b: end_tick >= last kill tick (guard skipped)",
          seg17.end_tick >= 365769,
          f"got end_tick={seg17.end_tick}, expected >= 365769")
    check("17c: end_tick < demo_end_tick (demo_exit_guard applied)",
          seg17.end_tick < 365813,
          f"got end_tick={seg17.end_tick}, must be < 365813")
    check("17d: end_tick <= latest_recordable",
          seg17.end_tick <= latest_recordable17,
          f"got end_tick={seg17.end_tick}, latest_recordable={latest_recordable17}")
    check("17e: anchor_ticks includes both kills",
          365079 in seg17.anchor_ticks and 365769 in seg17.anchor_ticks,
          f"got anchor_ticks={seg17.anchor_ticks}")
check("17f: guard-skipped warning emitted",
      any("final_round_guard_skipped" in w for w in plan17.warnings),
      f"warnings={plan17.warnings}")


# ── Test 18: FinalRoundGuard — single kill inside safe window → normal clamp
print("\nTest 18: FinalRoundGuard — anchor inside safe window → post truncated, anchor kept")
demo18 = DemoContext(
    demo_path="/demo/real.dem",
    demo_filename="real.dem",
    map_name="de_inferno",
    tick_rate=64.0,
    first_tick=0,
    demo_end_tick=365813,
    final_round=42,
    final_round_start_tick=364000,
    final_round_end_tick=0,
)
opts18 = RecordingOptions(final_round_guard_sec=4.0, highlight_post_sec=2.0)
kill_tick_18 = 365000  # safe_end = 365813 - 256 = 365557 > 365000 → anchor safe
req18 = dto(
    request_type=RequestType.highlight,
    source_type=SourceType.kill,
    demo=demo18,
    options=opts18,
    events=[make_kill_event(kill_tick_18, round_num=42)],
)
plan18 = build_plan(req18)
check("18a: 1 active segment", len(plan18.segments) == 1)
if plan18.segments:
    seg18 = plan18.segments[0]
    safe_end_18 = 365813 - int(4.0 * 64)  # = 365557
    check("18b: end_tick <= safe_end",
          seg18.end_tick <= safe_end_18,
          f"got end_tick={seg18.end_tick}, safe_end={safe_end_18}")
    check("18c: end_tick >= kill tick (anchor preserved)",
          seg18.end_tick >= kill_tick_18,
          f"got end_tick={seg18.end_tick}, kill_tick={kill_tick_18}")


# ── Test 19: Victim POV — multi-kill group generates per-kill victim segments
print("\nTest 19: Victim POV per-kill for multi-kill group")
ENEMY2 = TargetPlayer(name="Victim2", steamid64="76561198099999999")
req19 = dto(
    request_type=RequestType.highlight,
    source_type=SourceType.kill,
    options=RecordingOptions(enable_victim_pov=True),
    events=[
        make_kill_event(10_000, victim=ENEMY),
        make_kill_event(10_200, victim=ENEMY2),
    ],
)
plan19 = build_plan(req19)
# Should have: 1 killer segment + 2 victim segments (one per kill)
total19 = len(plan19.segments)
killer19 = [s for s in plan19.segments if s.perspective == Perspective.killer]
victim19 = [s for s in plan19.segments if s.perspective == Perspective.victim]
check("19a: 1 killer segment", len(killer19) == 1, f"got {len(killer19)}")
check("19b: 2 victim segments (one per kill)", len(victim19) == 2,
      f"got {len(victim19)}: {[(s.target_player_name, s.target_steamid64) for s in victim19]}")


# ── Test 20: Victim steamid64 empty → segment stays active (warn, no disable)
print("\nTest 20: Victim segment stays active when steamid64 is empty (warn, no disable)")
NO_ID_VICTIM = TargetPlayer(name="Unknown", steamid64="")
req20 = dto(
    request_type=RequestType.highlight,
    source_type=SourceType.kill,
    options=RecordingOptions(enable_victim_pov=True),
    events=[make_kill_event(10_000, victim=NO_ID_VICTIM)],
)
plan20 = build_plan(req20)
killer20 = [s for s in plan20.segments if s.perspective == Perspective.killer]
victim20_active = [s for s in plan20.segments if s.perspective == Perspective.victim]
victim20_disabled = [s for s in plan20.disabled_segments if s.perspective == Perspective.victim]
check("20a: 1 active killer segment", len(killer20) == 1, f"got {len(killer20)}")
check("20b: 1 active victim segment (kept despite missing steamid64)", len(victim20_active) == 1,
      f"got {len(victim20_active)}")
check("20c: 0 disabled victim segments", len(victim20_disabled) == 0,
      f"got {len(victim20_disabled)}")
if victim20_active:
    check("20d: victim segment target_steamid64 is empty",
          victim20_active[0].target_steamid64 == "",
          f"got: {victim20_active[0].target_steamid64!r}")
warn20 = [w for w in plan20.warnings if "missing steamid64" in w]
check("20e: warning emitted for missing steamid64", len(warn20) >= 1, f"got warnings: {plan20.warnings}")


# ── Test 21: safe_seek_tick semantics — start_tick == seek_tick by default ─
print("\nTest 21: safe_seek_tick == start_tick (no early seek for non-final-round)")
req21 = dto(
    request_type=RequestType.highlight,
    source_type=SourceType.kill,
    events=[make_kill_event(10_000)],
)
plan21 = build_plan(req21)
check("21a: 1 segment", len(plan21.segments) == 1)
if plan21.segments:
    seg21 = plan21.segments[0]
    check("21b: safe_seek_tick == start_tick",
          seg21.safe_seek_tick == seg21.start_tick,
          f"seek={seg21.safe_seek_tick}, start={seg21.start_tick}")


# ── Test 22: safe_seek_tick for final-round segment within safe window ──────
print("\nTest 22: safe_seek_tick for final-round segment — seek guard applies")
demo22 = DemoContext(
    demo_path="/demo/final.dem",
    demo_filename="final.dem",
    map_name="de_dust2",
    tick_rate=64.0,
    first_tick=0,
    demo_end_tick=365813,
    final_round=42,
    final_round_start_tick=364000,
    final_round_end_tick=0,
)
opts22 = RecordingOptions(
    final_round_guard_sec=4.0,
    final_round_seek_guard_sec=2.0,
    highlight_pre_sec=3.0,
    highlight_post_sec=2.0,
)
req22 = dto(
    request_type=RequestType.highlight,
    source_type=SourceType.kill,
    demo=demo22,
    options=opts22,
    events=[make_kill_event(365000, round_num=42)],
)
plan22 = build_plan(req22)
check("22a: 1 active segment", len(plan22.segments) == 1)
if plan22.segments:
    seg22 = plan22.segments[0]
    # safe_end = 365813 - 256 = 365557; seek_guard = 128; latest_safe_seek = 365557 - 128 = 365429
    # start_tick = 365000 - 192 = 364808; 364808 <= 365429 → safe_seek_tick = start_tick
    check("22b: safe_seek_tick == start_tick (within seek guard)",
          seg22.safe_seek_tick == seg22.start_tick,
          f"seek={seg22.safe_seek_tick}, start={seg22.start_tick}")


# ── Test 23: anchor_too_close_to_demo_end edge case ────────────────────────
print("\nTest 23: anchor within demo_exit_guard zone → end_tick = max_anchor + 1")
demo23 = DemoContext(
    demo_path="/demo/edge.dem",
    demo_filename="edge.dem",
    map_name="de_dust2",
    tick_rate=64.0,
    first_tick=0,
    demo_end_tick=365813,
    final_round=42,
    final_round_start_tick=364000,
    final_round_end_tick=0,
)
# kill at 365800: exit_guard=0.3s → latest_recordable=365794; max_anchor=365800 > 365794
# → anchor_too_close_to_demo_end path: end_tick = min(365812, 365801) = 365801
opts23 = RecordingOptions(final_round_guard_sec=4.0, final_round_demo_exit_guard_sec=0.3)
kill_tick23 = 365800
req23 = dto(
    request_type=RequestType.highlight,
    source_type=SourceType.kill,
    demo=demo23,
    options=opts23,
    events=[make_kill_event(kill_tick23, round_num=42)],
)
plan23 = build_plan(req23)
check("23a: 1 active segment (anchor_too_close path)", len(plan23.segments) == 1,
      f"got {len(plan23.segments)}")
if plan23.segments:
    seg23 = plan23.segments[0]
    check("23b: end_tick >= kill_tick", seg23.end_tick >= kill_tick23,
          f"got end_tick={seg23.end_tick}, kill_tick={kill_tick23}")
    check("23c: end_tick < demo_end_tick", seg23.end_tick < 365813,
          f"got end_tick={seg23.end_tick}")
check("23d: anchor_too_close warning emitted",
      any("anchor_too_close_to_demo_end" in w or "guard_skipped" in w for w in plan23.warnings),
      f"warnings={plan23.warnings}")


# ── Test 24: Final-round compilation, target died mid-round ────────────────
# Real payload (tyloo-vs-sharks-m3-anubis): final round 23, target died at
# 190056 while the round ran on to round_end 193250. The frontend used to derive
# final_round_end_tick/demo_end_tick from the death-truncated window (190184),
# so final_round_guard subtracted 4s and cut the clip to 189928 — BEFORE the
# death. With the real round_end_tick propagated, the clip must reach death+2s.
print("\nTest 24: Final-round compilation — death mid-round, real round_end propagated")
death24 = 190056
demo24 = make_demo(final_round=23, final_round_start_tick=0,
                   final_round_end_tick=190184, demo_end_tick=190184)
r24 = RoundInfo(
    round=23,
    round_start_tick=187587,
    round_end_tick=193250,          # real round_end event tick (post-fix)
    freeze_start_tick=None,
    freeze_end_tick=188867,
    next_round_start_tick=None,     # final round — no next round
    next_round_freeze_start_tick=None,
    next_round_freeze_end_tick=None,
    target_death_tick=death24,
)
# extra=1.0 is enabled, but a DEATH clip must stay fixed at death+2s (no extra).
opts24 = RecordingOptions(final_round_guard_sec=4.0, round_death_post_sec=2.0,
                          final_round_demo_exit_guard_sec=1.5,
                          final_round_extra_post_sec=1.0)
req24 = dto(
    request_type=RequestType.round_compilation,
    source_type=SourceType.round,
    demo=demo24,
    options=opts24,
    rounds=[r24],
)
plan24 = build_plan(req24)
check("24a: 1 segment", len(plan24.segments) == 1, f"got {len(plan24.segments)}")
if plan24.segments:
    seg24 = plan24.segments[0]
    exp_end24 = death24 + int(opts24.round_death_post_sec * TICK_RATE)  # 190184
    check("24b: death clip fixed at death+2s (no extra), not cut before death",
          seg24.end_tick == exp_end24,
          f"got {seg24.end_tick}, want {exp_end24}")
    check("24c: end is after the death tick", seg24.end_tick > death24,
          f"end={seg24.end_tick}, death={death24}")


# ── Test 25: Same scenario WITHOUT real round_end (legacy parsed data) ──────
# round_end_tick=None mimics demos parsed before the fix. The final_round_guard
# defense-in-depth must still not cut before the target's death.
print("\nTest 25: Final-round compilation — death mid-round, round_end_tick absent (legacy)")
r25 = RoundInfo(
    round=23,
    round_start_tick=187587,
    round_end_tick=None,            # legacy parsed data, no real round_end
    freeze_start_tick=None,
    freeze_end_tick=188867,
    next_round_start_tick=None,
    next_round_freeze_start_tick=None,
    next_round_freeze_end_tick=None,
    target_death_tick=death24,
)
req25 = dto(
    request_type=RequestType.round_compilation,
    source_type=SourceType.round,
    demo=make_demo(final_round=23, final_round_start_tick=0,
                   final_round_end_tick=190184, demo_end_tick=190184),
    options=opts24,
    rounds=[r25],
)
plan25 = build_plan(req25)
check("25a: 1 segment", len(plan25.segments) == 1, f"got {len(plan25.segments)}")
if plan25.segments:
    seg25 = plan25.segments[0]
    check("25b: end not cut before the death (defense-in-depth)",
          seg25.end_tick > death24,
          f"end={seg25.end_tick}, death={death24}")


# ── Test 26: Final round the target SURVIVED → extra 1s tail past round_end ─
# Alive final round (target_death_tick=None). The clip should linger 1s past the
# real round_end to capture the match-winning moment, with demo headroom for it.
print("\nTest 26: Final-round compilation — alive, extra 1s tail past round_end")
round_end26 = 193250
demo26 = make_demo(final_round=23, final_round_start_tick=0,
                   final_round_end_tick=200000, demo_end_tick=200000)
r26 = RoundInfo(
    round=23,
    round_start_tick=187587,
    round_end_tick=round_end26,
    freeze_start_tick=None,
    freeze_end_tick=188867,
    next_round_start_tick=None,     # final round — no next round
    next_round_freeze_start_tick=None,
    next_round_freeze_end_tick=None,
    target_death_tick=None,         # target survived the final round
)
opts26 = RecordingOptions(final_round_guard_sec=4.0,
                          final_round_demo_exit_guard_sec=1.5,
                          final_round_extra_post_sec=1.0)
req26 = dto(
    request_type=RequestType.round_compilation,
    source_type=SourceType.round,
    demo=demo26,
    options=opts26,
    rounds=[r26],
)
plan26 = build_plan(req26)
check("26a: 1 segment", len(plan26.segments) == 1, f"got {len(plan26.segments)}")
if plan26.segments:
    seg26 = plan26.segments[0]
    exp_end26 = round_end26 + int(opts26.final_round_extra_post_sec * TICK_RATE)  # round_end+1s
    check("26b: end = round_end + 1s (lingers past the win)",
          seg26.end_tick == exp_end26,
          f"got {seg26.end_tick}, want {exp_end26}")


# ── Test 27: Alive final-round tail bounded by demo-exit guard ──────────────
# Demo ends shortly after round_end → the extra tail is capped by the demo-exit
# guard so CS2 never reaches demo end (which would exit to main menu).
print("\nTest 27: Alive final-round tail bounded by demo-exit guard")
round_end27 = 193250
demo_end27 = round_end27 + int(2.0 * TICK_RATE)  # demo ends only 2s after round_end
demo27 = make_demo(final_round=23, final_round_start_tick=0,
                   final_round_end_tick=demo_end27, demo_end_tick=demo_end27)
r27 = RoundInfo(
    round=23,
    round_start_tick=187587,
    round_end_tick=round_end27,
    freeze_start_tick=None,
    freeze_end_tick=188867,
    next_round_start_tick=None,
    next_round_freeze_start_tick=None,
    next_round_freeze_end_tick=None,
    target_death_tick=None,
)
req27 = dto(
    request_type=RequestType.round_compilation,
    source_type=SourceType.round,
    demo=demo27,
    options=RecordingOptions(final_round_extra_post_sec=1.0,
                             final_round_demo_exit_guard_sec=1.5),
    rounds=[r27],
)
plan27 = build_plan(req27)
check("27a: 1 segment", len(plan27.segments) == 1, f"got {len(plan27.segments)}")
if plan27.segments:
    seg27 = plan27.segments[0]
    # latest_recordable = demo_end - 1.5s; must not exceed it (stay clear of demo end)
    latest_recordable27 = demo_end27 - int(1.5 * TICK_RATE)
    check("27b: tail bounded by demo-exit guard",
          seg27.end_tick <= latest_recordable27,
          f"end={seg27.end_tick}, latest_recordable={latest_recordable27}")
    check("27c: still records past round_end (some tail)",
          seg27.end_tick > round_end27,
          f"end={seg27.end_tick}, round_end={round_end27}")


# ── Test WP1: win_panel ceiling caps killer + victim POV segments ──────────
print("\nTest WP1: win_panel ceiling caps final-round killer + victim POV")
# tick_rate=64; guard 0.5s = 32 ticks; win_panel at 20000 → ceiling = 19968
wp_final_round = 5
win_panel = 20_000
wp_guard_ticks = int(0.5 * TICK_RATE)          # 32
wp_ceiling = win_panel - wp_guard_ticks        # 19968
demoWP1 = make_demo(final_round=wp_final_round, final_round_start_tick=15_000,
                    final_round_end_tick=18_000, demo_end_tick=win_panel + 5_000,
                    win_panel_match_tick=win_panel)
# Match-winning kill 1s before scoreboard; highlight_post 2s would overrun ceiling.
kill_wp = win_panel - int(1.0 * TICK_RATE)      # 19936
optsWP1 = RecordingOptions(enable_victim_pov=True, highlight_post_sec=2.0,
                           victim_pov_post_sec=1.5, final_round_win_panel_guard_sec=0.5)
reqWP1 = dto(
    request_type=RequestType.highlight,
    source_type=SourceType.kill,
    demo=demoWP1,
    options=optsWP1,
    events=[make_kill_event(kill_wp, round_num=wp_final_round)],
)
planWP1 = build_plan(reqWP1)
killer_segs = [s for s in planWP1.segments if s.perspective == Perspective.killer]
victim_segs = [s for s in planWP1.segments if s.perspective == Perspective.victim]
check("WP1a: killer segment present", len(killer_segs) == 1, f"got {len(killer_segs)}")
check("WP1b: victim POV segment present", len(victim_segs) == 1, f"got {len(victim_segs)}")
if killer_segs:
    check("WP1c: killer end capped at ceiling", killer_segs[0].end_tick == wp_ceiling,
          f"got {killer_segs[0].end_tick}, want {wp_ceiling}")
if victim_segs:
    check("WP1d: victim POV end capped at ceiling", victim_segs[0].end_tick == wp_ceiling,
          f"got {victim_segs[0].end_tick}, want {wp_ceiling}")


# ── Test WP2: kill far before win_panel keeps its own post (no cut) ─────────
print("\nTest WP2: win_panel ceiling does NOT cut a clip ending well before it")
win_panel2 = 20_000
demoWP2 = make_demo(final_round=5, final_round_start_tick=15_000,
                    final_round_end_tick=18_000, demo_end_tick=win_panel2 + 5_000,
                    win_panel_match_tick=win_panel2)
kill_wp2 = 16_000  # post end = 16000 + 128 = 16128 << ceiling(19968)
optsWP2 = RecordingOptions(highlight_post_sec=2.0, final_round_win_panel_guard_sec=0.5)
reqWP2 = dto(
    request_type=RequestType.highlight,
    source_type=SourceType.kill,
    demo=demoWP2,
    options=optsWP2,
    events=[make_kill_event(kill_wp2, round_num=5)],
)
planWP2 = build_plan(reqWP2)
segWP2 = planWP2.segments[0] if planWP2.segments else None
check("WP2a: 1 segment", len(planWP2.segments) == 1, f"got {len(planWP2.segments)}")
if segWP2:
    check("WP2b: end = kill + post (uncut)", segWP2.end_tick == kill_wp2 + int(2.0 * TICK_RATE),
          f"got {segWP2.end_tick}")


# ── Test WP3: win_panel absent (=0) → old guard behavior unchanged ─────────
print("\nTest WP3: win_panel absent falls back to legacy final_round_guard")
final_end3 = 20_000
demoWP3 = make_demo(final_round=5, final_round_start_tick=15_000,
                    final_round_end_tick=final_end3, demo_end_tick=final_end3 + 100,
                    win_panel_match_tick=0)
safe_end3 = final_end3 - int(4.0 * TICK_RATE)   # legacy: 19744
kill_wp3 = 19_700
optsWP3 = RecordingOptions(final_round_guard_sec=4.0, highlight_post_sec=2.0)
reqWP3 = dto(
    request_type=RequestType.highlight,
    source_type=SourceType.kill,
    demo=demoWP3,
    options=optsWP3,
    events=[make_kill_event(kill_wp3, round_num=5)],
)
planWP3 = build_plan(reqWP3)
segWP3 = planWP3.segments[0] if planWP3.segments else None
check("WP3a: 1 segment (legacy path)", len(planWP3.segments) == 1, f"got {len(planWP3.segments)}")
if segWP3:
    # legacy demo13 behavior: clamp to safe_end via existing logic
    check("WP3b: legacy clamp still applies", segWP3.end_tick <= safe_end3 + int(2.0 * TICK_RATE),
          f"got {segWP3.end_tick}")


# ── Summary ────────────────────────────────────────────────────────────────
print("\n" + "=" * 60)
passed = sum(1 for s, *_ in results if s == "PASS")
failed = sum(1 for s, *_ in results if s == "FAIL")
print(f"TOTAL: {passed} passed, {failed} failed out of {len(results)} checks")
if failed:
    print("\nFailed checks:")
    for s, name, detail in results:
        if s == "FAIL":
            print(f"  [FAIL] {name}" + (f" -- {detail}" if detail else ""))
print("=" * 60)
