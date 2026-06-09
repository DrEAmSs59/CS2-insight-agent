/**
 * 提取 FastAPI / axios 报错文案（含 422 校验数组）。
 * @param {unknown} e - axios error or similar
 * @param {string} [fallback] - fallback string shown when no detail is available;
 *   callers should pass t("common.requestFail") so the fallback is localised.
 *   Defaults to e.message if available, otherwise an empty string.
 */
export function formatRecordingApiError(e, fallback) {
  const data = e?.response?.data;
  const d = data?.detail;
  if (typeof d === "string") return d;
  if (Array.isArray(d)) {
    return d
      .map((item) => {
        if (item && typeof item === "object" && item.msg != null) return String(item.msg);
        try {
          return JSON.stringify(item);
        } catch {
          return String(item);
        }
      })
      .join(" ");
  }
  if (d != null && typeof d === "object") {
    if (typeof d.message === "string") return d.message;
    try {
      return JSON.stringify(d);
    } catch {
      /* fallthrough */
    }
  }
  return e?.message || fallback || "";
}
