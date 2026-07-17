/** @vitest-environment node */
import { describe, expect, it } from "vitest";
import { packagingBundleFromBody } from "./presetUtils.js";

describe("packagingBundleFromBody", () => {
  it("captures visual style, text style, and BGM for a reusable package", () => {
    const bundle = packagingBundleFromBody({
      tracks: [{ id: "v1", type: "video", clips: [{ source_type: "recorded_clip", source_id: 1, trim_in: 0, trim_out: 5, color: { saturation: 20 }, transition_out: { type: "flash", duration_sec: 0.3 } }] }],
      overlays: [{ type: "text", text: { content: "ACE {{player_name}}", font_family: "Impact", font_file: "C:/fonts/impact.ttf", font_size: 70 } }],
      audio: { bgm: { path: "C:/audio/theme.mp3", asset_id: 8, volume: 0.5 } },
    });
    expect(bundle).toMatchObject({
      color_grade: { saturation: 20 },
      transition_rhythm: { default_type: "flash", default_duration_sec: 0.3 },
      bgm: { asset_id: 8, volume: 0.5 },
    });
    expect(bundle.text_styles[0]).toMatchObject({ font_family: "Impact", font_size: 70, content_template: "ACE {{player_name}}" });
  });
});
