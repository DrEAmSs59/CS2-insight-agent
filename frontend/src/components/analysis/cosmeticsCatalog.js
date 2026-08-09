import { CS2_COSMETICS_ITEMS } from "../../generated/cs2CosmeticsCatalog.js";

const IMAGE_BASE = "https://cdn.cstrike.app";
const RARITY_RANK = {
  "#e4ae39": 7,
  "#eb4b4b": 6,
  "#d32ce6": 5,
  "#8847ff": 4,
  "#4b69ff": 3,
  "#5e98d9": 2,
  "#b0c3d9": 1,
  "#ded6cc": 0,
};

function toCandidate(raw) {
  const image = String(raw.image || "");
  const altName = String(raw.altName || "").trim();
  return {
    catalog_id: Number(raw.id),
    def_index: Number(raw.def),
    paint_index: Number(raw.index || 0),
    model: String(raw.model || ""),
    type: String(raw.type || ""),
    name_en: String(raw.nameEn || raw.model || ""),
    name_zh: String(raw.nameZh || raw.nameEn || raw.model || ""),
    alt_name: altName || undefined,
    image_url: image ? (image.startsWith("http") ? image : `${IMAGE_BASE}${image}`) : "",
    rarity: String(raw.rarity || "#ded6cc"),
    wear_min: Number.isFinite(Number(raw.wearMin)) ? Number(raw.wearMin) : undefined,
    wear_max: Number.isFinite(Number(raw.wearMax)) ? Number(raw.wearMax) : undefined,
  };
}

export function listSkinCandidates(sourceItem) {
  const type = String(sourceItem?.type || "");
  const def = Number(sourceItem?.def_index);
  const rows = CS2_COSMETICS_ITEMS.filter((item) => {
    if (item.base) return false;
    if (type === "melee") return item.type === "melee";
    if (type === "glove") return item.type === "glove";
    if (type === "weapon") return item.type === "weapon" && Number(item.def) === def;
    return false;
  });
  return sortCandidatesByRarityDesc(rows.map(toCandidate));
}

export function sortCandidatesByRarityDesc(candidates) {
  return [...(Array.isArray(candidates) ? candidates : [])].sort((left, right) => (
    (RARITY_RANK[String(right?.rarity || "").toLowerCase()] ?? -1)
    - (RARITY_RANK[String(left?.rarity || "").toLowerCase()] ?? -1)
    || String(left?.name_en || "").localeCompare(String(right?.name_en || ""))
    || String(left?.alt_name || "").localeCompare(String(right?.alt_name || ""))
  ));
}

export function candidateTypeGroupKey(candidate) {
  const type = String(candidate?.type || "");
  if (type !== "melee" && type !== "glove") return "";
  const def = Number(candidate?.def_index);
  if (Number.isFinite(def)) return `${type}:${def}`;
  const model = String(candidate?.model || "").trim();
  return model ? `${type}:model:${model}` : "";
}

export function listCandidateTypeGroups(candidates, locale = "zh") {
  const groups = new Map();
  for (const candidate of Array.isArray(candidates) ? candidates : []) {
    const key = candidateTypeGroupKey(candidate);
    if (!key) continue;
    const defIndex = Number(candidate?.def_index);
    const label = craftNameParts(candidate, locale).model.replace(/^★\s*/, "")
      || String(candidate?.model || "").trim()
      || key;
    const current = groups.get(key);
    if (current) {
      current.count += 1;
      continue;
    }
    groups.set(key, {
      key,
      label,
      count: 1,
      def_index: Number.isFinite(defIndex) ? defIndex : null,
      model: String(candidate?.model || ""),
    });
  }
  return [...groups.values()].sort((left, right) => (
    (left.def_index ?? Number.MAX_SAFE_INTEGER) - (right.def_index ?? Number.MAX_SAFE_INTEGER)
    || left.label.localeCompare(right.label)
  ));
}

