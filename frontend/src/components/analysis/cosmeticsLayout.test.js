import { describe, expect, test } from "vitest";
import {
  isCustomizable,
  itemsForTeam,
  slotKey,
  sortCosmeticsForRow,
  weaponClassRank,
} from "./cosmeticsLayout.js";

describe("cosmeticsLayout", () => {
  test("slotKey prefers item_id then stable fallback", () => {
    expect(slotKey({ item_id: 99, def_index: 7 })).toBe("id:99");
    expect(slotKey({ def_index: 7, paint_index: 282, paint_seed: 1, paint_wear: 0.2 }))
      .toBe("def:7:282:1:0.2");
  });

  test("isCustomizable allows melee/glove/weapon only", () => {
    expect(isCustomizable({ type: "weapon" })).toBe(true);
    expect(isCustomizable({ type: "melee" })).toBe(true);
    expect(isCustomizable({ type: "glove" })).toBe(true);
    expect(isCustomizable({ type: "agent" })).toBe(false);
    expect(isCustomizable({ type: "musickit" })).toBe(false);
  });

  test("weaponClassRank orders sniper before rifle and shotgun after smg", () => {
    expect(weaponClassRank({ type: "melee" })).toBe(0);
    expect(weaponClassRank({ type: "glove" })).toBe(1);
    expect(weaponClassRank({ type: "weapon", model: "awp" })).toBe(2);
    expect(weaponClassRank({ type: "weapon", model: "ak47" })).toBe(3);
    expect(weaponClassRank({ type: "weapon", model: "mac10" })).toBe(4);
    expect(weaponClassRank({ type: "weapon", model: "nova" })).toBe(5);
    expect(weaponClassRank({ type: "weapon", model: "deagle" })).toBe(6);
    expect(weaponClassRank({ type: "agent" })).toBe(6);
  });

  test("itemsForTeam filters observed_teams and sortCosmeticsForRow applies class order", () => {
    const knife = { type: "melee", model: "knife_karambit", observed_teams: ["ct", "t"], item_id: 1, name_zh: "刀" };
    const ak = { type: "weapon", model: "ak47", observed_teams: ["t"], item_id: 2, name_zh: "AK" };
    const awp = { type: "weapon", model: "awp", observed_teams: ["ct"], item_id: 3, name_zh: "AWP" };
    expect(itemsForTeam([knife, ak, awp], "ct").map((i) => i.item_id)).toEqual([1, 3]);
    expect(itemsForTeam([knife, ak, awp], "t").map((i) => i.item_id)).toEqual([1, 2]);
    expect(sortCosmeticsForRow([ak, awp, knife], "zh").map((i) => i.item_id)).toEqual([1, 3, 2]);
  });
});
