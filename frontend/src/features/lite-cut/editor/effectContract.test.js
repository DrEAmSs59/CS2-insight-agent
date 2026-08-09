import { describe, expect, it } from "vitest";
import { FILTER_PRESETS, filterStyleFromColor } from "./editorPresets.js";
import { effectContract, normalizeVideoLayerTransform } from "./effectContract.js";
import { previewMediaIdentity } from "./previewFrameUtils.js";

describe("LiteCut shared preview/export effect contract", () => {
  it("uses the contract transform limits in preview", () => {
    expect(normalizeVideoLayerTransform({ x: -5, y: 5, width: 9, height: 0, scale: 10, rotation: 999, opacity: -2 })).toEqual({
      x: 0, y: 1, width: 3, height: 0.01, scale: 3, rotation: 180, opacity: 0,
    });
  });

  it("covers every preset, canvas and supported media extension", () => {
    let combinations = 0;
    for (const canvas of effectContract.canvas_presets) {
      expect(canvas.width).toBeGreaterThan(0);
      expect(canvas.height).toBeGreaterThan(0);
      for (const preset of effectContract.filter_presets) {
        const preview = filterStyleFromColor({ preset: preset.id, brightness: 5, contrast: -5, saturation: 10 }).filter;
        expect(preview).toContain("brightness(1.05)");
        expect(FILTER_PRESETS.find((item) => item.id === preset.id)?.ffmpeg).toBe(preset.ffmpeg);
        for (const extension of effectContract.media_extensions) {
          combinations += 1;
          expect(previewMediaIdentity("clip-a", `/media/a.${extension}`)).not.toBe(
            previewMediaIdentity("clip-b", `/media/a.${extension}`),
          );
        }
      }
    }
    expect(combinations).toBe(
      effectContract.canvas_presets.length * effectContract.filter_presets.length * effectContract.media_extensions.length,
    );
  });
});
