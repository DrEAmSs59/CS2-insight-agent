import { describe, expect, test } from "vitest";
import {
  demoBatchFailureMessage,
  normalizeDemoBatchFailures,
} from "./demoBatchFailures.js";

const t = (key) => ({
  "api.err.demoAnalysisTimeout": "timeout",
  "api.err.demoInspectionFailed": "inspection failed",
  "api.err.demoAnalysisFailed": "safe fallback",
}[key] || key);

describe("Demo batch failures", () => {
  test("maps backend codes without exposing raw developer details", () => {
    const failures = normalizeDemoBatchFailures([
      {
        filename: "broken.dem",
        code: "DEMO_INSPECTION_FAILED",
        reason: "Traceback: parser internals",
      },
    ], t);

    expect(failures[0]).toMatchObject({
      filename: "broken.dem",
      reason: "inspection failed",
    });
    expect(failures[0].reason).not.toContain("Traceback");
  });

  test("turns an Axios deadline into a friendly timeout", () => {
    expect(demoBatchFailureMessage({ code: "ECONNABORTED" }, t)).toBe("timeout");
  });

  test("uses a safe fallback for unknown server errors", () => {
    expect(demoBatchFailureMessage({
      response: { data: { detail: "worker exit code 3221225477" } },
    }, t)).toBe("safe fallback");
  });
});
