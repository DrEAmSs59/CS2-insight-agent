import { describe, expect, it } from "vitest";

import {
  isUnexpectedCs2ExitResult,
  isRecordingAbortResult,
  recordingAbortToastKind,
  recordingQueueHadUnexpectedCs2Exit,
  recordingQueueWasAborted,
  unexpectedCs2ExitRecoveryMessageKey,
} from "./recordingAbort";

describe("recording abort outcome", () => {
  it("recognizes request- and segment-level abort results", () => {
    expect(isRecordingAbortResult({ success: false, error: "aborted" })).toBe(true);
    expect(isRecordingAbortResult({
      success: false,
      segment_results: [{ status: "skipped", error: "aborted" }],
    })).toBe(true);
    expect(recordingQueueWasAborted([{ success: true }], true)).toBe(true);
    expect(recordingQueueWasAborted([{ success: false, error: "failed" }], false)).toBe(false);
  });

  it("keeps restore warnings distinct from a completed cleanup", () => {
    expect(recordingAbortToastKind({ restore_required: true })).toBe("restore_pending");
    expect(recordingAbortToastKind({ fetch_failed: true })).toBe("unverified");
    expect(recordingAbortToastKind({ restore_required: false })).toBe("completed");
    expect(recordingAbortToastKind(
      { restore_required: false },
      [{ recovery: { player_config_restore_state: "unverified" } }],
    )).toBe("unverified");
    expect(recordingAbortToastKind(
      { restore_required: false },
      [{ recovery: { player_config_restore_state: "not_needed" } }],
    )).toBe("not_needed");
  });

  it("recognizes a managed CS2 process that exited outside Insight cleanup", () => {
    expect(isUnexpectedCs2ExitResult({ error_code: "RECORDING_CS2_EXITED" })).toBe(true);
    expect(isUnexpectedCs2ExitResult({ error: "cs2_exited_unexpectedly" })).toBe(true);
    expect(recordingQueueHadUnexpectedCs2Exit([{ success: true }, {
      success: false,
      error_code: "RECORDING_CS2_EXITED",
    }])).toBe(true);
    expect(recordingQueueHadUnexpectedCs2Exit([{ success: false, error: "failed" }])).toBe(false);
  });

  it("selects recovery copy for config and optional POV state", () => {
    expect(unexpectedCs2ExitRecoveryMessageKey()).toBe("app.unexpectedCs2ExitRecovered");
    expect(unexpectedCs2ExitRecoveryMessageKey({ povEnabled: true })).toBe(
      "app.unexpectedCs2ExitRecoveredWithPov",
    );
    expect(unexpectedCs2ExitRecoveryMessageKey({ configRecoveryNeeded: true })).toBe(
      "app.unexpectedCs2ExitConfigPending",
    );
    expect(unexpectedCs2ExitRecoveryMessageKey({ povEnabled: true, povRecoveryNeeded: true })).toBe(
      "app.unexpectedCs2ExitPovPending",
    );
    expect(unexpectedCs2ExitRecoveryMessageKey({
      configRecoveryNeeded: true,
      povEnabled: true,
      povRecoveryNeeded: true,
    })).toBe("app.unexpectedCs2ExitBothPending");
  });
});
