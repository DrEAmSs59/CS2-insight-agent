import { CS2_ITEMS } from "@ianlucas/cs2-lib";
import { english } from "@ianlucas/cs2-lib/translations/english";
import { schinese } from "@ianlucas/cs2-lib/translations/schinese";

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

function translated(language, id, field = "name") {
  return String(language?.[id]?.[field] || "").trim();
}

function toCandidate(raw) {
  const image = String(raw.image || "");
  return {
    catalog_id: Number(raw.id),
    def_index: Number(raw.def),
    paint_index: Number(raw.index || 0),
    model: String(raw.model || ""),
    type: String(raw.type || ""),
    name_en: translated(english, raw.id) || String(raw.model || ""),
    name_zh: translated(schinese, raw.id) || translated(english, raw.id) || String(raw.model || ""),
    image_url: image ? (image.startsWith("http") ? image : `${IMAGE_BASE}${image}`) : "",
    rarity: String(raw.rarity || "#ded6cc"),
    wear_min: Number.isFinite(Number(raw.wearMin)) ? Number(raw.wearMin) : undefined,
    wear_max: Number.isFinite(Number(raw.wearMax)) ? Number(raw.wearMax) : undefined,
  };
}

export function listSkinCandidates(sourceItem) {
  const type = String(sourceItem?.type || "");
  const def = Number(sourceItem?.def_index);
  const rows = CS2_ITEMS.filter((item) => {
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
  ));
}

export function filterCandidates(candidates, query, locale = "zh") {
  const q = String(query || "").trim().toLowerCase();
  if (!q) return Array.isArray(candidates) ? candidates : [];
  const zh = String(locale || "").toLowerCase().startsWith("zh");
  return (Array.isArray(candidates) ? candidates : []).filter((row) => {
    const name = zh
      ? String(row?.name_zh || row?.name_en || "")
      : String(row?.name_en || row?.name_zh || "");
    return name.toLowerCase().includes(q);
  });
}
