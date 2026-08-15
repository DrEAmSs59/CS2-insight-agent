import { describe, expect, it } from "vitest";
import { FILTER_PRESETS, filterStyleFromColor } from "./editorPresets.js";
import { effectContract } from "./effectContract.js";
import { normalizeSceneTransform } from "../state/sceneTransform.js";
import { previewMediaIdentity } from "./previewFrameUtils.js";
import {
  AUDIO_BGM_GAIN,
  AUDIO_CLIP_GAIN,
  AUDIO_FADE_DURATION,
  AUDIO_MASTER_GAIN,
  AUDIO_TRACK_GAIN,
} from "../domain/audioContract.js";
import { LITE_CUT_TIMELINE_LIMITS } from "../state/projectContract.js";
import {
  VISUAL_COLOR_DEFAULT,
  VISUAL_FREEZE_DEFAULT_SEC,
  VISUAL_SPEED_DEFAULT,
} from "../domain/visualMaterial.js";
import { TRANSITION_DURATION_DEFAULT } from "../state/transitionModel.js";

describe("LiteCut shared preview/export effect contract", () => {
  it("uses the canonical scene bounds in preview", () => {
    expect(normalizeSceneTransform({ x: -5, y: 5, width: 9, height: 0, scale: 10, rotation: 999, opacity: -2 })).toEqual({
      x: -5, y: 5, width: 9, height: 0.0001, scale: 10, rotation: 999, opacity: 0,
    });
    expect(effectContract.scene_transform.anchor).toBe("center");
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

  it("exposes one nine-effect transition contract to every material", () => {
    expect(effectContract.transition_model.storage).toBe("independent_events");
    expect(effectContract.transition_model.time_alignment.paired).toBe("centered_on_cut");
    expect(effectContract.transition_model.types.map((item) => item.id)).toEqual([
      "cut", "fade", "flash", "dip", "zoom", "wipe_l", "wipe_r", "slide_up", "slide_down",
    ]);
  });

  it("exports every shared editor default and timing boundary from contracts", () => {
    expect({
      clip: AUDIO_CLIP_GAIN.default,
      track: AUDIO_TRACK_GAIN.default,
      master: AUDIO_MASTER_GAIN.default,
      bgm: AUDIO_BGM_GAIN.default,
    }).toEqual(effectContract.audio_mix.gain_defaults);
    expect(AUDIO_FADE_DURATION.max).toBe(effectContract.audio_mix.fade_duration_sec.max);
    expect(TRANSITION_DURATION_DEFAULT).toBe(effectContract.transition_model.limits.duration_default);
    expect(VISUAL_SPEED_DEFAULT).toBe(effectContract.visual_material.defaults.speed);
    expect(VISUAL_FREEZE_DEFAULT_SEC).toBe(effectContract.visual_material.defaults.freeze_frame_sec);
    expect(VISUAL_COLOR_DEFAULT).toBe(effectContract.visual_material.defaults.color_adjustment);
    expect(LITE_CUT_TIMELINE_LIMITS.time.max).toBe(86400);
    expect(LITE_CUT_TIMELINE_LIMITS.duration.default).toBe(3);
  });

  it("exposes one strict text layout, style and font contract", () => {
    expect(effectContract.text_layout.coordinate_space).toBe("authored_box_output_pixels");
    expect(effectContract.text_layout.horizontal_alignment).toBe("block_and_each_explicit_line");
    expect(effectContract.text_layout.line_height.meaning).toBe("baseline_advance");
    expect(effectContract.text_layout.letter_spacing.supported_values).toEqual([0]);
    expect(effectContract.text_layout.style_capabilities).toEqual(["solid_fill", "uniform_outline"]);
    expect(effectContract.text_style_presets.map((item) => item.id)).toEqual([
      "plain", "creator", "retro", "bubble", "large-title", "ace", "clutch", "namecard",
    ]);
    expect(effectContract.text_fonts.map((item) => item.family)).toEqual([
      "微软雅黑", "思源黑体 Medium", "Impact", "Noto Sans SC",
    ]);
  });
});
