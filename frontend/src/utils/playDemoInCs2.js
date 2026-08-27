import API from "../api/api.js";
import { messageFromApiCode, parseApiDetail } from "./apiErrorMessages.js";
import { normalizeRecordingSkyboxId } from "./recordingSkybox.js";

export async function getDemoPlaybackPreflight() {
  const { data } = await API.get("/demo/playback/preflight");
  return data || {};
}

export async function getDemoPlaybackStatus(sessionId) {
  const { data } = await API.get("/demo/playback/status", { params: { session_id: String(sessionId || "") } });
  return data || {};
}

/**
 * 启动 CS2 播放 Demo。优先库内 id，否则按 path。
 * @param {{ id?: number | string | null, path?: string | null }} opts
 */
export async function playDemoInCs2({ id = null, path = null, advancedPlayback = null, povHud = null } = {}) {
  const playback = advancedPlayback || povHud;
  const body = {
    pov_hud: {
      enabled: !!playback?.enabled,
      radar_mode: Number(playback?.radar_mode) === -1 ? -1 : 0,
      teamcounter_numeric: !!playback?.teamcounter_numeric,
      skybox_id: normalizeRecordingSkyboxId(playback?.skybox_id),
    },
  };
  const demoId = id != null && String(id).trim() !== "" ? Number(id) : null;
  if (demoId != null && Number.isFinite(demoId) && demoId > 0) {
    const { data } = await API.post(`/demos/${demoId}/play`, body);
    return data || {};
  }
  const p = typeof path === "string" ? path.trim() : "";
  if (!p) {
    throw new Error("缺少可播放的 Demo（无 id / path）");
  }
  const { data } = await API.post("/demo/play", { path: p, ...body });
  return data || {};
}

export function playDemoErrorLabel(error, t = null) {
  const detail = error?.response?.data?.detail;
  const { code, params } = parseApiDetail(detail);
  const translated = typeof t === "function" ? messageFromApiCode(code, t, params) : null;
  if (translated) return translated;
  if (typeof detail === "string" && detail.trim()) return detail.trim();
  if (Array.isArray(detail)) {
    return detail
      .map((x) => (typeof x === "object" && x?.msg ? x.msg : String(x)))
      .join("；");
  }
  return error?.message || String(error || "unknown error");
}
