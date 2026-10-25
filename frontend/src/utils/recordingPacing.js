export const MAX_EVENT_PREROLL_SECONDS = 10;

/** Preserve other pacing fields and cap padding saved by older clients. */
export function limitRecordingPacing(pacing) {
  if (!pacing || typeof pacing !== "object" || Array.isArray(pacing)) return {};
  const result = { ...pacing };
  if (typeof result.pre_first_sec === "number" && Number.isFinite(result.pre_first_sec)) {
    result.pre_first_sec = Math.min(result.pre_first_sec, MAX_EVENT_PREROLL_SECONDS);
  }
  return result;
}
