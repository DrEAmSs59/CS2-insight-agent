/** @vitest-environment node */
import { describe, expect, it } from "vitest";
import acceptance from "../../../../../data/lite_cut_visual_acceptance.json";
import effectContract from "../../../../../data/lite_cut_effect_contract.json";
import tauriConfig from "../../../../src-tauri/tauri.conf.json";
import { FILTER_PRESETS, FONT_OPTIONS, TRANSITION_OPTIONS } from "./editorPresets.js";

describe("LiteCut visual acceptance matrix", () => {
  it("covers every shipped filter, canvas ratio, transition, and built-in font", () => {
    expect(new Set(acceptance.filter_presets)).toEqual(new Set(FILTER_PRESETS.map((item) => item.id)));
    expect(new Set(acceptance.canvas_presets.map((item) => item.id))).toEqual(new Set(effectContract.canvas_presets.map((item) => item.id)));
    expect(new Set(acceptance.transitions)).toEqual(new Set(TRANSITION_OPTIONS.filter((item) => item.id !== "cut").map((item) => item.id)));
    const coveredFamilies = new Set(acceptance.fonts.filter((item) => item.kind !== "imported").map((item) => item.family));
    for (const family of FONT_OPTIONS) expect(coveredFamilies.has(family)).toBe(true);
    expect(acceptance.fonts.some((item) => item.kind === "imported")).toBe(true);
  });

  it("packages the staged backend font resources for Tauri", () => {
    expect(tauriConfig.bundle.resources).toHaveProperty("bundle-resources/");
  });
});
