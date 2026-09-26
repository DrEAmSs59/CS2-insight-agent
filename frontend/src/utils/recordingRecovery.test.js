import { describe, expect, it } from "vitest";
import { recordingRecoverySummary, recordingVpkRecoverySummary } from "./recordingRecovery";

describe("VPK recovery independent of POV", () => {
  it("reports failed auxiliary or visual VPK recovery with POV disabled", () => {
    expect(recordingVpkRecoverySummary([{ recovery: {
      pov_enabled: false, pov_restored: true,
      recording_vpk_enabled: true, recording_vpk_restore_verified: true,
      recording_vpk_restored: false, recording_vpk_restore: { error: "locked" },
    } }])).toEqual({ enabled: true, state: "failed", detail: { error: "locked" } });
  });

  it("does not hide a failed or unverified report behind a successful one", () => {
    const restored = { recovery: { recording_vpk_enabled: true, recording_vpk_restore_verified: true, recording_vpk_restored: true } };
    expect(recordingVpkRecoverySummary([restored, { recovery: { recording_vpk_enabled: true } }]).state).toBe("unverified");
    expect(recordingVpkRecoverySummary([restored, { recovery: { pov_enabled: true, pov_restore_verified: true, pov_restored: false } }]).state).toBe("failed");
    expect(recordingVpkRecoverySummary([restored]).state).toBe("restored");
    expect(recordingVpkRecoverySummary([]).enabled).toBe(false);
  });
});

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
