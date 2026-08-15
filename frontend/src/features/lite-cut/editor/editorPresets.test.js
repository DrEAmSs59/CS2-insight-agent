import { describe, expect, it } from "vitest";
import { FILTER_PRESETS, filterStyleFromColor } from "./editorPresets.js";

describe("filterStyleFromColor", () => {
  it.each(FILTER_PRESETS)("uses the shared $id preset definition in the actual preview", (preset) => {
    const result = filterStyleFromColor({ preset: preset.id }).filter;

    if (preset.filter === "none") {
      expect(result).toBe("brightness(1) contrast(1) saturate(1)");
    } else {
      expect(result.startsWith(`${preset.filter} `)).toBe(true);
    }
  });

  it("applies user sliders after the selected preset just like the exporter", () => {
    expect(filterStyleFromColor({ preset: "warm", brightness: 20, contrast: 10, saturation: -15 }).filter).toBe(
      "sepia(0.35) saturate(1.2) brightness(1.2) contrast(1.1) saturate(0.85)",
    );
  });

  it("covers every preset supported by the exporter", () => {
    expect(FILTER_PRESETS.map((preset) => preset.id)).toEqual([
      "none", "esports", "cold", "warm", "vintage", "highcon", "fade", "night",
    ]);
  });

  it("gives every filter card a concrete CSS background independent of Tailwind class discovery", () => {
    for (const preset of FILTER_PRESETS) {
      expect(preset.thumbnailBackground).toMatch(/^linear-gradient\(/);
    }
    expect(new Set(FILTER_PRESETS.map((preset) => preset.thumbnailBackground)).size).toBe(FILTER_PRESETS.length);
  });
});
