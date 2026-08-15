/*---------------------------------------------------------------------------------------------
 *  Copyright (c) unicbm. All rights reserved.
 *  Licensed under the PolyForm Noncommercial License 1.0.0. See LICENSE in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { CS2_ITEM_CATALOG } from "../generated/cs2ItemCatalog.js";

const canonicalModels = new Set(
  Object.values(CS2_ITEM_CATALOG.bases).map((item) => item.model).filter(Boolean),
);
const aliasesLongestFirst = Object.entries({
  ...CS2_ITEM_CATALOG.aliases,
  ...Object.fromEntries([...canonicalModels].map((model) => [model, model])),
})
  .sort(([left], [right]) => right.length - left.length || left.localeCompare(right));
const baseByModel = Object.fromEntries(
  Object.values(CS2_ITEM_CATALOG.bases).map((item) => [item.model, item]),
);

export function normalizeCs2WeaponAlias(value) {
  return String(value || "")
    .trim()
    .toLowerCase()
    .replace(/^weapon_/, "")
    .replace(/[\s-]+/g, "_")
    .replace(/[^\p{L}\p{N}_]+/gu, "_")
    .replace(/_+/g, "_")
    .replace(/^_|_$/g, "");
}

export function resolveCs2WeaponModel(...values) {
  const aliases = values.map(normalizeCs2WeaponAlias).filter(Boolean);
  for (const alias of aliases) {
    if (canonicalModels.has(alias)) return alias;
    const direct = CS2_ITEM_CATALOG.aliases[alias];
    if (direct) return direct;
    const compact = alias.replaceAll("_", "");
    const paddedAlias = `_${alias}_`;
    for (const [candidate, model] of aliasesLongestFirst) {
      const candidateCompact = candidate.replaceAll("_", "");
      if (
        paddedAlias.includes(`_${candidate}_`)
        || (candidateCompact && compact === candidateCompact)
      ) return model;
    }
  }
  return "";
}

export function cs2BaseItemForModel(model) {
  return baseByModel[String(model || "")] || null;
}

export function cs2SkinDisplayName(skin, locale = "zh") {
  if (!skin || typeof skin !== "object") return "";
  const name = locale === "en" ? skin.name_en : skin.name_zh;
  const base = String(name || skin.name_en || skin.model || "").trim();
  const alt = String(skin.alt_name || "").trim();
  return alt && !base.toLowerCase().includes(alt.toLowerCase()) ? `${base} · ${alt}` : base;
}