export function filterCandidates(candidates, query, locale = "zh", typeGroupKey = "") {
  const rows = (Array.isArray(candidates) ? candidates : []).filter((row) => (
    !typeGroupKey || candidateTypeGroupKey(row) === typeGroupKey
  ));
  const q = String(query || "").trim().toLowerCase();
  if (!q) return rows;
  const zh = String(locale || "").toLowerCase().startsWith("zh");
  return rows.filter((row) => {
    const name = zh
      ? String(row?.name_zh || row?.name_en || "")
      : String(row?.name_en || row?.name_zh || "");
    const alt = String(row?.alt_name || "");
    const model = String(row?.model || "");
    return name.toLowerCase().includes(q)
      || alt.toLowerCase().includes(q)
      || model.toLowerCase().includes(q);
  });
}

/** Match @ianlucas/cs2-lib EconomyItem.getImage(wear): CDN light/medium/heavy variants.
 *  Default/base items only ship a single webp — never append wear suffixes for them. */
export function imageUrlForWear(imageUrl, wear, item = null) {
  const url = String(imageUrl || "").trim();
  if (!url) return "";
  const base = url.replace(/_(light|medium|heavy)\.webp/i, ".webp");
  // Vanilla/default art has no wear variants on the CDN.
  if (item && (item.is_placeholder || item.is_base || !(Number(item.paint_index) > 0))) {
    return base.includes(".webp") ? base : url;
  }
  const wearNum = Number(wear);
  if (!Number.isFinite(wearNum)) return url;
  if (!base.includes(".webp")) return url;
  if (wearNum < 1 / 3) return base.replace(".webp", "_light.webp");
  if (wearNum < 2 / 3) return base.replace(".webp", "_medium.webp");
  return base.replace(".webp", "_heavy.webp");
}

export function splitSkinName(fullName) {
  const parts = String(fullName || "").split("|").map((part) => part.trim()).filter(Boolean);
  if (parts.length <= 1) return { model: parts[0] || "", finish: "" };
  return { model: parts[0], finish: parts.slice(1).join(" | ") };
}

/** Craft-style: ★ before knife model; finish name separate for red styling. */
export function craftNameParts(item, locale) {
  const chinese = String(item?.name_zh || "").trim();
  const english = String(item?.name_en || "").trim();
  const full = String(locale || "").toLowerCase().startsWith("zh")
    ? chinese || english
    : english || chinese;
  const { model, finish } = splitSkinName(full);
  const isMelee = String(item?.type || "") === "melee";
  const modelClean = model.replace(/^★\s*/, "");
  return {
    model: modelClean ? `${isMelee ? "★ " : ""}${modelClean}` : "",
    finish,
    alt: String(item?.alt_name || "").trim(),
    full,
  };
}

/** Single-line label: 物品 | 皮肤 | 相位(Ruby/Emerald/…) — wraps when too narrow. */
export function formatCraftPipeName(item, locale) {
  const parts = craftNameParts(item, locale);
  const segments = [];
  if (parts.model) segments.push(parts.model);
  if (parts.finish) segments.push(parts.finish);
  if (parts.alt) segments.push(parts.alt);
  if (!parts.model && !parts.finish && !parts.alt && parts.full) segments.push(parts.full);
  return segments.join(" | ");
}

const LOADOUT_TYPES = new Set(["weapon", "melee", "glove"]);

/** Default free/base weapons for a team row (CT or T), with CDN images. */
export function listDefaultLoadout(team) {
  const teamKey = String(team || "").toLowerCase() === "ct" ? "ct" : "t";
  const teamCode = teamKey === "ct" ? 1 : 0;
  return CS2_COSMETICS_ITEMS
    .filter((item) => {
      if (!item.free || !item.base) return false;
      if (!LOADOUT_TYPES.has(String(item.type || ""))) return false;
      if (item.category === "c4" || item.category === "equipment") return false;
      if (Number(item.teams) === 2) return true;
      return Number(item.teams) === teamCode;
    })
    .map((raw) => ({
      ...toCandidate(raw),
      paint_index: 0,
      is_placeholder: true,
      observed_teams: [teamKey],
      catalog_exact: true,
      finish_known: true,
      ownership_evidence: "default_loadout",
    }));
}
