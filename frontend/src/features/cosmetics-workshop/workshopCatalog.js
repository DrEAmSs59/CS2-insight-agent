import { CS2Team } from "@ianlucas/cs2-lib";
import { CS2_COSMETICS_ITEMS } from "../../generated/cs2CosmeticsCatalog.js";
const LOCAL_CATALOG = [];
import { craftNameParts, isVanillaKnife, sortCandidatesByRarityDesc } from "../demo-analysis/cosmetics/cosmeticsCatalog.js";

const IMAGE_BASE = "https://cdn.cstrike.app";

/** Workshop tabs, in display order. Agents and music kits come from the Lucas economy. */
export const WORKSHOP_CATEGORIES = ["weapon", "melee", "glove"];
export const FINISH_TYPES = ["weapon", "melee", "glove"];
export const CATEGORY_LABELS = {
  weapon: ["枪械", "Weapons"],
  melee: ["匕首", "Knives"],
  glove: ["手套", "Gloves"],
  agent: ["探员", "Agents"],
  musickit: ["音乐盒", "Music kits"],
};

export const WEAPON_CLASSES = ["rifle", "sniper", "pistol", "smg", "shotgun", "machineGun"];
const WEAPON_CLASS_MODELS = {
  sniper: new Set(["awp", "g3sg1", "scar20", "ssg08"]),
  rifle: new Set(["ak47", "aug", "famas", "galilar", "m4a1", "m4a1_silencer", "sg556"]),
  smg: new Set(["bizon", "mac10", "mp5sd", "mp7", "mp9", "p90", "ump45"]),
  pistol: new Set(["cz75a", "deagle", "elite", "fiveseven", "glock", "hkp2000", "p250", "revolver", "tec9", "usp_silencer"]),
  shotgun: new Set(["mag7", "nova", "sawedoff", "xm1014"]),
  machineGun: new Set(["m249", "negev"]),
};
// "All" lists guns in the same order as the class filter.
const WEAPON_CLASS_ORDER = [...WEAPON_CLASSES, "other"];
const DEFAULT_KNIVES = new Set(["knife", "knife_t"]);
const DEFAULT_GLOVES = new Set(["ct_gloves", "t_gloves"]);

function absoluteImage(image) {
  const source = String(image || "");
  return source.startsWith("http") ? source : `${IMAGE_BASE}${source}`;
}

export function toWorkshopItem(raw) {
  return {
    ...raw,
    catalog_id: Number(raw.catalog_id ?? raw.id),
    def_index: Number(raw.def_index ?? raw.def),
    paint_index: Number(raw.paint_index ?? raw.index ?? 0),
    name_en: String(raw.name_en ?? raw.nameEn ?? raw.model ?? ""),
    name_zh: String(raw.name_zh ?? raw.nameZh ?? raw.nameEn ?? raw.model ?? ""),
    alt_name: String(raw.alt_name ?? raw.altName ?? ""),
    image_url: absoluteImage(raw.image_url ?? raw.image),
    wear_min: Number.isFinite(Number(raw.wear_min ?? raw.wearMin)) ? Number(raw.wear_min ?? raw.wearMin) : 0,
    wear_max: Number.isFinite(Number(raw.wear_max ?? raw.wearMax)) ? Number(raw.wear_max ?? raw.wearMax) : 1,
    is_base: Boolean(raw.base || raw.is_base || raw.is_placeholder || Number(raw.paint_index ?? raw.index ?? 0) === 0),
  };
}

export const ALL_BASE_ITEMS = CS2_COSMETICS_ITEMS
  .filter((item) => item.base && FINISH_TYPES.includes(String(item.type || "")))
  .map(toWorkshopItem);
export const ALL_SKINS = CS2_COSMETICS_ITEMS
  .filter((item) => (!item.base || isVanillaKnife(item)) && FINISH_TYPES.includes(String(item.type || "")))
  .map(toWorkshopItem);

export function localizedName(item, locale) {
  return String(locale || "").startsWith("zh")
    ? String(item?.name_zh || item?.name_en || "")
    : String(item?.name_en || item?.name_zh || "");
}

