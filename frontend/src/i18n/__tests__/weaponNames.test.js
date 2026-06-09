import { describe, test, expect } from "vitest";
import { weaponDisplayName, WEAPON_NAME_ZH_TO_EN, weaponUsedTokens } from "../weaponNames.js";

describe("weaponDisplayName", () => {
  test("zh locale returns input unchanged", () => {
    expect(weaponDisplayName("消音 M4A1-S", "zh")).toBe("消音 M4A1-S");
    expect(weaponDisplayName("沙鹰", "zh")).toBe("沙鹰");
    expect(weaponDisplayName("刀", "zh")).toBe("刀");
  });

  test("en maps 消音 M4A1-S → M4A1-S", () => {
    expect(weaponDisplayName("消音 M4A1-S", "en")).toBe("M4A1-S");
  });

  test("en maps 沙鹰 → Desert Eagle", () => {
    expect(weaponDisplayName("沙鹰", "en")).toBe("Desert Eagle");
  });

  test("en maps 大狙 (AWP) → AWP", () => {
    expect(weaponDisplayName("大狙 (AWP)", "en")).toBe("AWP");
  });

  test("en maps 电击枪 (Zeus) → Zeus x27", () => {
    expect(weaponDisplayName("电击枪 (Zeus)", "en")).toBe("Zeus x27");
  });

  test("en falls back to original for already-English names", () => {
    expect(weaponDisplayName("AK-47", "en")).toBe("AK-47");
    expect(weaponDisplayName("AUG", "en")).toBe("AUG");
    expect(weaponDisplayName("P90", "en")).toBe("P90");
    expect(weaponDisplayName("M4A4", "en")).toBe("M4A4");
    expect(weaponDisplayName("MP7", "en")).toBe("MP7");
    expect(weaponDisplayName("Nova", "en")).toBe("Nova");
    expect(weaponDisplayName("TEC-9", "en")).toBe("TEC-9");
  });

  test("en falls back unchanged for unknown name", () => {
    expect(weaponDisplayName("unknown_weapon_xyz", "en")).toBe("unknown_weapon_xyz");
  });

  test("empty string is returned as-is for both locales", () => {
    expect(weaponDisplayName("", "zh")).toBe("");
    expect(weaponDisplayName("", "en")).toBe("");
  });

  test("null/undefined inputs are returned as-is", () => {
    expect(weaponDisplayName(null, "en")).toBeNull();
    expect(weaponDisplayName(undefined, "en")).toBeUndefined();
  });

  test("all zh map values in WEAPON_NAME_ZH_TO_EN are non-empty strings", () => {
    for (const [zh, en] of Object.entries(WEAPON_NAME_ZH_TO_EN)) {
      expect(typeof en, `entry for "${zh}"`).toBe("string");
      expect(en.length, `entry for "${zh}"`).toBeGreaterThan(0);
    }
  });

  test("en maps all knife variants to non-empty English names", () => {
    const knifeVariants = [
      "刀", "刺刀", "爪子刀", "M9 刺刀", "蝴蝶刀", "折叠刀",
      "穿肠刀", "猎杀者匕首", "弯刀", "博伊猎刀", "暗影双匕",
      "系绳匕首", "求生匕首", "熊刀", "流浪者匕首", "户外匕首",
      "短剑", "锯齿爪刀", "骷髅匕首", "经典刀", "廓尔喀刀",
    ];
    for (const zh of knifeVariants) {
      const en = weaponDisplayName(zh, "en");
      expect(en, `knife "${zh}"`).toBeTruthy();
      expect(en, `knife "${zh}"`).not.toBe(zh);
    }
  });
});

describe("weaponUsedTokens", () => {
  test("en splits and localizes multi-weapon strings", () => {
    expect(weaponUsedTokens("消音 USP-S / 沙鹰", "en")).toEqual(["USP-S", "Desert Eagle"]);
  });

  test("zh returns tokens unchanged", () => {
    expect(weaponUsedTokens("消音 M4A1-S / AK-47", "zh")).toEqual(["消音 M4A1-S", "AK-47"]);
  });

  test("empty input returns []", () => {
    expect(weaponUsedTokens("", "en")).toEqual([]);
    expect(weaponUsedTokens(null, "en")).toEqual([]);
  });
});
