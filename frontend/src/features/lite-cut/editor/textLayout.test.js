import { describe, expect, it } from "vitest";

import {
  canonicalTextFontFamily,
  normalizeTextLayout,
  resolveBuiltinTextFontFace,
  TEXT_DEFAULT_FONT_FAMILY,
  TEXT_FONT_SIZE_DEFAULT,
  TEXT_FONT_WEIGHT_DEFAULT,
  TEXT_LINE_HEIGHT_DEFAULT,
  textBlockJustifyContent,
  textStylePreset,
} from "./textLayout.js";

describe("LiteCut canonical text layout", () => {
  it("uses canonical defaults when an optional text payload is null", () => {
    expect(normalizeTextLayout(null)).toMatchObject({
      fontFamily: TEXT_DEFAULT_FONT_FAMILY,
      fontSize: TEXT_FONT_SIZE_DEFAULT,
      fontWeight: TEXT_FONT_WEIGHT_DEFAULT,
      lineHeight: TEXT_LINE_HEIGHT_DEFAULT,
      align: "center",
      letterSpacing: 0,
      fillColor: null,
    });
  });

  it("normalizes every authored layout field from the shared limits", () => {
    expect(normalizeTextLayout({
      font_family: "Rajdhani Bold",
      font_size: 5000,
      font_weight: 50,
      line_height: 9,
      letter_spacing: 99,
      align: "invalid",
    })).toEqual({
      fontFamily: "微软雅黑",
      fontSize: 1000,
      fontWeight: 100,
      lineHeight: 4,
      letterSpacing: 0,
      align: "center",
      presetId: "plain",
      fillColor: null,
    });
  });

  it("resolves the exact built-in face from family and weight", () => {
    expect(resolveBuiltinTextFontFace("微软雅黑", 300).file).toBe("msyhl.ttc");
    expect(resolveBuiltinTextFontFace("微软雅黑", 500).file).toBe("msyh.ttc");
    expect(resolveBuiltinTextFontFace("微软雅黑", 700).file).toBe("msyhbd.ttc");
    expect(resolveBuiltinTextFontFace("Noto Sans SC", 500).file).toBe("NotoSansSC-Medium.ttf");
    expect(resolveBuiltinTextFontFace("Noto Sans SC", 700).file).toBe("NotoSansSC-Bold.ttf");
    expect(canonicalTextFontFamily("sans-serif")).toBe("微软雅黑");
  });

  it("uses the same alignment for the block and every explicit line", () => {
    expect(textBlockJustifyContent("left")).toBe("flex-start");
    expect(textBlockJustifyContent("center")).toBe("center");
    expect(textBlockJustifyContent("right")).toBe("flex-end");
  });

  it("falls back unknown presets to the canonical plain style", () => {
    expect(textStylePreset("missing").id).toBe("plain");
    expect(textStylePreset("clutch").fill_color).toBe("#67e8f9");
  });
});
