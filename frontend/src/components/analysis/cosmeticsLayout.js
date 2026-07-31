const SNIPERS = new Set(["awp", "ssg08", "scar20", "g3sg1"]);
const SHOTGUNS = new Set(["nova", "xm1014", "mag7", "sawedoff"]);
const SMGS = new Set(["mac10", "mp9", "mp7", "mp5sd", "ump45", "p90", "bizon"]);

export function slotKey(item) {
  const id = Number(item?.item_id);
  if (Number.isFinite(id) && id > 0) return `id:${id}`;
  return `def:${Number(item?.def_index) || 0}:${Number(item?.paint_index) || 0}:${Number(item?.paint_seed) || 0}:${Number(item?.paint_wear) || 0}`;
}

export function isCustomizable(item) {
  return ["melee", "glove", "weapon"].includes(String(item?.type || ""));
}

export function weaponClassRank(item) {
  const type = String(item?.type || "");
  if (type === "melee") return 0;
  if (type === "glove") return 1;
  if (type !== "weapon") return 6;
  const model = String(item?.model || "").toLowerCase();
  if (SNIPERS.has(model)) return 2;
  if (SHOTGUNS.has(model)) return 5;
  if (SMGS.has(model)) return 4;
  // remaining rifles (ak47, m4, …) and anything else in rifle category → 3 if not sniper
  // pistols / LMGs → 6
  const RIFLES = new Set([
    "ak47", "aug", "famas", "galilar", "m4a1", "m4a1_silencer", "sg556",
  ]);
  if (RIFLES.has(model)) return 3;
  return 6;
}

export function itemsForTeam(items, team) {
  const wanted = String(team || "").toLowerCase();
  return (Array.isArray(items) ? items : []).filter((item) => (
    Array.isArray(item?.observed_teams) && item.observed_teams.map(String).includes(wanted)
  ));
}

export function sortCosmeticsForRow(items, locale = "zh") {
  const name = (item) => {
    const zh = String(item?.name_zh || "").trim();
    const en = String(item?.name_en || "").trim();
    return String(locale).toLowerCase().startsWith("zh") ? (zh || en) : (en || zh);
  };
  return [...(Array.isArray(items) ? items : [])].sort((left, right) => (
    weaponClassRank(left) - weaponClassRank(right)
    || name(left).localeCompare(name(right), locale)
    || Number(left?.item_id || 0) - Number(right?.item_id || 0)
  ));
}
