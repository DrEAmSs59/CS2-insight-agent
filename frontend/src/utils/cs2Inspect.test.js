import { describe, expect, test } from "vitest";
import { buildCs2InspectLink, buildCs2ViewerUrl } from "./cs2Inspect.js";

const ITEM = {
  catalog_id: 1376,
  base_catalog_id: 42,
  def_index: 508,
  paint_index: 415,
  model: "knife_m9_bayonet",
  type: "melee",
  name_en: "M9 Bayonet | Doppler",
  image_url: "https://cdn.cstrike.app/images/knife.webp",
  rarity: "#eb4b4b",
  teams: 2,
  wear_min: 0,
  wear_max: 0.08,
  catalog_exact: true,
  paint_wear: 0.016897,
  paint_seed: 80,
  custom_name: "全角，测试！",
};

describe("CS2 cosmetic inspect helpers", () => {
  test("generates Valve's self-contained preview URL without normalizing Unicode name tags", () => {
    const link = buildCs2InspectLink(ITEM);

    expect(link).toMatch(/^steam:\/\/rungame\/730\//);
    expect(link).toContain("csgo_econ_action_preview");
  });

  test("generates a preview URL for demo weapons carrying stickers", () => {
    const link = buildCs2InspectLink({
      ...ITEM,
      type: "weapon",
      model: "ak47",
      def_index: 7,
      catalog_id: 222,
      base_catalog_id: 4,
      paint_index: 282,
      wear_max: 0.7,
      stickers: [
        {
          catalog_id: 1901,
          def_index: 1209,
          paint_index: 200,
          type: "sticker",
          name_en: "Sticker | iBUYPOWER (Holo) | Katowice 2014",
          image_url: "https://cdn.cstrike.app/images/sticker.webp",
          rarity: "#8847ff",
          // Raw Demo entity floats are not guaranteed to land on cs2-lib's
          // supported 0.01 sticker-scrape step.
          wear: 0.905636,
          slot: 0,
        },
      ],
    });

    expect(link).toMatch(/^steam:\/\/rungame\/730\//);
    expect(link).toContain("csgo_econ_action_preview");
  });

  test("passes the exact cs2-lib item, wear, seed and name to the 3D viewer", () => {
    const url = new URL(buildCs2ViewerUrl(ITEM));
    const viewerItem = JSON.parse(url.searchParams.get("item"));

    expect(url.origin).toBe("https://3d.cstrike.app");
    expect(url.searchParams.get("bg")).toBe("0");
    expect(viewerItem).toEqual({
      id: 1376,
      wear: 0.016897,
      seed: 80,
      nameTag: "全角，测试！",
    });
  });

  test("rejects a fallback catalog match rather than inspecting the wrong finish", () => {
    expect(() => buildCs2InspectLink({ ...ITEM, catalog_exact: false })).toThrow();
    expect(() => buildCs2InspectLink({ ...ITEM, finish_known: false })).toThrow();
  });
});
