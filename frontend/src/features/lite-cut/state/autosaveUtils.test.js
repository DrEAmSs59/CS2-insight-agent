import { describe, expect, it } from "vitest";
import {
  LITE_CUT_AUTOSAVE_DELAY_MS,
  LITE_CUT_AUTOSAVE_FLUSH_EVENTS,
  shouldFlushLiteCutAutosave,
  shouldScheduleLiteCutAutosave,
} from "./autosaveUtils.js";

describe("liteCut autosave utils", () => {
  it("uses a short editing-friendly debounce", () => {
    expect(LITE_CUT_AUTOSAVE_DELAY_MS).toBeGreaterThanOrEqual(1000);
    expect(LITE_CUT_AUTOSAVE_DELAY_MS).toBeLessThanOrEqual(3000);
  });

  it("schedules autosave only for dirty loaded projects", () => {
    const ready = { projectId: 3, body: { tracks: [] }, dirty: true, loading: false, saving: false };
    expect(shouldScheduleLiteCutAutosave(ready)).toBe(true);
    expect(shouldScheduleLiteCutAutosave({ ...ready, dirty: false })).toBe(false);
    expect(shouldScheduleLiteCutAutosave({ ...ready, projectId: null })).toBe(false);
    expect(shouldScheduleLiteCutAutosave({ ...ready, body: null })).toBe(false);
    expect(shouldScheduleLiteCutAutosave({ ...ready, loading: true })).toBe(false);
    expect(shouldScheduleLiteCutAutosave({ ...ready, saving: true })).toBe(false);
  });

  it("flushes autosave on pagehide and hidden visibility changes only", () => {
    const ready = { projectId: 3, body: { tracks: [] }, dirty: true, loading: false, saving: false };
    expect(LITE_CUT_AUTOSAVE_FLUSH_EVENTS).toEqual(["beforeunload", "pagehide", "visibilitychange"]);
    expect(shouldFlushLiteCutAutosave({ type: "beforeunload" }, ready)).toBe(true);
    expect(shouldFlushLiteCutAutosave({ type: "pagehide" }, ready)).toBe(true);
    expect(
      shouldFlushLiteCutAutosave({ type: "visibilitychange", target: { visibilityState: "hidden" } }, ready),
    ).toBe(true);
    expect(
      shouldFlushLiteCutAutosave({ type: "visibilitychange", target: { visibilityState: "visible" } }, ready),
    ).toBe(false);
    expect(shouldFlushLiteCutAutosave({ type: "pagehide" }, { ...ready, dirty: false })).toBe(false);
  });
});
