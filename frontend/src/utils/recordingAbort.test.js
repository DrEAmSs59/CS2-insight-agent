import { describe, expect, it } from "vitest";

import {
  isRecordingAbortResult,
  recordingAbortToastKind,
  recordingQueueWasAborted,
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
  });
});
