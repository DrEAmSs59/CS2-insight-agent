import { describe, expect, it } from "vitest";
import { inspectorTabForTimelineSelection } from "./inspectorSelectionUtils.js";

const body = {
  tracks: [
    { id: "v1", type: "video" },
    { id: "a1", type: "audio" },
  ],
  overlays: [
    { id: "title", type: "text" },
    { id: "logo", type: "sticker" },
    { id: "alpha", type: "webm" },
  ],
};

describe("inspectorTabForTimelineSelection", () => {
  it("opens text only for text overlays", () => {
    expect(inspectorTabForTimelineSelection(body, "title", "overlay")).toBe("text");
    expect(inspectorTabForTimelineSelection(body, "logo", "overlay")).toBe("clip");
    expect(inspectorTabForTimelineSelection(body, "alpha", "overlay")).toBe("clip");
  });

  it("opens clip for video and audio for audio", () => {
    expect(inspectorTabForTimelineSelection(body, "video", "v1")).toBe("clip");
    expect(inspectorTabForTimelineSelection(body, "sound", "a1")).toBe("audio");
  });
});
