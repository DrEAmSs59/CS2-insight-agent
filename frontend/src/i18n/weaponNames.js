import { CS2_ITEM_CATALOG } from "../generated/cs2ItemCatalog.js";
import { cs2BaseItemForModel, resolveCs2WeaponModel } from "../utils/cs2ItemCatalog.js";

/** Locale-aware weapon names generated from cs2-lib, plus legacy cache aliases. */

/** @type {Record<string, string>} */
export const WEAPON_NAME_ZH_TO_EN = {
  ...CS2_ITEM_CATALOG.zhToEn,
  // Workspaces parsed before the cs2-lib catalog migration can still contain
  // the project's former colloquial labels. Keep them readable in English.
  // 步枪
  "消音 M4A1-S":        "M4A1-S",
  "法玛斯 (FAMAS)":     "FAMAS",
  "加利尔 (Galil)":     "Galil AR",

  // 狙击枪
  "大狙 (AWP)":          "AWP",
  "鸟狙 (SSG08)":        "SSG 08",
  "连狙 (SCAR-20)":      "SCAR-20",
  "连狙 (G3SG1)":        "G3SG1",

  // 微冲
  "吹风机 (MAC-10)":     "MAC-10",
  "小蜜蜂 (MP9)":        "MP9",
  "车王 (UMP-45)":       "UMP-45",
  "野牛 (PP-Bizon)":     "PP-Bizon",

  // 手枪
  "沙鹰":                "Desert Eagle",
  "左轮 (R8)":           "R8 Revolver",
  "消音 USP-S":          "USP-S",
  "格洛克 (Glock-18)":   "Glock-18",
  "双持 (Dual Berettas)":"Dual Berettas",
  "五七 (Five-SeveN)":   "Five-SeveN",

  // 霰弹枪
  "截短霰弹枪":          "Sawed-Off",

  // 机枪
  "内格夫 (Negev)":      "Negev",

  // 投掷物 & 装备
  "手雷":                "HE Grenade",
  "闪光弹":              "Flashbang",
  "烟雾弹":              "Smoke Grenade",
  "燃烧弹":              "Incendiary",
  "燃烧瓶":              "Molotov",
  "诱饵弹":              "Decoy",
  "电击枪 (Zeus)":       "Zeus x27",

  // 刀具 — generic
  "刀":                  "Knife",
  "刺刀":                "Bayonet",

  // 刀具 — 皮肤变体 (all map to descriptive English names)
  "爪子刀":              "Karambit",
  "M9 刺刀":             "M9 Bayonet",
  "蝴蝶刀":              "Butterfly Knife",
  "折叠刀":              "Flip Knife",
  "穿肠刀":              "Gut Knife",
  "猎杀者匕首":          "Huntsman Knife",
  "弯刀":                "Falchion Knife",
  "博伊猎刀":            "Bowie Knife",
  "暗影双匕":            "Shadow Daggers",
  "系绳匕首":            "Paracord Knife",
  "求生匕首":            "Survival Knife",
  "熊刀":                "Ursus Knife",
  "流浪者匕首":          "Nomad Knife",
  "户外匕首":            "Outdoor Knife",
  "短剑":                "Stiletto Knife",
  "锯齿爪刀":            "Talon Knife",
  "骷髅匕首":            "Skeleton Knife",
  "经典刀":              "Classic Knife",
  "廓尔喀刀":            "Kukri Knife",

  // 其他环境伤害
  "坠落/世界伤害":       "World Damage",
  "C4 爆炸":             "C4 Explosion",
  "拆弹器":              "Defuse Kit",
};

const WEAPON_NAME_EN_CASEFOLD = new Set([
  ...Object.values(CS2_ITEM_CATALOG.bases).map((item) => item?.name_en),
  ...Object.values(WEAPON_NAME_ZH_TO_EN),
].filter(Boolean).map((name) => String(name).toLocaleLowerCase("en")));

/**
 * Return the weapon's display name appropriate for the current locale.
 *
 * - Parser/platform aliases are resolved through the generated CS2 catalog,
 *   including dynamic PWA/5E prefixes and suffixes around a schema name.
 * - Existing translated labels stay readable; unknown values are preserved so
 *   nothing ever becomes blank or mislabeled.
 * - Null / empty input: returned as-is (preserves "—" fallback at call sites).
 *
 * @param {string | null | undefined} weaponName
 * @param {string} locale  e.g. "zh" | "en"
 * @returns {string}
 */
export function weaponDisplayName(weaponName, locale) {
  if (weaponName == null) return weaponName;
  const raw = typeof weaponName === "string" ? weaponName : String(weaponName);
  if (!raw) return raw;

  // Preserve the project's established Chinese labels. Raw parser aliases are
  // not keys in this map and continue into catalog canonicalization below.
  if (locale !== "en" && Object.prototype.hasOwnProperty.call(WEAPON_NAME_ZH_TO_EN, raw)) {
    return raw;
  }
  if (locale === "en" && WEAPON_NAME_EN_CASEFOLD.has(raw.toLocaleLowerCase("en"))) {
    return raw;
  }

  const model = resolveCs2WeaponModel(raw);
  const base = model ? cs2BaseItemForModel(model) : null;
  if (base) {
    const canonical = locale === "en" ? base.name_en : base.name_zh;
    return String(canonical || base.name_en || model);
  }

  if (locale === "en") return WEAPON_NAME_ZH_TO_EN[raw] ?? raw;
  return raw;
}

/** Split backend `weapon_used` ("A / B") and localize each token. */
export function weaponUsedTokens(raw, locale) {
  if (raw == null || String(raw).trim() === "") return [];
  return String(raw)
    .split(" / ")
    .map((w) => w.trim())
    .filter(Boolean)
    .map((w) => weaponDisplayName(w, locale));
}
