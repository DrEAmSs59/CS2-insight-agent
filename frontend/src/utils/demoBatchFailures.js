import { messageFromApiCode } from "./apiErrorMessages.js";

export const DEMO_ANALYSIS_REQUEST_TIMEOUT_MS = 255_000;

export function demoBatchFailureMessage(value, t) {
  const code =
    value?.code === "ECONNABORTED"
      ? "DEMO_ANALYSIS_TIMEOUT"
      : value?.code
        || value?.inspection_error?.code
        || value?.response?.data?.detail?.code;
  return messageFromApiCode(code, t) || t("api.err.demoAnalysisFailed");
}

export function normalizeDemoBatchFailures(items, t, idPrefix = "demo-failure") {
  return (Array.isArray(items) ? items : []).map((item, index) => ({
    id: item?.id ?? `${idPrefix}-${index}`,
    filename: String(item?.filename || "Demo"),
    reason: demoBatchFailureMessage(item, t),
  }));
}
