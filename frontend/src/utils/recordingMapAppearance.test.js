import { describe, expect, it, vi } from "vitest";

import {
  DEFAULT_RECORDING_MAP_APPEARANCE,
  RAIN_RECORDING_MAP_APPEARANCE,
  WAXED_RECORDING_MAP_APPEARANCE,
  applyRecordingMapAppearanceSelection,
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

  it("selecting rain resets the skybox to Train overcast while leaving other appearances alone", () => {
    const onRecordingMapMaterialChange = vi.fn();
    const onRecordingWeatherEffectChange = vi.fn();
    const onRecordingSkyboxChange = vi.fn();
    const handlers = {
      onRecordingMapMaterialChange,
      onRecordingWeatherEffectChange,
      onRecordingSkyboxChange,
    };

    applyRecordingMapAppearanceSelection(RAIN_RECORDING_MAP_APPEARANCE, handlers);
    expect(onRecordingMapMaterialChange).toHaveBeenCalledWith("default");
    expect(onRecordingWeatherEffectChange).toHaveBeenCalledWith("rain");
    expect(onRecordingSkyboxChange).toHaveBeenCalledWith("default");

    onRecordingMapMaterialChange.mockClear();
    onRecordingWeatherEffectChange.mockClear();
    onRecordingSkyboxChange.mockClear();
    applyRecordingMapAppearanceSelection(WAXED_RECORDING_MAP_APPEARANCE, handlers);
    expect(onRecordingMapMaterialChange).toHaveBeenCalledWith("waxed_reflection");
    expect(onRecordingWeatherEffectChange).toHaveBeenCalledWith("default");
    expect(onRecordingSkyboxChange).not.toHaveBeenCalled();
  });

  it("prefers rain when both stored fields are present and falls back to original", () => {
    expect(recordingMapAppearanceId("default", "default")).toBe("default");
    expect(recordingMapAppearanceId("waxed_reflection", "default")).toBe("waxed_reflection");
    expect(recordingMapAppearanceId("default", "rain")).toBe("rain");
    expect(recordingMapAppearanceId("waxed_reflection", "rain")).toBe("rain");
    expect(recordingMapAppearanceId("unknown", "blizzard")).toBe("default");
  });
});
