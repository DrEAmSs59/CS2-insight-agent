/*---------------------------------------------------------------------------------------------
 *  Copyright (c) unicbm. All rights reserved.
 *  Licensed under the PolyForm Noncommercial License 1.0.0. See LICENSE in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { CS2_ITEMS } from "@ianlucas/cs2-lib";
import { english } from "@ianlucas/cs2-lib/translations/english";
import { schinese } from "@ianlucas/cs2-lib/translations/schinese";

const frontendRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
const repoRoot = join(frontendRoot, "..");
const packageJson = JSON.parse(readFileSync(join(frontendRoot, "package.json"), "utf8"));
const sourceVersion = packageJson.devDependencies?.["@ianlucas/cs2-lib"];
const imageBaseUrl = "https://cdn.cstrike.app";
const wantedTypes = new Set(["agent", "glove", "melee", "musickit", "utility", "weapon"]);
const hudDir = join(frontendRoot, "public", "hud-death-notice");
const hudStems = new Set(
  readdirSync(hudDir)
    .filter((name) => name.endsWith(".svg"))
    .map((name) => name.slice(0, -4)),
);

function normalizedAlias(value) {
  return String(value || "")
    .trim()
    .toLowerCase()
    .replace(/^weapon_/, "")
    .replace(/[\s-]+/g, "_")
    .replace(/[^\p{L}\p{N}_]+/gu, "_")
    .replace(/_+/g, "_")
    .replace(/^_|_$/g, "");
}

function translatedName(language, item) {
  return String(language[item.id]?.name || "").trim();
}

function translatedField(language, item, field) {
  return String(language[item.id]?.[field] || "").trim();
}

function hudStemFor(item) {
  if (hudStems.has(item.model)) return item.model;
  if (item.type === "melee") return hudStems.has("knife") ? "knife" : "";
  return "";
}

const items = CS2_ITEMS
  .filter((item) => wantedTypes.has(item.type) && Number.isInteger(item.def))
  .sort((left, right) => (
    left.def - right.def
    || Number(left.index || 0) - Number(right.index || 0)
    || left.id - right.id
  ));

const baseItems = items.filter((item) => item.base === true);
const aliases = {};
const bases = {};
const catalogItems = {};
const stickerKits = {};
const zhToEn = {};

for (const item of baseItems) {
  const nameEn = translatedName(english, item) || item.model;
  const nameZh = translatedName(schinese, item) || nameEn;
  const hudStem = hudStemFor(item);
  const base = {
    id: item.id,
    def: item.def,
    model: item.model,
    player_model: String(item.playerModel || ""),
    type: item.type,
    name_en: nameEn,
    name_zh: nameZh,
    hud_stem: hudStem,
    image: item.image || "",
    rarity: String(item.rarity || ""),
    teams: Number.isInteger(item.teams) ? item.teams : null,
  };
  bases[String(item.def)] = base;
  zhToEn[nameZh] = nameEn;
  for (const rawAlias of [item.model, nameEn, nameZh, `weapon_${item.model}`]) {
    const alias = normalizedAlias(rawAlias);
    if (alias) aliases[alias] = item.model;
  }
}

// Names emitted by Demo parsers and third-party platforms that are not base
// economy model names. Keep this list deliberately small; the item schema above
// remains the source of truth for actual CS2 weapons and finishes.
Object.assign(aliases, {
  knife_ct: "knife",
  m4a1_s: "m4a1_silencer",
  mac_10: "mac10",
  usp_s: "usp_silencer",
});

for (const item of items) {
  const paintIndex = Number(item.index || 0);
  const base = bases[String(item.def)];
  const nameEn = translatedName(english, item) || base?.name_en || item.model;
  const nameZh = translatedName(schinese, item) || base?.name_zh || nameEn;
  catalogItems[`${item.def}:${paintIndex}`] = {
    id: item.id,
    base_id: Number.isInteger(item.baseId) ? item.baseId : null,
    def: item.def,
    paint: paintIndex,
    model: item.model,
    player_model: String(item.playerModel || ""),
    type: item.type,
    name_en: nameEn,
    name_zh: nameZh,
    alt_name: String(item.altName || ""),
    image: String(item.image || ""),
    rarity: String(item.rarity || ""),
    category: String(item.category || ""),
    collection_image: String(item.collectionImage || ""),
    collection_name_en: translatedField(english, item, "collectionName"),
    collection_name_zh: translatedField(schinese, item, "collectionName"),
    desc_en: translatedField(english, item, "desc"),
    desc_zh: translatedField(schinese, item, "desc"),
    teams: Number.isInteger(item.teams) ? item.teams : null,
    wear_min: Number.isFinite(item.wearMin) ? item.wearMin : null,
    wear_max: Number.isFinite(item.wearMax) ? item.wearMax : null,
  };
}

for (const item of CS2_ITEMS) {
  if (item.type !== "sticker" || !Number.isInteger(item.index) || item.index <= 0) continue;
  const nameEn = translatedName(english, item) || `Sticker ${item.index}`;
  const nameZh = translatedName(schinese, item) || nameEn;
  stickerKits[String(item.index)] = {
    id: item.id,
    def: item.def,
    paint: item.index,
    type: item.type,
    name_en: nameEn,
    name_zh: nameZh,
    image: String(item.image || ""),
    rarity: String(item.rarity || ""),
  };
}

const ordered = (value) => Object.fromEntries(
  Object.entries(value).sort(([left], [right]) => left.localeCompare(right, "en")),
);
const backendPayload = {
  schema_version: 2,
  source: "@ianlucas/cs2-lib",
  source_version: sourceVersion,
  source_url: "https://github.com/ianlucas/cs2-lib",
  image_base_url: imageBaseUrl,
  bases: ordered(bases),
  aliases: ordered(aliases),
  items: ordered(catalogItems),
  stickers: ordered(stickerKits),
};

const backendPath = join(repoRoot, "backend", "app", "parser", "cs2_item_catalog.generated.json");
mkdirSync(dirname(backendPath), { recursive: true });
writeFileSync(backendPath, `${JSON.stringify(backendPayload, null, 2)}\n`, "utf8");

const frontendPayload = {
  source: backendPayload.source,
  sourceVersion,
  imageBaseUrl,
  aliases: ordered(aliases),
  bases: ordered(bases),
  zhToEn: ordered(zhToEn),
};
const frontendPath = join(frontendRoot, "src", "generated", "cs2ItemCatalog.js");
mkdirSync(dirname(frontendPath), { recursive: true });
writeFileSync(
  frontendPath,
  `// Generated by scripts/generate-cs2-item-catalog.mjs. Do not edit manually.\n`
    + `export const CS2_ITEM_CATALOG = Object.freeze(${JSON.stringify(frontendPayload, null, 2)});\n`,
  "utf8",
);

console.log(
  `[cs2-catalog] ${baseItems.length} base items, ${items.length} equipment entries, ${Object.keys(stickerKits).length} sticker kits from ${sourceVersion}`,
);
