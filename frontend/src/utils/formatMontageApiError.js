import { messageFromApiCode } from "./apiErrorMessages.js";
import { formatRecordingApiError } from "./formatRecordingApiError.js";
import { montageDetailFromLegacy } from "./montageLegacyErrors.js";

/**
 * 合辑工作台 API / 历史记录错误文案（优先 code → i18n，兜底归类旧版技术原文）。
 */
export function formatMontageApiError(e, t, fallback) {
  return formatRecordingApiError(e, t, fallback);
}

/** @param {string} raw - error_msg 或旧版完整报错 */
export function humanizeMontageError(raw, t) {
  const s = String(raw || "").trim();
  if (!s) return t("montage.exportErrorGeneric");
  const fromCode = messageFromApiCode(s, t);
  if (fromCode) return fromCode;
  const legacy = montageDetailFromLegacy(s);
  if (legacy?.code) {
    const msg = messageFromApiCode(legacy.code, t, legacy.params);
    if (msg) return msg;
  }
  if (_looksTechnical(s)) return t("montage.exportErrorGeneric");
  return s;
}

function _looksTechnical(s) {
  return (
    /exit\s+\d+/i.test(s) ||
    /ffmpeg|ffprobe|xfade|filter_complex|Invalid data/i.test(s) ||
    /归一化|stderr|codec|0x[0-9a-f]{6,}/i.test(s) ||
    s.length > 180
  );
}
