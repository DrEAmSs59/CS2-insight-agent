import { describe, expect, test } from "vitest";
import {
  filterCandidates,
  listSkinCandidates,
  sortCandidatesByRarityDesc,
} from "./cosmeticsCatalog.js";

describe("cosmeticsCatalog", () => {
  test("lists only AK finishes when source is AK-47", () => {
    const rows = listSkinCandidates({ type: "weapon", def_index: 7, model: "ak47" });
    expect(rows.length).toBeGreaterThan(10);
    expect(rows.every((row) => row.def_index === 7 && row.type === "weapon")).toBe(true);
    expect(rows.every((row) => Number(row.paint_index) > 0 || row.paint_index === 0)).toBe(true);
  });

  test("lists melee finishes across knife models when source is a knife", () => {
    const rows = listSkinCandidates({ type: "melee", def_index: 507, model: "knife_karambit" });
    expect(rows.length).toBeGreaterThan(50);
    expect(rows.every((row) => row.type === "melee")).toBe(true);
    const models = new Set(rows.map((row) => row.model));
    expect(models.size).toBeGreaterThan(1);
  });

  test("sorts by rarity descending then filters by localized name", () => {
    const mixed = [
      { name_en: "Blue", name_zh: "蓝", rarity: "#5e98d9" },
      { name_en: "Red", name_zh: "红", rarity: "#eb4b4b" },
      { name_en: "Purple", name_zh: "紫", rarity: "#8847ff" },
    ];
    expect(sortCandidatesByRarityDesc(mixed).map((r) => r.name_en)).toEqual(["Red", "Purple", "Blue"]);
    expect(filterCandidates(mixed, "红", "zh")).toHaveLength(1);
    expect(filterCandidates(mixed, "blue", "en")).toHaveLength(1);
  });
});
