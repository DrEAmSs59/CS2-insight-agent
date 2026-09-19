import { describe, expect, it } from "vitest";

import {
  DEFAULT_INPUT_HUD_POSITION,
  INPUT_HUD_PLACEMENTS,
  inputHudPlacementFromState,
  inputHudStateFromPlacement,
  normalizeInputHudPosition,
} from "./inputHudPlacement.js";

describe("input HUD placement", () => {
  it("keeps the three OBS overlay anchors and a hidden choice", () => {
    expect(INPUT_HUD_PLACEMENTS).toEqual([
      "hidden",
      "bottom_center",
      "minimap_below",
      "weapon_right",
    ]);
  });

  it("treats a disabled HUD as hidden without losing the default anchor", () => {
    expect(inputHudPlacementFromState(false, "weapon_right")).toBe("hidden");
    expect(inputHudPlacementFromState(true, "minimap_below")).toBe("minimap_below");
    expect(inputHudPlacementFromState(true, "somewhere")).toBe(DEFAULT_INPUT_HUD_POSITION);
  });

  it("maps a dropdown choice back to enabled plus an OBS overlay anchor", () => {
    expect(inputHudStateFromPlacement("hidden")).toEqual({
      enabled: false,
      position: DEFAULT_INPUT_HUD_POSITION,
    });
    expect(inputHudStateFromPlacement("weapon_right")).toEqual({
      enabled: true,
      position: "weapon_right",
    });
    expect(normalizeInputHudPosition("minimap_below")).toBe("minimap_below");
  });
});