export function weaponClass(item) {
  const model = String(item?.model || "");
  return Object.entries(WEAPON_CLASS_MODELS).find(([, models]) => models.has(model))?.[0] || "other";
}

function compareText(a, b) {
  return a.localeCompare(b, "zh-Hans-CN");
}

function baseFor(item) {
  return ALL_BASE_ITEMS.find((base) => base.type === item.type && base.def_index === item.def_index);
}

/** Every collectible item shown in the catalogue for one tab. */
export function catalogItems(category, locale) {
  if (category === "agent" || category === "musickit") {
    return LOCAL_CATALOG.filter((item) => item.type === category && !item.is_base)
      .sort((a, b) => compareText(localizedName(a, locale), localizedName(b, locale)));
  }
  const rows = ALL_SKINS.filter((item) => item.type === category);
  const order = (item) => (category === "weapon" ? WEAPON_CLASS_ORDER.indexOf(weaponClass(item)) : 0);
  return rows.sort((a, b) => (order(a) - order(b))
    || compareText(localizedName(baseFor(a), locale), localizedName(baseFor(b), locale))
    || Number(!isVanillaKnife(a)) - Number(!isVanillaKnife(b))
    || compareText(craftNameParts(a, locale).finish || "", craftNameParts(b, locale).finish || ""));
}

const modelKey = (item) => `${item.type}:${item.def_index}`;
const SKIN_COUNTS = ALL_SKINS.reduce((counts, item) => counts.set(modelKey(item), (counts.get(modelKey(item)) || 0) + 1), new Map());

/** First level of the gun, knife and glove tabs: every model that has finishes. Guns follow the scheme order. */
export function catalogModels(category, locale) {
  const rows = ALL_BASE_ITEMS.filter((item) => item.type === category && SKIN_COUNTS.has(modelKey(item)));
  if (category !== "weapon") return rows.sort((a, b) => compareText(localizedName(a, locale), localizedName(b, locale)));
  const order = (item) => WEAPON_CLASS_ORDER.indexOf(weaponClass(item));
  return rows.sort((a, b) => (order(a) - order(b)) || a.def_index - b.def_index);
}

export function modelSkinCount(model) {
  return SKIN_COUNTS.get(modelKey(model)) || 0;
}

/** Second level: every finish of one model; knives include their vanilla version. */
export function modelSkins(model) {
  return ALL_SKINS.filter((item) => modelKey(item) === modelKey(model));
}

export const CATALOG_SORTS = ["newest", "name", "rarity"];

/** Sorts of a model's finishes. Catalogue ids grow with release, so "newest" is the highest id. */
export function sortCatalogSkins(rows, sort, locale) {
  if (sort === "rarity") return sortCandidatesByRarityDesc(rows);
  if (sort === "name") return [...rows].sort((a, b) => compareText(localizedName(a, locale), localizedName(b, locale)));
  return [...rows].sort((a, b) => b.catalog_id - a.catalog_id);
}

/** Right-hand filter of the model list: gun class. Knives and gloves are already listed by type. */
export function catalogFilterOptions(category) {
  return category === "weapon" ? WEAPON_CLASSES.map((value) => ({ value, labelKey: `cosmeticsWorkshop.weaponCategory.${value}` })) : [];
}

export function matchesCatalogFilter(item, category, filter) {
  if (!filter || filter === "all") return true;
  if (category === "weapon") return weaponClass(item) === filter;
  return item.model === filter;
}

/* ─── Schemes ───────────────────────────────────────────────────────────── */

export const TEAM_KEYS = { [CS2Team.CT]: "ct", [CS2Team.T]: "t" };

function teamCode(team) {
  return team === CS2Team.CT ? 1 : 0;
}

/** Teams that can equip a catalogue item. Music kits are shared by both sides. */
export function itemTeams(item) {
  if (item?.type === "musickit") return [CS2Team.CT, CS2Team.T];
  if (item?.type === "agent") return (item.teams || []).filter((team) => team === CS2Team.CT || team === CS2Team.T);
  const teams = Number(item?.teams);
  if (teams === 1) return [CS2Team.CT];
  if (teams === 0) return [CS2Team.T];
  return [CS2Team.CT, CS2Team.T];
}

