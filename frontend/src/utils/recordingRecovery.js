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
