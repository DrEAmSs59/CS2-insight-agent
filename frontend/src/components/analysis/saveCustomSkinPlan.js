import API from "../../api/api.js";

function detailFromAxios(error) {
  const detail = error?.response?.data?.detail;
  if (typeof detail === "string" && detail.trim()) return detail.trim();
  if (Array.isArray(detail)) {
    const parts = detail.map((row) => (typeof row === "string" ? row : row?.msg)).filter(Boolean);
    if (parts.length) return parts.join("; ");
  }
  if (error?.message) return String(error.message);
  return "Request failed";
}

/** Persist custom skin plan and rewrite the demo working cache. */
export async function saveCustomSkinPlan({ demoId, steamid, replacements, originals }) {
  try {
    const payload = { steamid, replacements };
    if (originals && typeof originals === "object") {
      payload.originals = originals;
    }
    const { data } = await API.post(`/demos/${demoId}/cosmetics/custom-plan`, payload);
    return data;
  } catch (error) {
    return {
      ok: false,
      partial: false,
      plan: null,
      succeeded: [],
      failed: [],
      error: detailFromAxios(error),
    };
  }
}

/** Load persisted custom skin plan for one demo + player (or null plan). */
export async function loadCustomSkinPlan({ demoId, steamid }) {
  const { data } = await API.get(`/demos/${demoId}/cosmetics/custom-plan`, {
    params: { steamid },
  });
  return data;
}
