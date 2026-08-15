import { describe, expect, it } from "vitest";
import { mergeTimelineRequestsForRecording } from "./recordingBatch.js";
import { buildDtoFromQueueItem } from "../recording/buildDtoFromQueueItem.js";
import { buildTimelineEventClipData } from "./timelineQueue.js";

const MATCH_META = { map_name: "de_mirage", all_players: [] };

function timelineQueueItem(event, id) {
  const clipData = buildTimelineEventClipData({ event });
  return {
    id: id || `q-${event.tick}`,
    demoPath: "C:/demos/match.dem",
    demoFilename: "match.dem",
    targetPlayer: "target",
    targetPlayerUserId: 1,
    targetSteamId: "7656119",
    clipId: clipData.clip_id,
    clientClipUid: clipData.client_clip_uid,
    clipData,
  };
}

const makeKillEvent = (tick, victim) => ({
  type: "kill",
  record_type: "kill",
  tick,
  round: 1,
  attacker_name: "target",
  attacker_steamid: "7656119",
  attacker_spec_slot: 3,
  victim_name: victim,
  victim_steamid: `${victim}-sid`,
  victim_spec_slot: 4,
  start_tick: tick - 64 * 3,
  end_tick: tick + 64 * 2,
});

const makeDeathEvent = (tick, attacker) => ({
  type: "death",
  record_type: "death",
  tick,
  round: 1,
  attacker_name: attacker,
  attacker_steamid: `${attacker}-sid`,
  attacker_spec_slot: 9,
  victim_name: "target",
  victim_steamid: "7656119",
  victim_spec_slot: 3,
  start_tick: tick - 64 * 3,
  end_tick: tick + 64 * 2,
});

function buildDtos(items) {
  return items.map((it) => buildDtoFromQueueItem(it, MATCH_META));
}

describe("mergeTimelineRequestsForRecording", () => {
  it("returns input when merge disabled/empty", () => {
    expect(mergeTimelineRequestsForRecording([], { thresholdSec: 12 })).toEqual([]);
    const dto = buildDtoFromQueueItem(
      timelineQueueItem(makeKillEvent(1000, "one"), "q1"),
      MATCH_META,
    );
    const out = mergeTimelineRequestsForRecording([dto], { thresholdSec: 12 });
    expect(out).toHaveLength(1);
    expect(out[0].request_type).toBe("timeline_kill");
  });

  it("keeps queue clip type as timeline even when merging", () => {
    const dto = buildDtoFromQueueItem(
      timelineQueueItem(makeKillEvent(1000, "one"), "q1"),
      MATCH_META,
    );
    const out = mergeTimelineRequestsForRecording([dto], { thresholdSec: 12 });
    expect(out[0].request_type).toBe("timeline_kill");
    expect(out[0].source_type).toBe("kill");
  });

  it("merges close timeline kills into a single timeline_kill request", () => {
    const items = [
      timelineQueueItem(makeKillEvent(1000, "one"), "q1"),
      timelineQueueItem(makeKillEvent(1400, "two"), "q2"), // 6.25s apart, within 12s
    ];
    const out = mergeTimelineRequestsForRecording(buildDtos(items), { thresholdSec: 12, tickRate: 64 });
    expect(out).toHaveLength(1);
    expect(out[0].request_type).toBe("timeline_kill");
    expect(out[0].events).toHaveLength(2);
    expect(out[0].events.map((e) => e.tick)).toEqual([1000, 1400]);
    expect(out[0]._merged_from).toBe(2);
  });

  it("splits timeline kills beyond the threshold into separate requests", () => {
    const items = [
      timelineQueueItem(makeKillEvent(1000, "one"), "q1"),
      timelineQueueItem(makeKillEvent(3000, "two"), "q2"), // 31.25s apart, beyond 12s
    ];
    const out = mergeTimelineRequestsForRecording(buildDtos(items), { thresholdSec: 12, tickRate: 64 });
    expect(out).toHaveLength(2);
    expect(out[0].events[0].tick).toBe(1000);
    expect(out[1].events[0].tick).toBe(3000);
  });

  it("merges a kill followed by a quick death into one timeline_kill request", () => {
    const items = [
      timelineQueueItem(makeKillEvent(1000, "one"), "q1"),
      timelineQueueItem(makeDeathEvent(1200, "enemy"), "q2"), // 3.125s after the kill
    ];
    const out = mergeTimelineRequestsForRecording(buildDtos(items), { thresholdSec: 12, tickRate: 64 });
    expect(out).toHaveLength(1);
    expect(out[0].request_type).toBe("timeline_kill"); // kill dominates
    expect(out[0].events.map((e) => e.tick)).toEqual([1000, 1200]);
    expect(out[0].events.map((e) => e.event_type)).toEqual(["kill", "death"]);
  });

  it("does not merge timeline events across different rounds", () => {
    const items = [
      timelineQueueItem({ ...makeKillEvent(1000, "one"), round: 1 }, "q1"),
      timelineQueueItem({ ...makeKillEvent(1400, "two"), round: 2 }, "q2"),
    ];
    const out = mergeTimelineRequestsForRecording(buildDtos(items), { thresholdSec: 12, tickRate: 64 });
    expect(out).toHaveLength(2);
    expect(out[0].events[0].round).toBe(1);
    expect(out[1].events[0].round).toBe(2);
  });

  it("keeps non-timeline requests untouched", () => {
    const dto = buildDtoFromQueueItem(
      timelineQueueItem(makeKillEvent(1000, "one"), "q1"),
      MATCH_META,
    );
    const highlight = {
      request_id: "h1",
      request_type: "highlight",
      source_type: "kill",
      events: [{ tick: 2000 }],
    };
    const out = mergeTimelineRequestsForRecording([dto, highlight], { thresholdSec: 12 });
    // dto is timeline_kill (single → passthrough), highlight untouched.
    expect(out.some((r) => r.request_type === "highlight")).toBe(true);
  });
});
