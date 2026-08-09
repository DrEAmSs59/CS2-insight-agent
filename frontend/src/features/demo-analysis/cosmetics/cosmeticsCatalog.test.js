import { describe, expect, test } from "vitest";
import {
  craftNameParts,
  filterCandidates,
  formatCraftPipeName,
  imageUrlForWear,
  listCandidateTypeGroups,
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

  test("builds knife and glove model groups and filters candidates by group", () => {
    const knives = listSkinCandidates({ type: "melee", def_index: 507, model: "knife_karambit" });
    const knifeGroups = listCandidateTypeGroups(knives, "zh");
    expect(knifeGroups.some((group) => group.label === "爪子刀")).toBe(true);
    const butterfly = knifeGroups.find((group) => group.label === "蝴蝶刀");
    expect(butterfly).toBeTruthy();
    expect(filterCandidates(knives, "", "zh", butterfly.key).every((row) => row.def_index === 515)).toBe(true);

    const gloves = listSkinCandidates({ type: "glove", def_index: 5030, model: "sporty_gloves" });
    const gloveLabels = listCandidateTypeGroups(gloves, "zh").map((group) => group.label);
    expect(gloveLabels).toContain("运动手套");
    expect(gloveLabels).toContain("专业手套");
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

  test("exposes Doppler phase via alt_name and includes it in search", () => {
    const rows = listSkinCandidates({ type: "melee", def_index: 500, model: "bayonet" });
    const dopplers = rows.filter((row) => /多普勒|Doppler/i.test(`${row.name_zh} ${row.name_en}`));
    expect(dopplers.length).toBeGreaterThan(5);
    expect(dopplers.some((row) => row.alt_name === "Ruby")).toBe(true);
    expect(dopplers.some((row) => row.alt_name === "Phase 2")).toBe(true);
    expect(filterCandidates(dopplers, "ruby", "en").some((row) => row.alt_name === "Ruby")).toBe(true);
  });

  test("imageUrlForWear maps wear tiers like cs2-lib getImage", () => {
    const base = "https://cdn.cstrike.app/images/weapon_knife_butterfly_cu_butterfly_lore_8805af1d.webp";
    expect(imageUrlForWear(base, 0.05, { paint_index: 415 })).toContain("_light.webp");
    expect(imageUrlForWear(base, 0.4, { paint_index: 415 })).toContain("_medium.webp");
    expect(imageUrlForWear(base, 0.9, { paint_index: 415 })).toContain("_heavy.webp");
    expect(imageUrlForWear(base)).toBe(base);
  });

  test("imageUrlForWear keeps vanilla default art without wear suffixes", () => {
    const base = "https://cdn.cstrike.app/images/weapon_knife_a6715cc6.webp";
    expect(imageUrlForWear(base, 0, { is_placeholder: true, paint_index: 0 })).toBe(base);
    expect(imageUrlForWear(base, 0.9, { paint_index: 0 })).toBe(base);
    expect(imageUrlForWear(base.replace(".webp", "_light.webp"), 0.1, { is_placeholder: true })).toBe(base);
  });

  test("craftNameParts prefixes melee with star and splits finish", () => {
    const parts = craftNameParts(
      { type: "melee", name_en: "Butterfly Knife | Lore", name_zh: "蝴蝶刀 | 传说" },
      "en",
    );
    expect(parts.model).toBe("★ Butterfly Knife");
    expect(parts.finish).toBe("Lore");
    expect(craftNameParts({ type: "weapon", name_en: "AK-47 | Redline" }, "en").model).toBe("AK-47");
  });

  test("formatCraftPipeName joins model, skin, and phase alt", () => {
    expect(formatCraftPipeName({
      type: "weapon",
      name_zh: "AK-47 | 红线",
      name_en: "AK-47 | Redline",
      paint_seed: 80,
    }, "zh")).toBe("AK-47 | 红线");
    expect(formatCraftPipeName({
      type: "melee",
      name_zh: "M9 刺刀 | 伽玛多普勒",
      name_en: "M9 Bayonet | Gamma Doppler",
      alt_name: "Emerald",
      paint_seed: 568,
    }, "zh")).toBe("★ M9 刺刀 | 伽玛多普勒 | Emerald");
  });
});
