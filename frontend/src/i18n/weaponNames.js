/**
 * Locale-aware weapon name display.
 *
 * The backend (backend/app/parser/weapons.py WEAPON_TRANSLATION_MAP) emits
 * Chinese display names for many weapons.  Under the English UI we reverse-map
 * those Chinese strings back to standard CS2 English names.
 *
 * Names that are already pure ASCII/English in the map (AUG, MP7, P90, Nova,
 * M249, TEC-9, P250, XM1014, MAG-7, MP5-SD, P2000, CZ-75, AK-47, M4A4,
 * SG 553) do NOT need an entry here — the fallback returns them unchanged.
 */

/** @type {Record<string, string>} */
export const WEAPON_NAME_ZH_TO_EN = {
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

/**
 * Return the weapon's display name appropriate for the current locale.
 *
 * - Non-English locale: returns `weaponName` unchanged (Chinese stays Chinese).
 * - English locale: reverse-maps Chinese display names to English CS2 names;
 *   falls back to the original string for names that are already English or
 *   are unknown (so nothing ever becomes blank or mislabeled).
 * - Null / empty input: returned as-is (preserves "—" fallback at call sites).
 *
 * @param {string | null | undefined} weaponName
 * @param {string} locale  e.g. "zh" | "en"
 * @returns {string}
 */
export function weaponDisplayName(weaponName, locale) {
  if (weaponName == null) return weaponName;
  if (typeof weaponName !== "string") return String(weaponName);
  if (!weaponName) return weaponName;
  if (locale !== "en") return weaponName;
  return WEAPON_NAME_ZH_TO_EN[weaponName] ?? weaponName;
}
