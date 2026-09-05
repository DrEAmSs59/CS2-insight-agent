export const WORKSHOP_SCHEME_STORAGE_KEY = "cs2-insight:cosmetics-workshop-plan:v1";

function storage() {
  return typeof localStorage === "undefined" ? null : localStorage;
}

export function readWorkshopSchemes() {
  try {
    const parsed = JSON.parse(storage()?.getItem(WORKSHOP_SCHEME_STORAGE_KEY) || "null");
    if (!Array.isArray(parsed)) return [];
    return parsed.filter((plan) => plan && typeof plan === "object").map((plan) => ({
      ...plan,
      selections: {
        ct: plan.selections?.ct && typeof plan.selections.ct === "object" ? plan.selections.ct : {},
        t: plan.selections?.t && typeof plan.selections.t === "object" ? plan.selections.t : {},
      },
    }));
  } catch {
    return [];
  }
}

export function readWorkshopScheme() {
  return readWorkshopSchemes()[0] || null;
}

export function writeWorkshopScheme(plan) {
  try {
    if (!plan || typeof plan !== "object") return false;
    storage()?.setItem(WORKSHOP_SCHEME_STORAGE_KEY, JSON.stringify([plan]));
    return Boolean(storage());
  } catch {
    return false;
  }
}

export function workshopSchemeSelectionCount(plan) {
  return ["ct", "t"].reduce((total, team) => (
    total + Object.values(plan?.selections?.[team] || {}).filter(Boolean).length
  ), 0);
}

export function workshopSchemeSelectionForItem(plan, team, item) {
  const selections = plan?.selections?.[String(team || "").toLowerCase()];
  if (!selections || typeof selections !== "object") return null;
  const type = String(item?.type || "");
  if (type === "melee" || type === "glove") return selections[type] || null;
  if (type !== "weapon") return null;
  const model = String(item?.model || "").toLowerCase();
  const direct = selections[`weapon:${model}`];
  if (direct) return direct;
  const defIndex = Number(item?.def_index);
  return Object.values(selections).find((candidate) => (
    candidate
      && String(candidate.type || "") === "weapon"
      && Number(candidate.def_index) === defIndex
  )) || null;
}
