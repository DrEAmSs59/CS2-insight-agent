import { beforeEach, describe, expect, it } from "vitest";
import { useRecordingQueue } from "../stores/recordingQueueStore";
import { mergedPacingForItem } from "./recordingQueueDerive";
import { limitRecordingPacing, MAX_EVENT_PREROLL_SECONDS } from "./recordingPacing";

describe("recording pre-roll limit", () => {
  beforeEach(() => useRecordingQueue.setState({ queue: [], globalPacing: {}, presetPacing: {} }));

  it("only caps excessive pre-roll and preserves explicit zero and unrelated settings", () => {
    const original = { pre_first_sec: 20, post_last_sec: 10, max_gap_sec: 2, default_victim_pov: true };
    expect(limitRecordingPacing(original)).toEqual({ ...original, pre_first_sec: MAX_EVENT_PREROLL_SECONDS });
    expect(original.pre_first_sec).toBe(20);
    expect(limitRecordingPacing({ pre_first_sec: 0 }).pre_first_sec).toBe(0);
    expect(limitRecordingPacing({})).toEqual({});
  });

  it.each(["hydrateGlobalPacing", "hydratePresetPacing", "setGlobalPacing", "setPresetPacing"])(
    "limits legacy values through %s", (action) => {
      useRecordingQueue.getState()[action]({ pre_first_sec: 20, post_last_sec: 10, max_gap_sec: 2 });
      const key = action.includes("Preset") ? "presetPacing" : "globalPacing";
      expect(useRecordingQueue.getState()[key]).toEqual({ pre_first_sec: 10, post_last_sec: 10, max_gap_sec: 2 });
    },
  );

  it("limits restored queue items and subsequent per-item edits", () => {
    useRecordingQueue.getState().addToQueue({ id: "old-item", pacing_override: { pre_first_sec: 20, max_gap_sec: 2 } });
    expect(useRecordingQueue.getState().queue[0].pacing_override.pre_first_sec).toBe(10);
    useRecordingQueue.getState().updateItemPacing("old-item", { pre_first_sec: 19, post_last_sec: 10 });
    expect(useRecordingQueue.getState().queue[0].pacing_override)
      .toEqual({ pre_first_sec: 10, post_last_sec: 10, max_gap_sec: 2 });
  });

  it("keeps preview padding and per-item priority consistent with the request limit", () => {
    expect(mergedPacingForItem({ pacing_override: { pre_first_sec: 20 } }, { pre_first_sec: 3 }).pre_first_sec).toBe(10);
    expect(mergedPacingForItem({ pacing_override: { pre_first_sec: 4 } }, { pre_first_sec: 20 }).pre_first_sec).toBe(4);
    expect(mergedPacingForItem({}, {})).toEqual({ pre_first_sec: 2, post_last_sec: 1, max_gap_sec: 12 });
  });
});
