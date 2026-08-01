const SNIPERS = new Set(["awp", "ssg08", "scar20", "g3sg1"]);
const RIFLES = new Set([
  "ak47", "aug", "famas", "galilar", "m4a1", "m4a1_silencer", "sg556",
]);
const PISTOLS = new Set([
  "deagle", "elite", "fiveseven", "glock", "tec9", "hkp2000", "p250",
  "usp_silencer", "cz75a", "revolver",
]);
const SMGS = new Set(["mac10", "mp9", "mp7", "mp5sd", "ump45", "p90", "bizon"]);
const SHOTGUNS = new Set(["nova", "xm1014", "mag7", "sawedoff"]);

export function slotKey(item) {
  const id = Number(item?.item_id);
  if (Number.isFinite(id) && id > 0) return `id:${id}`;
  if (item?.is_placeholder) return `placeholder:${Number(item?.def_index) || 0}`;
  return `def:${Number(item?.def_index) || 0}:${Number(item?.paint_index) || 0}:${Number(item?.paint_seed) || 0}:${Number(item?.paint_wear) || 0}`;
}

export function isCustomizable(item) {
  if (!item || item.is_placeholder) return false;
  return ["melee", "glove", "weapon"].includes(String(item?.type || ""));
}

/** 刀 → 手套 → 步枪 → 狙击枪 → 手枪 → 冲锋枪 → 喷子/其他 */
export function weaponClassRank(item) {
  const type = String(item?.type || "");
  if (type === "melee") return 0;
  if (type === "glove") return 1;
  if (type !== "weapon") return 7;
  const model = String(item?.model || "").toLowerCase();
  if (RIFLES.has(model)) return 2;
  if (SNIPERS.has(model)) return 3;
  if (PISTOLS.has(model)) return 4;
  if (SMGS.has(model)) return 5;
  if (SHOTGUNS.has(model)) return 6;
  return 7;
}

/** True when the item is a painted skin / non-default cosmetic (not a vanilla placeholder). */
export function hasSkinFinish(item) {
  if (!item || item.is_placeholder) return false;
  if (Number(item.paint_index) > 0) return true;
  const type = String(item.type || "");
  if (!["weapon", "melee", "glove"].includes(type)) return true;
  return String(item.name_zh || "").includes("|") || String(item.name_en || "").includes("|");
}

export function itemsForTeam(items, team) {
  const wanted = String(team || "").toLowerCase();
  return (Array.isArray(items) ? items : []).filter((item) => (
    Array.isArray(item?.observed_teams) && item.observed_teams.map(String).includes(wanted)
  ));
}

/**
 * Sort: skinned items first, then defaults; within each group
 * 刀 → 手套 → 步枪 → 狙击 → 手枪 → 冲锋枪.
 * `resolveItem` can map to a replacement for sort purposes.
 */
export function sortCosmeticsForRow(items, locale = "zh", resolveItem = null) {
  const resolve = typeof resolveItem === "function" ? resolveItem : (item) => item;
  const name = (item) => {
    const zh = String(item?.name_zh || "").trim();
    const en = String(item?.name_en || "").trim();
    return String(locale).toLowerCase().startsWith("zh") ? (zh || en) : (en || zh);
  };
  return [...(Array.isArray(items) ? items : [])].sort((left, right) => {
    const leftItem = resolve(left) || left;
    const rightItem = resolve(right) || right;
    return Number(hasSkinFinish(rightItem)) - Number(hasSkinFinish(leftItem))
      || weaponClassRank(leftItem) - weaponClassRank(rightItem)
      || Number(leftItem?.def_index || 0) - Number(rightItem?.def_index || 0)
      || name(leftItem).localeCompare(name(rightItem), locale)
      || Number(left?.item_id || 0) - Number(right?.item_id || 0);
  });
}

/**
 * Merge demo evidence onto default CT/T loadout placeholders.
 * Same def_index weapons replace the placeholder; any melee/glove evidence
 * replaces the default knife/gloves slot.
 */
export function mergeLoadoutWithEvidence(defaults, evidenceItems, locale = "zh") {
  const evidence = Array.isArray(evidenceItems) ? evidenceItems : [];
  const meleeEvidence = evidence.filter((item) => String(item?.type || "") === "melee");
  const gloveEvidence = evidence.filter((item) => String(item?.type || "") === "glove");
  const weaponEvidence = evidence.filter((item) => String(item?.type || "") === "weapon");
  const otherEvidence = evidence.filter((item) => !["melee", "glove", "weapon"].includes(String(item?.type || "")));

  const weaponsByDef = new Map();
  for (const item of weaponEvidence) {
    const def = Number(item?.def_index) || 0;
    if (!weaponsByDef.has(def)) weaponsByDef.set(def, []);
    weaponsByDef.get(def).push(item);
  }

  const merged = [];
  const consumedWeaponDefs = new Set();
  let meleePlaced = false;
  let glovePlaced = false;

  for (const placeholder of Array.isArray(defaults) ? defaults : []) {
    const type = String(placeholder?.type || "");
    if (type === "melee") {
      if (meleePlaced) continue;
      merged.push(...(meleeEvidence.length ? meleeEvidence : [placeholder]));
      meleePlaced = true;
      continue;
    }
    if (type === "glove") {
      if (glovePlaced) continue;
      merged.push(...(gloveEvidence.length ? gloveEvidence : [placeholder]));
      glovePlaced = true;
      continue;
    }
    if (type === "weapon") {
      const def = Number(placeholder?.def_index) || 0;
      const matches = weaponsByDef.get(def);
      if (matches?.length) {
        merged.push(...matches);
        consumedWeaponDefs.add(def);
      } else {
        merged.push(placeholder);
      }
      continue;
    }
    merged.push(placeholder);
  }

  if (!meleePlaced && meleeEvidence.length) merged.push(...meleeEvidence);
  if (!glovePlaced && gloveEvidence.length) merged.push(...gloveEvidence);

  for (const [def, rows] of weaponsByDef) {
    if (!consumedWeaponDefs.has(def)) merged.push(...rows);
  }
  merged.push(...otherEvidence);

  return sortCosmeticsForRow(merged, locale);
}
