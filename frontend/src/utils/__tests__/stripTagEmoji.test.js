import { describe, test, expect } from "vitest";
import { stripTagEmoji } from "../montageUtils.js";
import { labelTag } from "../tagDescriptions.js";

describe("stripTagEmoji", () => {
  test("ZWJ 复合 emoji（跑打）", () => {
    expect(stripTagEmoji("🏃‍♂️ 跑打")).toBe("跑打");
    expect(stripTagEmoji("🏃‍♂️跑打")).toBe("跑打");
  });

  test("ZWJ 复合 emoji（首席研发）", () => {
    expect(stripTagEmoji("👨‍🔬 首席研发工程师")).toBe("首席研发工程师");
  });

  test("普通 emoji 前缀", () => {
    expect(stripTagEmoji("🔫 ECO特种兵")).toBe("ECO特种兵");
    expect(stripTagEmoji("🔫ECO特种兵")).toBe("ECO特种兵");
    expect(stripTagEmoji("⚔️ 首杀")).toBe("首杀");
  });

  test("与 labelTag 组合（英文译名也去 emoji）", () => {
    expect(stripTagEmoji(labelTag("🏃‍♂️ 跑打", "en"))).toBe("Moving Kill");
    expect(stripTagEmoji(labelTag("🔫 手枪哥", "en"))).toBe("Pistol Headshot");
  });
});
