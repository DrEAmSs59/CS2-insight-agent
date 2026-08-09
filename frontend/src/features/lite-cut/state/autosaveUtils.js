export const LITE_CUT_AUTOSAVE_DELAY_MS = 1400;
export const LITE_CUT_AUTOSAVE_FLUSH_EVENTS = ["beforeunload", "pagehide", "visibilitychange"];

export function shouldScheduleLiteCutAutosave({ projectId, body, dirty, loading, saving }) {
  return Boolean(projectId && body && dirty && !loading && !saving);
}

export function shouldFlushLiteCutAutosave(event, state) {
  if (event?.type === "visibilitychange" && event?.target?.visibilityState !== "hidden") return false;
  return shouldScheduleLiteCutAutosave(state || {});
}
