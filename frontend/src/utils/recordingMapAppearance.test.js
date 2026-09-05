import { describe, expect, it } from "vitest";

import {
  DEFAULT_RECORDING_MAP_APPEARANCE,
  RAIN_RECORDING_MAP_APPEARANCE,
  WAXED_RECORDING_MAP_APPEARANCE,
  recordingMapAppearanceId,
  splitRecordingMapAppearance,
} from "./recordingMapAppearance.js";

describe("recordingMapAppearance", () => {
  it("maps original, waxed, and rain onto mutually exclusive stored fields", () => {
    expect(splitRecordingMapAppearance(DEFAULT_RECORDING_MAP_APPEARANCE)).toEqual({
      mapMaterial: "default",
      weatherEffect: "default",
    });
    expect(splitRecordingMapAppearance(WAXED_RECORDING_MAP_APPEARANCE)).toEqual({
      mapMaterial: "waxed_reflection",
      weatherEffect: "default",
    });
    expect(splitRecordingMapAppearance(RAIN_RECORDING_MAP_APPEARANCE)).toEqual({
      mapMaterial: "default",
      weatherEffect: "rain",
    });
  });

  it("prefers rain when both stored fields are present and falls back to original", () => {
    expect(recordingMapAppearanceId("default", "default")).toBe("default");
    expect(recordingMapAppearanceId("waxed_reflection", "default")).toBe("waxed_reflection");
    expect(recordingMapAppearanceId("default", "rain")).toBe("rain");
    expect(recordingMapAppearanceId("waxed_reflection", "rain")).toBe("rain");
    expect(recordingMapAppearanceId("unknown", "blizzard")).toBe("default");
  });
});
