import { describe, expect, it } from "vitest";
import { getFrameMeldSourceFps, summarizeFrameMeldSources } from "./framemeld";

describe("FrameMeld source boundary", () => {
  it("accepts one source frame-rate family including reported-rate drift", () => {
    expect(summarizeFrameMeldSources([{ fps: 119.88 }, { fps: 120 }])).toMatchObject({
      compatible: true,
      hasUnknownFps: false,
      hasMixedFrameRates: false,
    });
  });

  it("rejects mixed source timelines instead of copying FrameMeld policy", () => {
    expect(summarizeFrameMeldSources([{ fps: 60 }, { fps: 240 }])).toMatchObject({
      compatible: false,
      hasMixedFrameRates: true,
    });
  });

  it("rejects missing or invalid source rates", () => {
    expect(getFrameMeldSourceFps({ fps: 0 })).toBeNull();
    expect(summarizeFrameMeldSources([{ fps: null }])).toMatchObject({
      compatible: false,
      hasUnknownFps: true,
    });
  });
});
