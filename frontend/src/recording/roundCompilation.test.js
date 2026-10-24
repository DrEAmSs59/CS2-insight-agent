import { describe, expect, test } from "vitest";
import { buildRoundCompilationRecordingRequest } from "./recordingRequestFactory";
import { sliceFreezeToDeathClipForEnqueue } from "../utils/freezeToDeathRoundFilter";
import { estimateItemRecordSeconds, estimateQueueTotalSeconds } from "../utils/recordingQueueDerive";
import { getClipDurationSeconds } from "../utils/montageUtils";
import { buildDtoFromQueueItem } from "./buildDtoFromQueueItem";

const facts = [
  { round: 1, round_start_tick: 5000, freeze_end_tick: 6400, death_tick: 12800, round_end_tick: 14000 },
  { round: 2, round_start_tick: 15000, freeze_end_tick: 16000, death_tick: null, round_end_tick: 20000 },
  { round: 3, round_start_tick: 21000, freeze_end_tick: 22000, death_tick: null, round_end_tick: 28000 },
];
const clip = { category: "compilation", compilation_kind: "freeze_to_death", round_facts: facts, tick_rate: 64 };
const item = { id: "rounds", targetPlayer: "Player", targetSteamId: "123", demoPath: "match.dem", clipData: clip };
const meta = { total_rounds: 3, demo_end_tick: 30000 };
const build = (data, m = meta) => buildRoundCompilationRecordingRequest(data, item, m);

describe("shared round compilation contract", () => {
  test("dedicated per-item timings override globals without affecting other clip types or guards", () => {
    const pacing = { round_freeze_preroll_sec: 5.5, round_death_post_sec: 4.25, round_alive_post_sec: 1.5, pre_first_sec: 17, post_last_sec: 8 };
    const options = buildDtoFromQueueItem({ ...item, pacing_override: pacing }, meta).options;
    expect(options).toMatchObject({ round_freeze_preroll_sec: 5.5, round_death_post_sec: 4.25,
      round_alive_post_sec: 1.5, demo_end_guard_sec: 1.5, final_round_extra_post_sec: 2 });
    const minimums = buildDtoFromQueueItem({ ...item, pacing_override: { round_freeze_preroll_sec: 3, round_death_post_sec: 2 } }, meta, pacing);
    expect(minimums.options).toMatchObject({ round_freeze_preroll_sec: 3, round_death_post_sec: 2, round_alive_post_sec: 1.5 });
    expect(buildDtoFromQueueItem(item, meta, { pre_first_sec: 17, post_last_sec: 8 }).options)
      .toMatchObject({ round_freeze_preroll_sec: 3, round_death_post_sec: 2, round_alive_post_sec: 3 });
    for (const clipData of [
      { ...clip, timeline_source: "round_timeline_round", round: 1, start_tick: 5000, end_tick: 14000 },
      { category: "highlight", kill_ticks: [10000], end_tick: 14000 },
    ]) {
      expect(buildDtoFromQueueItem({ ...item, clipData, pacing_override: pacing }, meta, pacing).options)
        .toMatchObject({ round_freeze_preroll_sec: 3, round_death_post_sec: 2, round_alive_post_sec: 3 });
    }
  });
  test("old and new analyses produce the same DTO; baked windows cannot change it", () => {
    const legacy = { ...clip, round_facts: undefined, freeze_to_death_round_windows: facts.map((r) => ({ ...r, start_tick: 1, end_tick: 999999 })), source_ticks: [[1, 999999]], kill_ticks: [7], clip_max_tick: 999999 };
    const { request_id: a, ...current } = build(clip);
    const { request_id: b, ...old } = build(legacy);
    expect(old).toEqual(current);
    expect(old.events).toEqual([]);
    expect(old.demo.demo_end_tick).toBe(30000);
  });
  test("selection preserves real neighbours even for nonadjacent selected rounds", () => {
    const selected = sliceFreezeToDeathClipForEnqueue({ ...clip, source_ticks: [[1, 5]], kill_ticks: [5] }, [1, 3]);
    expect(selected.ok).toBe(true);
    expect(selected.clip.round_facts).toHaveLength(3);
    expect(selected.clip).not.toHaveProperty("source_ticks");
    expect(selected.clip).not.toHaveProperty("kill_ticks");
    const request = build(selected.clip);
    expect(request.rounds.map((r) => r.round)).toEqual([1, 3]);
    expect(request.rounds[0].next_round_start_tick).toBe(15000);
    expect(request.rounds[1].next_round_start_tick).toBeNull();
  });
  test("a missing first-round start does not discard its precise freeze-end event", () => {
    const data = { ...clip, round_facts: [{ ...facts[0], round_start_tick: null }, ...facts.slice(1)] };
    expect(build(data).rounds[0].round_start_tick).toBeNull();
    expect(build(data).rounds[0].freeze_end_tick).toBe(6400);
  });
  test("missing round records still fail but existing metadata fallbacks remain usable", () => {
    for (const data of [
      { ...clip, round_facts: undefined, source_ticks: [[1, 999]] },
      { ...clip, round_facts: [null] },
    ]) expect(() => build(data)).toThrow("ftd.errorNoWindows");
    expect(build(clip, { total_rounds: 3 }).demo.demo_end_tick).toBe(28000);
    expect(build({ ...clip, round_facts: [facts[0]] }).rounds[0].next_round_start_tick).toBeNull();
    expect(build({ ...clip, round_facts: facts.map(({ death_tick, ...r }) => r) }).rounds[0].target_death_tick).toBeNull();
    expect(() => build({ ...clip, freeze_to_death_round_filter: [] })).toThrow("ftd.errorNeedsRound");
    expect(sliceFreezeToDeathClipForEnqueue(clip, [4]).errorKey).toBe("ftd.errorNoIntersect");
  });
  test("duration stays unknown until the backend plan is available", () => {
    const old = { ...item, clipData: { ...clip, kill_ticks: [12800], source_ticks: [[1, 999999]], start_tick: 1, end_tick: 999999 } };
    expect(estimateItemRecordSeconds(old, {})).toBeNull();
    expect(estimateQueueTotalSeconds([old], {})).toBeNull();
    const state = { status: "ready", plan: { estimated_duration_sec: 105 } };
    expect(estimateItemRecordSeconds(old, {}, state)).toBe(105);
    expect(estimateQueueTotalSeconds([old], {}, { rounds: state })).toBe(105);
    expect(getClipDurationSeconds(old.clipData)).toBeNull();
    expect(getClipDurationSeconds({ ...old.clipData, duration_sec: 104.5 })).toBe(104.5);
  });
});
