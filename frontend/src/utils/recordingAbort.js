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

export function recordingAbortToastKind(configBackupStatus, results = []) {
  const recovery = (Array.isArray(results) ? results : [])
    .map((item) => item?.recovery)
    .find((value) => value && typeof value === "object");
  const state = String(recovery?.player_config_restore_state || "").toLowerCase();
  if (state === "restored") return "completed";
  if (state === "not_needed") return "not_needed";
  if (state === "failed") return "restore_pending";
  if (state === "unverified") return "unverified";
  if (configBackupStatus?.restore_required === true) return "restore_pending";
  if (configBackupStatus?.fetch_failed === true) return "unverified";
  return "completed";
}

export function isUnexpectedCs2ExitResult(result) {
  if (!result || typeof result !== "object") return false;
  if (result.error_code === "RECORDING_CS2_EXITED") return true;
  return String(result.error || "").trim().toLowerCase() === "cs2_exited_unexpectedly";
}

export function recordingQueueHadUnexpectedCs2Exit(results) {
  return Array.isArray(results) && results.some(isUnexpectedCs2ExitResult);
}

export function unexpectedCs2ExitRecoveryMessageKey({
  configRecoveryNeeded = false,
  povEnabled = false,
  povRecoveryNeeded = false,
  povRecoveryMode = "",
} = {}) {
  if (configRecoveryNeeded && povEnabled && povRecoveryNeeded) {
    return "app.unexpectedCs2ExitBothPending";
  }
  if (configRecoveryNeeded) return "app.unexpectedCs2ExitConfigPending";
  if (povEnabled && povRecoveryNeeded) return "app.unexpectedCs2ExitPovPending";
  if (povEnabled && String(povRecoveryMode).toLowerCase() === "semantic") {
    return "app.unexpectedCs2ExitRecoveredWithPovCleanup";
  }
  if (povEnabled && String(povRecoveryMode).toLowerCase() === "strict") {
    return "app.unexpectedCs2ExitRecoveredWithPovStrict";
  }
  if (povEnabled && String(povRecoveryMode).toLowerCase() === "none") {
    return "app.unexpectedCs2ExitRecoveredWithPovNoChange";
  }
  if (povEnabled) return "app.unexpectedCs2ExitRecoveredWithPov";
  return "app.unexpectedCs2ExitRecovered";
}
