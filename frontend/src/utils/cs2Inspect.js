/*---------------------------------------------------------------------------------------------
 *  Copyright (c) unicbm. All rights reserved.
 *  Licensed under the PolyForm Noncommercial License 1.0.0. See LICENSE in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { CS2EconomyInstance, CS2Inventory } from "@ianlucas/cs2-lib";
import { generateInspectLink } from "@ianlucas/cs2-lib-inspect";

function finiteNumber(value) {
  const number = Number(value);
  return Number.isFinite(number) ? number : undefined;
}

function catalogItem(item) {
  const id = Number(item?.catalog_id);
  const definition = Number(item?.def_index);
  const paintIndex = Number(item?.paint_index || 0);
  if (!Number.isInteger(id) || id < 0 || !Number.isInteger(definition)) return null;
  return {
    id,
    baseId: Number.isInteger(Number(item?.base_catalog_id)) ? Number(item.base_catalog_id) : undefined,
    def: definition,
    index: paintIndex,
    type: String(item?.type || "weapon"),
    model: String(item?.model || "") || undefined,
    image: String(item?.image_url || "").replace(/^https:\/\/cdn\.cstrike\.app/, "") || undefined,
    rarity: String(item?.rarity || "#ded6cc"),
    teams: Number.isInteger(Number(item?.teams)) ? Number(item.teams) : undefined,
    wearMin: finiteNumber(item?.wear_min),
    wearMax: finiteNumber(item?.wear_max),
  };
}

function stickerCatalogItem(sticker) {
  const raw = catalogItem({
    ...sticker,
    def_index: sticker?.def_index ?? 1209,
    type: "sticker",
  });
  // CS2EconomyInstance requires every sticker catalog row to have a category.
  // Demo evidence only exposes the sticker kit, not Valve's marketplace
  // category, and the category is irrelevant to preview serialization.
  return raw ? { ...raw, type: "sticker", category: "demo" } : null;
}

/** Build Valve's self-contained CS2 preview link from evidence stored in a Demo. */
export function buildCs2InspectLink(item) {
  const main = catalogItem(item);
  if (!main || item?.catalog_exact === false || item?.finish_known === false) {
    throw new Error("The Demo item is not an exact cs2-lib catalog match.");
  }

  const stickerRows = Array.isArray(item?.stickers) ? item.stickers : [];
  const stickerItems = stickerRows.map(stickerCatalogItem).filter(Boolean);
  const economy = new CS2EconomyInstance();
  const language = {
    [main.id]: { name: String(item?.name_en || item?.name_zh || item?.model || "CS2 item") },
  };
  stickerRows.forEach((sticker) => {
    const id = Number(sticker?.catalog_id);
    if (Number.isInteger(id)) {
      language[id] = { name: String(sticker?.name_en || sticker?.name_zh || "Sticker") };
    }
  });
  economy.load({ items: [main, ...stickerItems], language });

  const attributes = { id: main.id };
  const wear = finiteNumber(item?.paint_wear);
  const seed = finiteNumber(item?.paint_seed);
  if (wear !== undefined) attributes.wear = Number(wear.toFixed(6));
  if (seed !== undefined) attributes.seed = Math.trunc(seed);
  if (stickerItems.length) {
    attributes.stickers = Object.fromEntries(stickerRows.flatMap((sticker, index) => {
      const id = Number(sticker?.catalog_id);
      if (!Number.isInteger(id)) return [];
      const stickerData = { id };
      const stickerWear = finiteNumber(sticker?.wear);
      // cs2-lib models sticker scraping in 0.01 steps. Demo entity floats can
      // contain binary noise (for example 0.905636), which its inventory
      // validator correctly rejects unless normalized to that protocol step.
      if (stickerWear !== undefined) stickerData.wear = Number(stickerWear.toFixed(2));
      return [[String(sticker?.slot ?? index), stickerData]];
    }));
  }

  const inventory = new CS2Inventory({ economy });
  inventory.add(attributes);
  const inventoryItem = inventory.getAll()[0];
  // Demo name tags are already accepted by Valve. Assign after cs2-lib's
  // editor-oriented validation so legacy Unicode and full-width punctuation
  // remain byte-for-byte intact in the generated preview payload.
  const customName = typeof item?.custom_name === "string" ? item.custom_name : "";
  if (customName) inventoryItem.nameTag = customName;
  return generateInspectLink(inventoryItem);
}

export function buildCs2ViewerUrl(item) {
  const id = Number(item?.catalog_id);
  if (!Number.isInteger(id)) return "";
  const viewerItem = { id };
  const wear = finiteNumber(item?.paint_wear);
  const seed = finiteNumber(item?.paint_seed);
  if (wear !== undefined) viewerItem.wear = Number(wear.toFixed(6));
  if (seed !== undefined) viewerItem.seed = Math.trunc(seed);
  if (typeof item?.custom_name === "string" && item.custom_name) {
    viewerItem.nameTag = item.custom_name;
  }
  const stickers = Array.isArray(item?.stickers) ? item.stickers : [];
  if (stickers.length) {
    viewerItem.stickers = Object.fromEntries(stickers.flatMap((sticker, index) => {
      const stickerId = Number(sticker?.catalog_id);
      if (!Number.isInteger(stickerId)) return [];
      return [[String(sticker?.slot ?? index), {
        id: stickerId,
        wear: finiteNumber(sticker?.wear),
      }]];
    }));
  }
  const url = new URL("https://3d.cstrike.app/view");
  url.searchParams.set("halfRotation", "1");
  url.searchParams.set("bg", "0");
  url.searchParams.set("item", JSON.stringify(viewerItem));
  return url.toString();
}
