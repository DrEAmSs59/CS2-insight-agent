import { describe, test, expect } from "vitest";
import { describeTag, labelTag } from "../../utils/tagDescriptions.js";

describe("tag i18n", () => {
  test("describeTag 中文（默认）", () => {
    expect(describeTag("爆头")).toBe("命中头部");
  });
  test("describeTag 英文", () => {
    expect(describeTag("爆头", "en")).toBe("Hit the head");
  });
  test("labelTag 中文返回原 tag", () => {
    expect(labelTag("🔫 手枪哥", "zh")).toBe("🔫 手枪哥");
  });
  test("labelTag 英文返回译名（保留 emoji）", () => {
    expect(labelTag("🔫 手枪哥", "en")).toBe("🔫 Pistol Headshot");
  });
  test("labelTag 英文缺译名时回退原 tag", () => {
    expect(labelTag("🌀 未知标签", "en")).toBe("🌀 未知标签");
  });
  test("前缀匹配仍生效（英文 desc）", () => {
    expect(describeTag("🔥 1v3", "en")).toContain("clutch");
  });
});
