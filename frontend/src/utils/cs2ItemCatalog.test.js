import { describe, expect, it } from "vitest";
import { CS2_ITEM_CATALOG } from "../generated/cs2ItemCatalog.js";
import { resolveCs2WeaponModel } from "./cs2ItemCatalog.js";

describe("resolveCs2WeaponModel", () => {
  it("resolves every catalog model inside PWA and 5E affixes", () => {
    const models = [...new Set(
      Object.values(CS2_ITEM_CATALOG.bases).map((item) => item.model).filter(Boolean),
    )];
    expect(models.length).toBeGreaterThanOrEqual(40);

    const templates = [
      (model) => `${model}_vip`,
      (model) => `${model}_txz15`,
      (model) => `5e_summernbsr2026002_${model}`,
      (model) => `5e_tyloo2025_${model}_ace`,
    ];
    for (const model of models) {
      for (const decorate of templates) {
        const raw = decorate(model);
        expect(resolveCs2WeaponModel(raw), raw).toBe(model);
      }
    }
  });

  it("prefers the longest complete alias and preserves unknown substrings", () => {
    expect(resolveCs2WeaponModel("5e_event_m4a1_silencer_ace")).toBe("m4a1_silencer");
    expect(resolveCs2WeaponModel("5e_event_m4a1_ace")).toBe("m4a1");
    expect(resolveCs2WeaponModel("notak47")).toBe("");
  });
});
