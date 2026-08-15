import { describe, expect, test } from "vitest";
import {
  buildPendingDemoAnalysisSpecs,
  DEMO_ANALYSIS_WORKSPACE_ALGORITHM_VERSION,
  hasCompleteCachedDemoAnalysis,
} from "./analysisCache";

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
        algorithm_version: DEMO_ANALYSIS_WORKSPACE_ALGORITHM_VERSION,
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

  test("rebuilds a cached workspace produced by an older replay algorithm", () => {
    const stale = demo();
    stale.cached_result.analysis_workspace.algorithm_version = "match-workspace-2026.07.3";

    expect(hasCompleteCachedDemoAnalysis(stale)).toBe(false);
    expect(buildPendingDemoAnalysisSpecs([stale])).toHaveLength(1);
  });
});
