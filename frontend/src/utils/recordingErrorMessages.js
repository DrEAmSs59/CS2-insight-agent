function firstSegmentFailure(result) {
  const segments = Array.isArray(result?.segment_results)
    ? result.segment_results
    : Array.isArray(result?.segments)
      ? result.segments
      : [];
  return segments.find((segment) => segment?.status !== "ok") || null;
}

/**
 * Convert internal recording errors into localized, user-facing messages.
 * Raw executor errors remain available in backend logs, but should not leak
 * into the result modal.
 */
export function recordingErrorMessage(result, t) {
  const code = String(result?.error_code || "").trim().toUpperCase();
  const raw = String(result?.error || "").trim();
  const normalized = raw.toLowerCase();
  const segment = firstSegmentFailure(result);
  const segmentStatus = String(segment?.status || "").trim().toLowerCase();
  const segmentError = String(segment?.error || "").trim().toLowerCase();
  const combined = `${normalized} ${segmentError}`;

  if (code === "RECORDING_CS2_EXITED" || normalized === "cs2_exited_unexpectedly") {
    return t("queue.errorCs2Exited");
  }
  if (
    combined.includes("voice isolation") ||
    combined.includes("voice mask injection") ||
    segmentStatus === "voice_filter_failed"
  ) {
    return t("queue.errorVoiceFilter");
  }
  if (combined.includes("obs connection") || combined.includes("obs websocket")) {
    return t("queue.errorObsConnection");
  }
  if (combined.includes("obs") || combined.includes("startrecord") || combined.includes("stoprecord")) {
    return t("queue.errorObsControl");
  }
  if (
    combined.includes("spec verify") ||
    combined.includes("wrong player spectated") ||
    segmentStatus === "spec_failed"
  ) {
    return t("queue.errorPerspective");
  }
  if (
    combined.includes("gototick") ||
    combined.includes("seek") ||
    segmentStatus === "seek_failed"
  ) {
    return t("queue.errorDemoSeek");
  }
  if (
    combined.includes("demo_resume_silent") ||
    combined.includes("kp_6") ||
    segmentStatus === "silent_resume_failed"
  ) {
    return t("queue.errorDemoControl");
  }
  return t("queue.errorUnknown");
}
