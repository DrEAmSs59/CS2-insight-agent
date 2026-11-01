import { expect, test } from "vitest";
import { currentItemFirst } from "./workshopCurrentItem.js";

test("pins the saved appearance without resetting it or mutating catalogue order", () => {
  const rows = [{ type: "weapon", def_index: 7, paint_index: 302, catalog_id: 1 }, { type: "weapon", def_index: 7, paint_index: 282, catalog_id: 2 }];
  const current = { ...rows[1], catalog_id: null, paint_wear: .234567, paint_seed: 661,
    custom_name: "当前名称", stickers: [{ definition_id: 100, wear: .1, rotation: 33, x: .125 }],
    keychain: { definition_id: 12, seed: 90000, x: 1, y: 2, z: 3 } };
  const pinned = currentItemFirst(rows, current);
  expect(pinned).toEqual([current, rows[0]]);
  expect(pinned[0]).toBe(current);
  expect(rows.map(row => row.catalog_id)).toEqual([1, 2]);
  expect(currentItemFirst(rows, null)).toBe(rows);
});

test("retains the clean stock reset action and separates experimental source appearances", () => {
  const stock = { type: "weapon", def_index: 7, paint_index: 0, catalog_id: 1, is_base: true };
  const current = { ...stock, custom_name: "原皮名称", attachment_edit_version: 1 };
  expect(currentItemFirst([stock], current, { keepStock: true })).toEqual([current, stock]);
  const experimental = { ...stock, paint_index: 568, experimental_paint_source_catalog_id: 100 };
  const official = { ...experimental, experimental_paint_source_catalog_id: undefined };
  expect(currentItemFirst([official], experimental)).toEqual([experimental, official]);
});
