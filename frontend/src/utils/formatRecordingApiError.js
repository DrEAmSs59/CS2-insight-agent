/** 提取 FastAPI / axios 报错文案（含 422 校验数组）。 */
export function formatRecordingApiError(e) {
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
  return String(e?.message || "请求失败");
}
