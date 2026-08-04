import { describe, expect, it } from "vitest";
import { effectiveHighFrameBlendFrames, getHighFrameBlendPlan, getClipFps, isFrameBlendSourceSupported, summarizeFrameBlendSources } from "./frameBlend";

describe("frame blend delivery plan", () => {
  it("uses four-frame blending for 240 to 60", () => {
    expect(getHighFrameBlendPlan(240, 60)).toEqual({ sourceFps: 240, deliveryFps: 60, frames: 4 });
    expect(effectiveHighFrameBlendFrames(239.76, 60, 5)).toBe(4);
  });

  it("uses two-frame blending for 120 to 60", () => {
    expect(getHighFrameBlendPlan(120, 60)).toEqual({ sourceFps: 120, deliveryFps: 60, frames: 2 });
    expect(effectiveHighFrameBlendFrames(119.88, 60, 5)).toBe(2);
  });

  it("leaves 60 to 60 on the manual legacy setting", () => {
    expect(getHighFrameBlendPlan(60, 60)).toBeNull();
    expect(effectiveHighFrameBlendFrames(60, 60, 7)).toBe(7);
  });

  it("only enables frame blending from 120 FPS upward", () => {
    expect(isFrameBlendSourceSupported(60)).toBe(false);
    expect(isFrameBlendSourceSupported(119.5)).toBe(true);
    expect(isFrameBlendSourceSupported(120)).toBe(true);
  });

  it("summarizes all clips before enabling frame blending", () => {
    expect(getClipFps({ fps: "240" })).toBe(240);
    expect(summarizeFrameBlendSources([{ fps: 240 }, { fps: 60 }])).toMatchObject({
      primaryFps: 240,
      hasUnknownFps: false,
      allSupported: false,
    });
    expect(summarizeFrameBlendSources([{ fps: 120 }, { fps: 240 }]).allSupported).toBe(true);
  });
});
