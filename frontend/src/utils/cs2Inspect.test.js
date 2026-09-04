import { describe, expect, test, vi } from "vitest";
import {
  buildCs2InspectLink,
  buildCs2ViewerUrl,
  inspectHexFromValue,
  launchCs2Inspect,
} from "./cs2Inspect.js";

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

    expect(link).toMatch(/^steam:\/\/rungame\/730\/76561202255233023\//);
    expect(link).toContain("csgo_econ_action_preview");
    expect(inspectHexFromValue(link)).toMatch(/^[0-9A-F]+$/);
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

    expect(link).toMatch(/^steam:\/\/rungame\/730\/76561202255233023\//);
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

  test("builds from direct item fields without catalog IDs and accepts seed zero", () => {
    expect(buildCs2InspectLink({
      def_index: 7,
      paint_index: 282,
      paint_wear: 0.07,
      paint_seed: 0,
      catalog_exact: false,
    })).toMatch(/^steam:\/\/rungame\/730\/76561202255233023\//);
    expect(() => buildCs2InspectLink({ ...ITEM, finish_known: false })).toThrow();
  });

  test("launches a validated inspect payload through the dedicated desktop command", async () => {
    const launchInspect = vi.fn(async () => {});
    const openExternal = vi.fn(async () => {});
    const writeClipboardText = vi.fn(async () => {});

    await expect(launchCs2Inspect(ITEM, { launchInspect, openExternal, writeClipboardText })).resolves.toMatchObject({
      status: "launched",
      value: expect.stringMatching(/^steam:\/\/rungame\/730\/76561202255233023\//),
    });
    expect(launchInspect).toHaveBeenCalledWith(expect.stringMatching(/^[0-9A-F]+$/));
    expect(openExternal).not.toHaveBeenCalled();
    expect(writeClipboardText).not.toHaveBeenCalled();
  });

  test("copies a console command, never a URL, when Steam cannot be opened", async () => {
    const openExternal = vi.fn(async () => {
      throw new Error("Steam unavailable");
    });
    const writeClipboardText = vi.fn(async () => {});

    await expect(launchCs2Inspect(ITEM, { openExternal, writeClipboardText })).resolves.toMatchObject({
      status: "command-copied",
      value: expect.stringMatching(/^csgo_econ_action_preview [0-9A-F]+$/),
    });
    expect(writeClipboardText).toHaveBeenCalledTimes(1);
  });
});
