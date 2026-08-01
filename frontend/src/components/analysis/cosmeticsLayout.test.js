import { describe, expect, test } from "vitest";
import {
  hasSkinFinish,
  isCustomizable,
  itemsForTeam,
  mergeLoadoutWithEvidence,
  slotKey,
  sortCosmeticsForRow,
  weaponClassRank,
} from "./cosmeticsLayout.js";
import { listDefaultLoadout } from "./cosmeticsCatalog.js";

describe("cosmeticsLayout", () => {
  test("slotKey prefers item_id then stable fallback", () => {
    expect(slotKey({ item_id: 99, def_index: 7 })).toBe("id:99");
    expect(slotKey({ def_index: 7, paint_index: 282, paint_seed: 1, paint_wear: 0.2 }))
      .toBe("def:7:282:1:0.2");
    expect(slotKey({ is_placeholder: true, def_index: 7 })).toBe("placeholder:7");
  });

  test("isCustomizable allows melee/glove/weapon only", () => {
    expect(isCustomizable({ type: "weapon" })).toBe(true);
    expect(isCustomizable({ type: "melee" })).toBe(true);
    expect(isCustomizable({ type: "glove" })).toBe(true);
    expect(isCustomizable({ type: "agent" })).toBe(false);
    expect(isCustomizable({ type: "musickit" })).toBe(false);
  });

  test("weaponClassRank orders knife glove rifle sniper pistol smg", () => {
    expect(weaponClassRank({ type: "melee" })).toBe(0);
    expect(weaponClassRank({ type: "glove" })).toBe(1);
    expect(weaponClassRank({ type: "weapon", model: "ak47" })).toBe(2);
    expect(weaponClassRank({ type: "weapon", model: "awp" })).toBe(3);
    expect(weaponClassRank({ type: "weapon", model: "deagle" })).toBe(4);
    expect(weaponClassRank({ type: "weapon", model: "mac10" })).toBe(5);
    expect(weaponClassRank({ type: "weapon", model: "nova" })).toBe(6);
    expect(weaponClassRank({ type: "agent" })).toBe(7);
  });

  test("hasSkinFinish treats placeholders and paint_index 0 as default", () => {
    expect(hasSkinFinish({ is_placeholder: true, paint_index: 0, type: "weapon" })).toBe(false);
    expect(hasSkinFinish({ paint_index: 0, type: "weapon", name_zh: "AK-47" })).toBe(false);
    expect(hasSkinFinish({ paint_index: 282, type: "weapon", name_zh: "AK-47 | 红线" })).toBe(true);
    expect(hasSkinFinish({ paint_index: 0, type: "melee", name_zh: "爪子刀 | 渐变" })).toBe(true);
  });

  test("itemsForTeam filters observed_teams and sortCosmeticsForRow groups skinned first", () => {
    const knife = { type: "melee", model: "knife_karambit", observed_teams: ["ct", "t"], item_id: 1, name_zh: "刀", paint_index: 415 };
    const ak = { type: "weapon", model: "ak47", observed_teams: ["t"], item_id: 2, name_zh: "AK", paint_index: 282 };
    const awp = { type: "weapon", model: "awp", observed_teams: ["ct"], item_id: 3, name_zh: "AWP", paint_index: 344 };
    const defaultAk = { type: "weapon", model: "ak47", item_id: 4, name_zh: "AK-47", paint_index: 0, is_placeholder: true };
    expect(itemsForTeam([knife, ak, awp], "ct").map((i) => i.item_id)).toEqual([1, 3]);
    expect(itemsForTeam([knife, ak, awp], "t").map((i) => i.item_id)).toEqual([1, 2]);
    expect(sortCosmeticsForRow([defaultAk, awp, ak, knife], "zh").map((i) => i.item_id)).toEqual([1, 2, 3, 4]);
  });

  test("mergeLoadoutWithEvidence overlays demo skins onto defaults and keeps skinned group first", () => {
    const defaults = listDefaultLoadout("t");
    expect(defaults.some((row) => row.model === "ak47" && row.is_placeholder)).toBe(true);
    expect(defaults.some((row) => row.model === "knife_t")).toBe(true);
    expect(defaults.every((row) => row.model !== "c4")).toBe(true);

    const evidence = [
      {
        type: "weapon",
        model: "ak47",
        def_index: 7,
        paint_index: 282,
        item_id: 99,
        name_zh: "AK | 红线",
        observed_teams: ["t"],
      },
      {
        type: "melee",
        model: "knife_karambit",
        def_index: 507,
        paint_index: 415,
        item_id: 100,
        name_zh: "爪子刀 | 渐变",
        observed_teams: ["t"],
      },
    ];
    const merged = mergeLoadoutWithEvidence(defaults, evidence, "zh");
    expect(merged.find((row) => Number(row.def_index) === 7)?.item_id).toBe(99);
    expect(merged.some((row) => row.is_placeholder && row.model === "ak47")).toBe(false);
    expect(merged.some((row) => row.model === "knife_t" && row.is_placeholder)).toBe(false);
    expect(merged.some((row) => row.item_id === 100)).toBe(true);
    expect(merged[0].item_id).toBe(100);
    expect(merged[1].item_id).toBe(99);
    expect(hasSkinFinish(merged[0])).toBe(true);
    expect(hasSkinFinish(merged[1])).toBe(true);
    expect(merged.findIndex((row) => row.is_placeholder)).toBeGreaterThan(1);
  });
});
