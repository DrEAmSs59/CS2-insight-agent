/**
 * 将解析器归一化武器 id 映射为 hud.hlae.site（One Studio CSGO HUD Generator）打包的 SVG 文件名。
 * 资源已 vendoring 到 `public/hud-death-notice/`（见 DeathNoticeRow 注释）。
 */

const STEM_ALIASES = {
  mac_10: "mac10",
  knife_ct: "knife",
  planted_c4: "c4",
  defuse_kit: "defuser",
  world: "suicide",
  knife_kukri: "knife",
};

/**
 * @param {string | null | undefined} rawKey demo_parser `_normalize_item` 结果
 * @returns {string} 不含 `.svg` 的文件名
 */
export function resolveHudWeaponStem(rawKey) {
  const w = String(rawKey || "")
    .trim()
    .toLowerCase()
    .replace(/-/g, "_");
  if (!w) return "ak47";
  return STEM_ALIASES[w] || w;
}
