import { describe, expect, it } from "vitest";

import {
  advancePreviewVideoHandoff,
  completePreviewVideoHandoff,
  createPreviewVideoHandoff,
  previewVideoSlotVisible,
} from "./previewVideoHandoff.js";

describe("preview video handoff", () => {
  it("keeps the presented source visible while the next source loads", () => {
    const first = createPreviewVideoHandoff("clip-a:/a.mp4", "/a.mp4");
    const switching = advancePreviewVideoHandoff(first, "clip-b:/b.mp4", "/b.mp4");

    expect(switching.slots).toEqual([
      { identity: "clip-a:/a.mp4", streamUrl: "/a.mp4" },
      { identity: "clip-b:/b.mp4", streamUrl: "/b.mp4" },
    ]);
    expect(previewVideoSlotVisible(switching, 0)).toBe(true);
    expect(previewVideoSlotVisible(switching, 1)).toBe(false);

    const completed = completePreviewVideoHandoff(switching, "clip-b:/b.mp4");
    expect(completed.slots).toEqual([null, { identity: "clip-b:/b.mp4", streamUrl: "/b.mp4" }]);
    expect(previewVideoSlotVisible(completed, 1)).toBe(true);
  });

  it("replaces an unpresented incoming source without dropping the last visible frame", () => {
    const first = createPreviewVideoHandoff("clip-a:/a.mp4", "/a.mp4");
    const switchingToB = advancePreviewVideoHandoff(first, "clip-b:/b.mp4", "/b.mp4");
    const switchingToC = advancePreviewVideoHandoff(switchingToB, "clip-c:/c.mp4", "/c.mp4");

    expect(switchingToC.activeIndex).toBe(1);
    expect(switchingToC.outgoingIndex).toBe(0);
    expect(switchingToC.slots[0].streamUrl).toBe("/a.mp4");
    expect(switchingToC.slots[1].streamUrl).toBe("/c.mp4");
    expect(previewVideoSlotVisible(switchingToC, 0)).toBe(true);
  });

  it("clears both slots when the timeline reaches an empty gap", () => {
    const first = createPreviewVideoHandoff("clip-a:/a.mp4", "/a.mp4");
    const empty = advancePreviewVideoHandoff(first, "none:", null);

    expect(empty.slots).toEqual([null, null]);
    expect(empty.pending).toBe(false);
  });
});
