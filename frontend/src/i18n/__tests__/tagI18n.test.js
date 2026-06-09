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

  test("labelTag 动态 tag：保留人数、翻译中文片段", () => {
    expect(labelTag("🔥 1v2 史诗残局", "en")).toBe("🔥 1v2 Epic Clutch");
    expect(labelTag("🔥 2v3 兄弟齐心", "en")).toBe("🔥 2v3 Team Clutch");
    expect(labelTag("💀 1v3 封神未遂", "en")).toBe("💀 1v3 Clutch Fell Short");
  });
  test("labelTag 合集 context_tag 翻译", () => {
    expect(labelTag("🎬 全部击杀", "en")).toBe("🎬 All Kills");
    expect(labelTag("💀 全部死亡", "en")).toBe("💀 All Deaths");
  });
  test("labelTag 同框 / 持续 保留名字与时长", () => {
    expect(labelTag("👫 同框: Foo", "en")).toBe("👫 Near enemy: Foo");
    expect(labelTag("⏳ 持续 3.5s", "en")).toBe("⏳ Duration 3.5s");
  });
  test("labelTag 动态 tag 在中文 locale 原样返回", () => {
    expect(labelTag("🔥 1v2 史诗残局", "zh")).toBe("🔥 1v2 史诗残局");
  });
});
