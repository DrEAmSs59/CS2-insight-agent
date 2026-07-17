import API from "../api/api.js";

/**
 * 启动 CS2 播放 Demo。优先库内 id，否则按 path。
 * @param {{ id?: number | string | null, path?: string | null }} opts
 */
export async function playDemoInCs2({ id = null, path = null } = {}) {
  const demoId = id != null && String(id).trim() !== "" ? Number(id) : null;
  if (demoId != null && Number.isFinite(demoId) && demoId > 0) {
    await API.post(`/demos/${demoId}/play`);
    return;
  }
  const p = typeof path === "string" ? path.trim() : "";
  if (!p) {
    throw new Error("缺少可播放的 Demo（无 id / path）");
  }
  await API.post("/demo/play", { path: p });
}

export function playDemoErrorLabel(error) {
  const detail = error?.response?.data?.detail;
  if (typeof detail === "string" && detail.trim()) return detail.trim();
  if (Array.isArray(detail)) {
    return detail
      .map((x) => (typeof x === "object" && x?.msg ? x.msg : String(x)))
      .join("；");
  }
  return error?.message || String(error || "unknown error");
}
