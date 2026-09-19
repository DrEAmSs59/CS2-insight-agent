import { describe, expect, it } from "vitest";
import {
  ANIMATION_DURATION_SEC,
  candidateKeyFromClip,
  clipIdsFromTimeline,
  deriveRadarCandidatesFromClips,
  exportTimelineIds,
  insertRelativeTo,
  isRadarTimelineId,
  makeRadarTimelineId,
  migrateRadarSegmentsIntoTimeline,
  parseTimelineDragId,
  radarInstanceDurationPlan,
  sortTimelineKeepingRadar,
  hydrateTimelineFromDraft,
} from "./radarTimeline.js";

describe("radarTimeline", () => {
  it("builds one candidate per demo × POV player", () => {
    const clips = [
      { id: 1, demo_path: "C:/demos/mirage.dem", demo_filename: "mirage.dem", player_name: "s1mple", target_steamid64: "111" },
      { id: 2, demo_path: "C:/demos/mirage.dem", demo_filename: "mirage.dem", player_name: "s1mple", target_steamid64: "111" },
      { id: 3, demo_path: "C:/demos/inferno.dem", demo_filename: "inferno.dem", player_name: "s1mple", target_steamid64: "111" },
    ];
    const candidates = deriveRadarCandidatesFromClips(clips);
    expect(candidates).toHaveLength(2);
    expect(candidates[0].player_name).toBe("s1mple");
    expect(candidates[0].demo_filename).toBe("mirage.dem");
    expect(candidates[0].segment_count).toBe(2);
    expect(candidates[1].demo_filename).toBe("inferno.dem");
    expect(candidates[0].key).not.toBe(candidates[1].key);
    expect(candidateKeyFromClip(clips[0])).toBe(candidates[0].key);
  });

  it("treats radar ids as first-class timeline rows", () => {
    const radarId = makeRadarTimelineId("abc");
    expect(isRadarTimelineId(radarId)).toBe(true);
    expect(isRadarTimelineId(12)).toBe(false);
    expect(clipIdsFromTimeline([12, radarId, 15])).toEqual([12, 15]);
  });

  it("inserts a radar row before or after any existing row", () => {
    const radarId = makeRadarTimelineId("r1");
    expect(insertRelativeTo([10, 11], radarId, { beforeId: 11 })).toEqual([10, radarId, 11]);
    expect(insertRelativeTo([10, 11], radarId, { afterId: 11 })).toEqual([10, 11, radarId]);
  });

  it("migrates legacy before-clip radar segments into independent rows", () => {
    const migrated = migrateRadarSegmentsIntoTimeline([10, 11], [
      { uid: "u1", before_clip_id: 11, duration: 6, player_name: "s1mple", candidate_key: "k1" },
    ]);
    expect(migrated.orderedIds[0]).toBe(10);
    expect(isRadarTimelineId(migrated.orderedIds[1])).toBe(true);
    expect(migrated.orderedIds[2]).toBe(11);
    expect(migrated.radarItems[migrated.orderedIds[1]].duration).toBe(6);
    expect(migrated.radarItems[migrated.orderedIds[1]].candidateKey).toBe("k1");
  });

  it("drops radar rows from export when the switch is off, keeping clip order", () => {
    const radarId = makeRadarTimelineId("r1");
    const ids = [10, radarId, 11];
    expect(exportTimelineIds(ids, { radarEnabled: true })).toEqual(ids);
    expect(exportTimelineIds(ids, { radarEnabled: false })).toEqual([10, 11]);
  });

  it("pads or trims the 4s animation to the instance duration", () => {
    expect(ANIMATION_DURATION_SEC).toBe(4);
    expect(radarInstanceDurationPlan(6).mode).toBe("pad");
    expect(radarInstanceDurationPlan(2).mode).toBe("trim");
    expect(radarInstanceDurationPlan(4).mode).toBe("exact");
    expect(radarInstanceDurationPlan(6).outputDuration).toBe(6);
  });

  it("keeps radar rows attached to the following clip when sorting clips", () => {
    const radarA = makeRadarTimelineId("a");
    const radarB = makeRadarTimelineId("b");
    const radarTail = makeRadarTimelineId("tail");
    const sorted = sortTimelineKeepingRadar([radarA, 10, radarB, 11, radarTail], [11, 10]);
    expect(sorted).toEqual([radarB, 11, radarA, 10, radarTail]);
  });

  it("hydrates mixed timeline ids and keeps orphan radar rows", () => {
    const radarId = makeRadarTimelineId("orphan");
    const hydrated = hydrateTimelineFromDraft({
      timelineIds: [10, radarId, 99],
      radarItems: { [radarId]: { candidateKey: "k1", playerName: "s1mple", duration: 5 } },
      availableClipIds: [10],
    });
    expect(hydrated.orderedIds).toEqual([10, radarId]);
    expect(hydrated.radarItems[radarId].playerName).toBe("s1mple");
    expect(parseTimelineDragId(radarId)).toBe(radarId);
    expect(parseTimelineDragId("12")).toBe(12);
  });
});
