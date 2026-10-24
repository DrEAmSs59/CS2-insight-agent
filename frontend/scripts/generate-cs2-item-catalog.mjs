/*---------------------------------------------------------------------------------------------
 *  Copyright (c) unicbm. All rights reserved.
 *  Licensed under the PolyForm Noncommercial License 1.0.0. See LICENSE in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { requireFrontendDependencies } from "./require-frontend-dependencies.mjs";

requireFrontendDependencies();
const { CS2_ITEMS } = await import("@ianlucas/cs2-lib");
const { english } = await import("@ianlucas/cs2-lib/translations/english");
const { schinese } = await import("@ianlucas/cs2-lib/translations/schinese");

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
  if (hudStems.has(item.modelKey)) return item.modelKey;
  if (item.type === "melee") return hudStems.has("knife") ? "knife" : "";
  return "";
}

const items = CS2_ITEMS
  .filter((item) => wantedTypes.has(item.type) && Number.isInteger(item.definitionIndex))
  .sort((left, right) => (
    left.definitionIndex - right.definitionIndex
    || Number(left.variantIndex || 0) - Number(right.variantIndex || 0)
    || left.id - right.id
  ));

if (!items.length) throw new Error("CS2 catalog schema mismatch: no equipment entries");

const baseItems = items.filter((item) => item.isBase === true);
const aliases = {};
const bases = {};
const catalogItems = {};
const stickerKits = {};
const zhToEn = {};

for (const item of baseItems) {
  const nameEn = translatedName(english, item) || item.modelKey;
  const nameZh = translatedName(schinese, item) || nameEn;
  const hudStem = hudStemFor(item);
  const base = {
    id: item.id,
    def: item.definitionIndex,
    model: item.modelKey,
    player_model: String(item.modelPath || ""),
    type: item.type,
    name_en: nameEn,
    name_zh: nameZh,
    hud_stem: hudStem,
    image: item.imagePath || "",
    rarity: String(item.rarityColor || ""),
    teams: Number.isInteger(item.team) ? item.team : null,
  };
  bases[String(item.definitionIndex)] = base;
  zhToEn[nameZh] = nameEn;
  for (const rawAlias of [item.modelKey, nameEn, nameZh, `weapon_${item.modelKey}`]) {
    const alias = normalizedAlias(rawAlias);
    if (alias) aliases[alias] = item.modelKey;
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
  const paintIndex = Number(item.variantIndex || 0);
  const base = bases[String(item.definitionIndex)];
  const nameEn = translatedName(english, item) || base?.name_en || item.modelKey;
  const nameZh = translatedName(schinese, item) || base?.name_zh || nameEn;
  catalogItems[`${item.definitionIndex}:${paintIndex}`] = {
    id: item.id,
    base_id: Number.isInteger(item.parentId) ? item.parentId : null,
    def: item.definitionIndex,
    paint: paintIndex,
    model: item.modelKey,
    player_model: String(item.modelPath || ""),
    type: item.type,
    name_en: nameEn,
    name_zh: nameZh,
    alt_name: String(item.alternateName || ""),
    image: String(item.imagePath || ""),
    rarity: String(item.rarityColor || ""),
    category: String(item.loadoutCategory || ""),
    collection_image: String(item.collectionImagePath || ""),
    collection_name_en: translatedField(english, item, "collectionName"),
    collection_name_zh: translatedField(schinese, item, "collectionName"),
    desc_en: translatedField(english, item, "description"),
    desc_zh: translatedField(schinese, item, "description"),
    teams: Number.isInteger(item.team) ? item.team : null,
    wear_min: Number.isFinite(item.wearMin) ? item.wearMin : null,
    wear_max: Number.isFinite(item.wearMax) ? item.wearMax : null,
  };
}

for (const item of CS2_ITEMS) {
  if (item.type !== "sticker" || !Number.isInteger(item.variantIndex) || item.variantIndex <= 0) continue;
  const nameEn = translatedName(english, item) || `Sticker ${item.variantIndex}`;
  const nameZh = translatedName(schinese, item) || nameEn;
  stickerKits[String(item.variantIndex)] = {
    id: item.id,
    def: item.definitionIndex,
    paint: item.variantIndex,
    type: item.type,
    name_en: nameEn,
    name_zh: nameZh,
    image: String(item.imagePath || ""),
    rarity: String(item.rarityColor || ""),
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

const backendPath = join(
  repoRoot,
  "backend",
  "app",
  "features",
  "demo_analysis",
  "cs2_item_catalog.generated.json",
);
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

const cosmeticsItems = items
  .filter((item) => ["weapon", "melee", "glove", "agent", "musickit"].includes(item.type))
  .map((item) => ({
    id: item.id,
    baseId: Number.isInteger(item.parentId) ? item.parentId : null,
    def: item.definitionIndex,
    index: Number(item.variantIndex || 0),
    model: item.modelKey,
    type: item.type,
    nameEn: translatedName(english, item) || item.modelKey,
    nameZh: translatedName(schinese, item) || translatedName(english, item) || item.modelKey,
    altName: String(item.alternateName || ""),
    image: String(item.imagePath || ""),
    rarity: String(item.rarityColor || ""),
    category: String(item.loadoutCategory || ""),
    teams: Number.isInteger(item.team) ? item.team : null,
    wearMin: Number.isFinite(item.wearMin) ? item.wearMin : null,
    wearMax: Number.isFinite(item.wearMax) ? item.wearMax : null,
    free: item.isDefault === true,
    base: item.isBase === true,
  }));
const cosmeticsPath = join(frontendRoot, "src", "generated", "cs2CosmeticsCatalog.js");
writeFileSync(
  cosmeticsPath,
  "// Generated by scripts/generate-cs2-item-catalog.mjs. Do not edit manually.\n"
    + "export const CS2_COSMETICS_ITEMS = Object.freeze([\n"
    + cosmeticsItems.map((item) => `  ${JSON.stringify(item)},`).join("\n")
    + "\n]);\n",
  "utf8",
);

console.log(`[cs2-catalog] ${baseItems.length} base items, ${items.length} equipment entries, ${Object.keys(stickerKits).length} sticker kits from ${sourceVersion}`);
