export function isRecordingAbortResult(result) {
  if (!result || typeof result !== "object") return false;
  if (String(result.error || "").trim().toLowerCase() === "aborted") return true;
  return (Array.isArray(result.segment_results) ? result.segment_results : []).some(
    (segment) => String(segment?.error || "").trim().toLowerCase() === "aborted",
  );
}

export function recordingQueueWasAborted(results, abortRequested = false) {
  return Boolean(abortRequested) || (Array.isArray(results) && results.some(isRecordingAbortResult));
}

export function recordingAbortToastKind(configBackupStatus) {
  if (configBackupStatus?.restore_required === true) return "restore_pending";
  if (configBackupStatus?.fetch_failed === true) return "unverified";
  return "completed";
}
