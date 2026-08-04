/** Map backend FFmpeg toolkit gate reasons to shared workbench UI copy. */
export function ffmpegGateSubtitle(reason, t) {
  if (reason === "not_configured") return t("montage.ffmpegGateNotConfigured");
  if (reason === "path_not_found") return t("montage.ffmpegGatePathNotFound");
  if (reason === "ffprobe_missing") return t("montage.ffmpegGateFfprobeMissing");
  if (reason === "version_mismatch") return t("montage.ffmpegGateVersionMismatch");
  if (reason === "incompatible") return t("montage.ffmpegGateIncompatible");
  if (reason === "not_usable" || reason === "not_runnable") return t("montage.ffmpegGateNotUsable");
  return t("montage.ffmpegGateNotReady");
}