/** One scheme slot per item kind: each gun model, the knife, gloves, agent and music kit. */
export function schemeSlotKey(item) {
  return item?.type === "weapon" ? `weapon:${item.model}` : String(item?.type || "");
}

function teamDefault(rows, team) {
  const code = teamCode(team);
  return rows.find((item) => Number(item.teams) === code) || rows.find((item) => Number(item.teams) === 2) || null;
}

/** Default items a new scheme shows for one side of one tab. */
export function schemeDefaults(category, team) {
  if (category === "weapon") {
    const code = teamCode(team);
    const order = (item) => WEAPON_CLASS_ORDER.indexOf(weaponClass(item));
    return ALL_BASE_ITEMS.filter((item) => item.type === "weapon" && item.free
      && item.category !== "c4" && (Number(item.teams) === 2 || Number(item.teams) === code))
      .sort((a, b) => (order(a) - order(b)) || a.def_index - b.def_index);
  }
  if (category === "melee") return [teamDefault(ALL_BASE_ITEMS.filter((item) => item.type === "melee" && DEFAULT_KNIVES.has(item.model)), team)].filter(Boolean);
  if (category === "glove") return [teamDefault(ALL_BASE_ITEMS.filter((item) => item.type === "glove" && DEFAULT_GLOVES.has(item.model)), team)].filter(Boolean);
  if (category === "agent") return LOCAL_CATALOG.filter((item) => item.type === "agent" && item.is_base && item.teams?.includes(team)).slice(0, 1);
  if (category === "musickit") return LOCAL_CATALOG.filter((item) => item.type === "musickit" && item.is_base).slice(0, 1);
  return [];
}

/**
 * Picker rows when a scheme slot is clicked. Guns keep their model; knives,
 * gloves and agents list the models this side can use; music kits list all kits.
 */
export function schemeModelChoices(category, team, slotItem) {
  if (category === "weapon") return [baseFor(slotItem) || slotItem];
  if (category === "melee" || category === "glove") {
    const defaults = schemeDefaults(category, team);
    const special = category === "melee" ? DEFAULT_KNIVES : DEFAULT_GLOVES;
    return [...defaults, ...ALL_BASE_ITEMS.filter((item) => item.type === category && !special.has(item.model))];
  }
  if (category === "agent") return LOCAL_CATALOG.filter((item) => item.type === "agent" && item.teams?.includes(team))
    .sort((a, b) => Number(b.is_base) - Number(a.is_base));
  if (category === "musickit") return LOCAL_CATALOG.filter((item) => item.type === "musickit")
    .sort((a, b) => Number(b.is_base) - Number(a.is_base));
  return [];
}

/** Finishes of one model, starting with its stock version. */
export function modelFinishes(model) {
  const skins = ALL_SKINS.filter((item) => item.type === model.type && item.def_index === model.def_index && item.catalog_id !== model.catalog_id);
  return [model, ...skins];
}

/** A stock item with no attachment edits clears the slot back to the game default. */
export function isDefaultSelection(item) {
  if (!item) return true;
  if (item.type === "agent" || item.type === "musickit") return Boolean(item.is_base);
  return Boolean(item.is_base) && !isVanillaKnife(item) && !item.attachment_edit_version;
}

/** Write one slot of a plan. Derived Lucas loadout fields are rebuilt from selections on demand. */
export function withSchemeSelection(plan, teams, item) {
  const key = schemeSlotKey(item);
  const selections = { ct: { ...plan.selections?.ct }, t: { ...plan.selections?.t } };
  for (const team of teams) {
    const side = TEAM_KEYS[team];
    if (isDefaultSelection(item)) delete selections[side][key];
    else selections[side][key] = item;
  }
  const { lucas_loadout: _loadout, lucas_items: _items, legacy_selections: _legacy, ...rest } = plan;
  return { ...rest, selections };
}
