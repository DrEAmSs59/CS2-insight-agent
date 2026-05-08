/**
 * 将解析器武器 id / 展示名映射为 hud.hlae.site（One Studio CSGO HUD Generator）打包的 SVG 文件名。
 * 资源在 `public/hud-death-notice/`。
 *
 * 5E 等 demo 常见 `weapon_key` 如 `5e_xxxx_ak47`，不能整串相等判断；在归一化后的字符串里
 * 用**更长 stem 优先**的子串匹配（如 `m4a1_silencer` 先于 `m4a1`）。`weapon_name` 一并参与匹配
 *（如 "M4A1-S" → m4a1_s）。
 */

const STEM_ALIASES = {
  mac_10: "mac10",
  knife_ct: "knife",
  planted_c4: "c4",
  defuse_kit: "defuser",
  world: "suicide",
  knife_kukri: "knife",
  /** 展示名常见简写 / 平台 key 残段 */
  m4a1_s: "m4a1_silencer",
  usp_s: "usp_silencer",
};

/**
 * 与 `public/hud-death-notice/*.svg` 对应、且会出现在击杀上的武器 / 刀 / 雷 / C4。
 * 按长度降序排列（子串匹配时先匹配长的，避免 m4a1 吃掉 m4a1_silencer）。
 */
const WEAPON_STEMS_LONGEST_FIRST = [
  "breachcharge_projectile",
  "knife_survival_bowie",
  "knife_gypsy_jackknife",
  "m4a1_silencer_off",
  "m4a1_silencer",
  "m4a1_s",
  "usp_silencer_off",
  "usp_silencer",
  "usp_s",
  "knife_m9_bayonet",
  "knife_butterfly",
  "knife_falchion",
  "knife_stiletto",
  "knife_skeleton",
  "knife_widowmaker",
  "knife_karambit",
  "knife_outdoor",
  "knife_tactical",
  "knife_canis",
  "knife_ursus",
  "knife_cord",
  "knife_push",
  "knife_bowie",
  "knife_flip",
  "knife_gut",
  "knife_css",
  "frag_grenade",
  "smokegrenade",
  "hegrenade",
  "incgrenade",
  "flashbang",
  "hkp2000",
  "scar20",
  "sg556",
  "ssg08",
  "galilar",
  "sawedoff",
  "fiveseven",
  "revolver",
  "ump45",
  "mp5sd",
  "mac_10",
  "mac10",
  "tec9",
  "bizon",
  "p2000",
  "p250",
  "cz75a",
  "deagle",
  "elite",
  "famas",
  "glock",
  "g3sg1",
  "m249",
  "mag7",
  "molotov",
  "negev",
  "nova",
  "p90",
  "mp7",
  "mp9",
  "aug",
  "awp",
  "ak47",
  "m4a1",
  "xm1014",
  "decoy",
  "taser",
  "c4",
  "breachcharge",
  "tagrenade",
  "bayonet",
  "knife",
].sort((a, b) => b.length - a.length || a.localeCompare(b));

function normalizeWeaponHaystack(rawKey, rawName) {
  return `${String(rawKey || "").trim()} ${String(rawName || "").trim()}`
    .trim()
    .toLowerCase()
    .replace(/-/g, "_")
    .replace(/\s+/g, "_")
    .replace(/_+/g, "_");
}

/**
 * @param {string | null | undefined} rawKey
 * @param {string | null | undefined} [rawName] weapon_name，辅助匹配 M4A1-S 等
 * @returns {string} 不含 `.svg` 的文件名
 */
export function resolveHudWeaponStem(rawKey, rawName) {
  const hay = normalizeWeaponHaystack(rawKey, rawName);
  if (!hay) return "ak47";

  if (STEM_ALIASES[hay]) return STEM_ALIASES[hay];

  for (const stem of WEAPON_STEMS_LONGEST_FIRST) {
    if (hay.includes(stem)) {
      return STEM_ALIASES[stem] || stem;
    }
  }

  return "ak47";
}
