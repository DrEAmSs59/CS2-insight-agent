import API from "../api/api.js";
import { messageFromApiCode, parseApiDetail } from "./apiErrorMessages.js";

export async function getDemoPlaybackPreflight() {
  const { data } = await API.get("/demo/playback/preflight");
  return data || {};
}

/**
 * 启动 CS2 播放 Demo。优先库内 id，否则按 path。
 * @param {{ id?: number | string | null, path?: string | null }} opts
 */
export async function playDemoInCs2({ id = null, path = null, povHud = null } = {}) {
  const body = {
    pov_hud: {
      enabled: !!povHud?.enabled,
      radar_mode: Number(povHud?.radar_mode) === -1 ? -1 : 0,
      teamcounter_numeric: !!povHud?.teamcounter_numeric,
    },
  };
  const demoId = id != null && String(id).trim() !== "" ? Number(id) : null;
  if (demoId != null && Number.isFinite(demoId) && demoId > 0) {
    await API.post(`/demos/${demoId}/play`, body);
    return;
  }
  const p = typeof path === "string" ? path.trim() : "";
  if (!p) {
    throw new Error("缺少可播放的 Demo（无 id / path）");
  }
  await API.post("/demo/play", { path: p, ...body });
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
