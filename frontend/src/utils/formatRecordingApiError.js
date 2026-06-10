import { messageFromApiCode, parseApiDetail } from "./apiErrorMessages.js";

/**
 * 提取 FastAPI / axios 报错文案（含 422 校验数组与 detail.code i18n 映射）。
 * @param {unknown} e - axios error or similar
 * @param {(key: string, params?: object) => string} t - i18n translate function
 * @param {string} [fallback] - when no detail is available
 */
export function formatRecordingApiError(e, t, fallback) {
  const data = e?.response?.data;
  const d = data?.detail;
  const { code, params } = parseApiDetail(d);
  const fromCode = messageFromApiCode(code, t, params);
  if (fromCode) return fromCode;

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

/**
 * @param {unknown} e
 * @param {(key: string, params?: object) => string} t
 * @param {string} [fallback]
 * @returns {{ text: string, code: string | null }}
 */
export function parseRecordingApiError(e, t, fallback) {
  const data = e?.response?.data;
  const { code } = parseApiDetail(data?.detail);
  return {
    text: formatRecordingApiError(e, t, fallback),
    code,
  };
}
