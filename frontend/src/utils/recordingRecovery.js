export function recordingVpkRecoverySummary(results) {
  const reports = (Array.isArray(results) ? results : [])
    .map((item) => item?.recovery)
    .filter((report) => report?.recording_vpk_enabled || report?.pov_enabled);
  if (!reports.length) return { enabled: false, state: "not_needed", detail: null };
  const summaries = reports.map((report) => {
    const generic = report.recording_vpk_enabled === true;
    const verified = generic ? report.recording_vpk_restore_verified : report.pov_restore_verified;
    const restored = generic ? report.recording_vpk_restored : report.pov_restored;
    return {
      enabled: true,
      state: verified === true ? (restored === true ? "restored" : "failed") : "unverified",
      detail: report.recording_vpk_restore || report.pov_restore || null,
    };
  });
  return summaries.find((item) => item.state === "failed")
    || summaries.find((item) => item.state === "unverified")
    || summaries[0];
}

export function recordingRecoverySummary(results) {
  const items = Array.isArray(results) ? results : [];
  const recovery = items
    .map((item) => item?.recovery)
    .find((value) => value && typeof value === "object");

  if (!recovery) {
    return {
      state: "unverified",
      checkedFiles: 0,
      restoredFiles: 0,
      failureCount: 0,
    };
  }

  let state = String(recovery.player_config_restore_state || "").trim().toLowerCase();
  if (!["restored", "failed", "unverified", "not_needed"].includes(state)) {
    if (
      recovery.player_config_restore_verified === true &&
      recovery.player_config_restored === true
    ) {
      state = "restored";
    } else if (
      recovery.player_config_restore_verified === true &&
      recovery.player_config_restored === false
    ) {
      state = "failed";
    } else {
      state = "unverified";
    }
  }

  return {
    state,
    checkedFiles: Math.max(0, Number(recovery.player_config_checked_files) || 0),
    restoredFiles: Math.max(0, Number(recovery.player_config_restored_files) || 0),
    failureCount: Array.isArray(recovery.player_config_restore_failures)
      ? recovery.player_config_restore_failures.length
      : 0,
  };
}
