import { describe, expect, it } from "vitest";
import {
  TEXT_FONT_SIZE_MAX,
  clampTextFontSize,
} from "./LiteCutPropertyPanel.jsx";

describe("LiteCut text inspector", () => {
  it("allows font sizes beyond 120 up to the visible slider maximum", () => {
    expect(clampTextFontSize(120)).toBe(120);
    expect(clampTextFontSize(180)).toBe(180);
    expect(clampTextFontSize(999)).toBe(TEXT_FONT_SIZE_MAX);
  });
});
