import { describe, expect, it } from "vitest";
import { recordingRecoverySummary } from "./recordingRecovery";

describe("recordingRecoverySummary", () => {
  it("reports a byte-verified restore", () => {
    expect(recordingRecoverySummary([{
      recovery: {
        player_config_restore_state: "restored",
        player_config_checked_files: 12,
        player_config_restored_files: 3,
        player_config_restore_failures: [],
      },
    }])).toEqual({
      state: "restored",
      checkedFiles: 12,
      restoredFiles: 3,
      failureCount: 0,
    });
  });

  it("does not turn a missing recovery report into success", () => {
    expect(recordingRecoverySummary([{ success: true }]).state).toBe("unverified");
  });

  it("reports real verification failures", () => {
    expect(recordingRecoverySummary([{
      recovery: {
        player_config_restore_state: "failed",
        player_config_restore_failures: [{ original: "config.cfg" }],
      },
    }])).toMatchObject({ state: "failed", failureCount: 1 });
  });
});
