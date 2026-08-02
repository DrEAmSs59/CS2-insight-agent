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
    expect(isCustomizable({ type: "weapon", item_id: 1, def_index: 7 })).toBe(true);
    expect(isCustomizable({ type: "melee", item_id: 2, def_index: 508 })).toBe(true);
    expect(isCustomizable({ type: "glove", item_id: 3, def_index: 5027 })).toBe(true);
    expect(isCustomizable({ type: "agent", item_id: 4 })).toBe(false);
    expect(isCustomizable({ type: "musickit", item_id: 5 })).toBe(false);
    expect(isCustomizable({ type: "weapon", is_placeholder: true, def_index: 7 })).toBe(false);
    expect(isCustomizable({ type: "melee", is_placeholder: true, def_index: 59 })).toBe(true);
    expect(isCustomizable({ type: "glove", is_placeholder: true, def_index: 5028 })).toBe(true);
    expect(isCustomizable({ type: "weapon", def_index: 16, paint_index: 0 })).toBe(true);
    expect(isCustomizable({ type: "weapon", item_id: 0, def_index: 7 })).toBe(true);
    expect(isCustomizable({ type: "weapon" })).toBe(false);
  });

  test("weaponClassRank orders knife glove sniper rifle smg shotgun mg pistol", () => {
    expect(weaponClassRank({ type: "melee" })).toBe(0);
    expect(weaponClassRank({ type: "glove" })).toBe(1);
    expect(weaponClassRank({ type: "weapon", model: "awp" })).toBe(2);
    expect(weaponClassRank({ type: "weapon", model: "ak47" })).toBe(3);
    expect(weaponClassRank({ type: "weapon", model: "mac10" })).toBe(4);
    expect(weaponClassRank({ type: "weapon", model: "nova" })).toBe(5);
    expect(weaponClassRank({ type: "weapon", model: "negev" })).toBe(6);
    expect(weaponClassRank({ type: "weapon", model: "deagle" })).toBe(7);
    expect(weaponClassRank({ type: "agent" })).toBe(8);
  });

  test("hasSkinFinish treats placeholders and paint_index 0 as default", () => {
    expect(hasSkinFinish({ is_placeholder: true, paint_index: 0, type: "weapon" })).toBe(false);
    expect(hasSkinFinish({ paint_index: 0, type: "weapon", name_zh: "AK-47" })).toBe(false);
    expect(hasSkinFinish({ paint_index: 282, type: "weapon", name_zh: "AK-47 | 红线" })).toBe(true);
    expect(hasSkinFinish({ paint_index: 0, type: "melee", name_zh: "爪子刀 | 渐变" })).toBe(true);
  });

  test("itemsForTeam filters observed_teams and sortCosmeticsForRow follows class order", () => {
    const knife = { type: "melee", model: "knife_karambit", observed_teams: ["ct", "t"], item_id: 1, name_zh: "系绳匕首", paint_index: 0 };
    const ak = { type: "weapon", model: "ak47", observed_teams: ["t"], item_id: 2, name_zh: "AK", paint_index: 282 };
    const awp = { type: "weapon", model: "awp", observed_teams: ["ct"], item_id: 3, name_zh: "AWP", paint_index: 344 };
    const deagle = { type: "weapon", model: "deagle", observed_teams: ["ct"], item_id: 4, name_zh: "沙鹰", paint_index: 28 };
    expect(itemsForTeam([knife, ak, awp], "ct").map((i) => i.item_id)).toEqual([1, 3]);
    expect(itemsForTeam([knife, ak, awp], "t").map((i) => i.item_id)).toEqual([1, 2]);
    // Knife stays first even without a painted finish.
    expect(sortCosmeticsForRow([deagle, awp, ak, knife], "zh").map((i) => i.item_id)).toEqual([1, 3, 2, 4]);
  });

  test("mergeLoadoutWithEvidence overlays demo skins onto defaults with class order", () => {
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
    expect(merged.find((row) => row.item_id === 99)).toBeTruthy();
    expect(weaponClassRank(merged.find((row) => row.item_id === 100))).toBeLessThan(
      weaponClassRank(merged.find((row) => row.item_id === 99)),
    );
  });

  test("mergeLoadoutWithEvidence skips default weapon placeholders when no evidence", () => {
    const defaults = listDefaultLoadout("t");
    const merged = mergeLoadoutWithEvidence(defaults, [], "zh");
    expect(merged.some((item) => item.type === "weapon")).toBe(false);
    expect(merged.some((item) => item.type === "melee" && item.is_placeholder)).toBe(true);
    expect(merged.some((item) => item.type === "glove" && item.is_placeholder)).toBe(true);
  });

  test("mergeLoadoutWithEvidence keeps evidenced vanilla weapons and replaces knife/gloves", () => {
    const defaults = listDefaultLoadout("ct");
    const evidence = [
      {
        type: "weapon",
        def_index: 61,
        paint_index: 0,
        model: "usp_silencer",
        name_zh: "USP 消音器",
        name_en: "USP-S",
        item_id: 111,
        observed_teams: ["ct"],
      },
      {
        type: "melee",
        def_index: 42,
        paint_index: 0,
        model: "knife_ct",
        name_zh: "默认刀",
        name_en: "Knife",
        item_id: 222,
        observed_teams: ["ct"],
      },
    ];
    const merged = mergeLoadoutWithEvidence(defaults, evidence, "zh");
    const weapons = merged.filter((item) => item.type === "weapon");
    expect(weapons).toHaveLength(1);
    expect(weapons[0].item_id).toBe(111);
    expect(merged.find((item) => item.type === "melee")?.item_id).toBe(222);
  });
});
