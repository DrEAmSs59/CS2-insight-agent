import { describe, expect, test } from "vitest";
import { resolveHudWeaponStem } from "./resolveHudWeaponStem";

describe("resolveHudWeaponStem", () => {
  test.each([
    ["Stiletto Knife", "knife_stiletto"],
    ["Butterfly Knife", "knife_butterfly"],
    ["Huntsman Knife", "knife_tactical"],
    ["Shadow Daggers", "knife_push"],
    ["M9 Bayonet", "knife_m9_bayonet"],
    ["Nomad Knife", "knife_outdoor"],
    ["Kukri Knife", "knife"],
  ])("maps demoparser display name %s to %s", (displayName, expected) => {
    expect(resolveHudWeaponStem(displayName, displayName, { fallback: "" })).toBe(expected);
  });

  test("keeps normal weapon matching intact", () => {
    expect(resolveHudWeaponStem("AK-47", "AK-47", { fallback: "" })).toBe("ak47");
    expect(resolveHudWeaponStem("5e_match_weapon_knife_m9_bayonet", "", { fallback: "" })).toBe("knife_m9_bayonet");
  });
});
