import { describe, expect, it } from "vitest";
import { effectiveHighFrameBlendFrames, getHighFrameBlendPlan, getClipFps, isFrameBlendSourceSupported, summarizeFrameBlendSources } from "./frameBlend";

describe("frame blend delivery plan", () => {
  it("previews the custom 240 to 480 to 60 policy", () => {
    expect(getHighFrameBlendPlan(240, 60)).toEqual({
      sourceFps: 240, targetFps: 480, deliveryFps: 60, multiplier: 2, frames: 8,
    });
    expect(effectiveHighFrameBlendFrames(240, 60, 5)).toBe(8);
  });

  it("previews automatic integer multiples for low and intermediate rates", () => {
    expect(getHighFrameBlendPlan(60, 60)).toMatchObject({ targetFps: 300, multiplier: 5, frames: 5 });
    expect(getHighFrameBlendPlan(120, 60)).toMatchObject({ targetFps: 360, multiplier: 3, frames: 6 });
    expect(getHighFrameBlendPlan(53, 60)).toMatchObject({ targetFps: 212, multiplier: 4, frames: 4 });
  });

  it("keeps native 360 without interpolation", () => {
    expect(getHighFrameBlendPlan(360, 60)).toMatchObject({ targetFps: 360, multiplier: 1, frames: 6 });
  });

  it("enables the custom pipeline for every positive known FPS", () => {
    expect(isFrameBlendSourceSupported(30)).toBe(true);
    expect(isFrameBlendSourceSupported(60)).toBe(true);
    expect(isFrameBlendSourceSupported(120)).toBe(true);
    expect(isFrameBlendSourceSupported(null)).toBe(false);
  });

  it("summarizes all clips before enabling frame blending", () => {
    expect(getClipFps({ fps: "240" })).toBe(240);
    expect(summarizeFrameBlendSources([{ fps: 240 }, { fps: 60 }])).toMatchObject({
      primaryFps: 240,
      hasUnknownFps: false,
      allSupported: true,
    });
    expect(summarizeFrameBlendSources([{ fps: 120 }, { fps: 240 }]).allSupported).toBe(true);
  });
});
