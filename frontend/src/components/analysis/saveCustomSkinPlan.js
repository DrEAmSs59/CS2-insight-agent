import API from "../../api/api.js";

/** Persist custom skin plan and rewrite the demo working cache. */
export async function saveCustomSkinPlan({ demoId, steamid, replacements }) {
  const { data } = await API.post(`/demos/${demoId}/cosmetics/custom-plan`, {
    steamid,
    replacements,
  });
  return data;
}

/** Load persisted custom skin plan for one demo + player (or null plan). */
export async function loadCustomSkinPlan({ demoId, steamid }) {
  const { data } = await API.get(`/demos/${demoId}/cosmetics/custom-plan`, {
    params: { steamid },
  });
  return data;
}
