import API from "../../api/api.js";

const GENERIC_SKIN_SAVE_ERROR = "COSMETICS_SKIN_REWRITE_FAILED";

function publicErrorCodeFromAxios(error) {
  const detail = error?.response?.data?.detail;
  if (detail && typeof detail === "object" && !Array.isArray(detail)) {
    const code = String(detail.code || "").trim();
    if (code === "COSMETICS_SKIN_CORE_UNAVAILABLE" || code === GENERIC_SKIN_SAVE_ERROR) {
      return code;
    }
  }
  // Never surface backend/native exception text, including from an older server.
  return GENERIC_SKIN_SAVE_ERROR;
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
      error_code: publicErrorCodeFromAxios(error),
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
