import { describe, expect, test } from "vitest";
import {
  buildPendingDemoAnalysisSpecs,
  hasCompleteCachedDemoAnalysis,
} from "./demoAnalysisCache";

function demo(overrides = {}) {
  return {
    id: 7,
    players: [{ name: "Alpha" }, { name: "Bravo" }],
    cached_result: {
      players: {
        alpha: { clips: [] },
        BRAVO: { clips: [] },
      },
      analysis_workspace: {
        version: 1,
        rounds: [{ round_number: 1 }],
      },
    },
    ...overrides,
  };
}

describe("demo analysis cache coverage", () => {
  test("reuses a complete persisted multi-player workspace", () => {
    const cached = demo();
    expect(hasCompleteCachedDemoAnalysis(cached)).toBe(true);
    expect(buildPendingDemoAnalysisSpecs([cached])).toEqual([]);
  });

  test("rebuilds the whole demo when one roster player is missing", () => {
    const incomplete = demo({
      cached_result: {
        players: { Alpha: { clips: [] } },
        analysis_workspace: { version: 1, rounds: [{ round_number: 1 }] },
      },
    });
    expect(hasCompleteCachedDemoAnalysis(incomplete)).toBe(false);
    expect(buildPendingDemoAnalysisSpecs([incomplete])).toEqual([{
      index: 0,
      players: ["Alpha", "Bravo"],
    }]);
  });

  test("does not treat legacy results without a workspace as complete", () => {
    const legacy = demo({
      cached_result: {
        players: { Alpha: { clips: [] }, Bravo: { clips: [] } },
        analysis_workspace: null,
      },
    });
    expect(hasCompleteCachedDemoAnalysis(legacy)).toBe(false);
    expect(buildPendingDemoAnalysisSpecs([legacy])).toHaveLength(1);
  });
});
