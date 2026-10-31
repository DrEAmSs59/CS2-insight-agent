import { describe, expect, test } from "vitest";
import {
  buildPendingDemoAnalysisSpecs,
  DEMO_ANALYSIS_WORKSPACE_ALGORITHM_VERSION,
} from "../demo-analysis/state/analysisCache.js";

import {
  buildLoadedLibraryDemo,
  prepareLibraryAnalysisHandoff,
} from "./analysisHandoff";

describe("Demo Library analysis handoff", () => {
  test("adapts cached multi-player analysis without leaking library DTO shape", () => {
    const item = {
      id: 7,
      filename: "match.dem",
      display_name: "Final",
      path: "C:/demos/match.dem",
      has_player_keyboard_input: 0,
      result: {
        analysis_workspace: {
          version: 1,
          algorithm_version: DEMO_ANALYSIS_WORKSPACE_ALGORITHM_VERSION,
          rounds: [{ round_number: 1 }],
        },
        analyzed_target_players: ["alpha", "beta"],
        players: {
          alpha: { clips: [{ clip_id: "a" }], timeline: { rounds: [] } },
          beta: { clips: [{ clip_id: "b" }] },
        },
      },
    };

    const loaded = buildLoadedLibraryDemo(item, {
      players: [{ player_name: "alpha" }, { player_name: "beta" }],
      match_meta: { map_name: "de_mirage" },
    });
    const handoff = prepareLibraryAnalysisHandoff([loaded], { 7: ["beta"] });

    expect(loaded.filename).toBe("Final");
    expect(handoff.libraryDemoIdsByIndex).toEqual({ 0: 7 });
    expect(handoff.selectedPlayers).toEqual({ 0: ["beta"] });
    expect(Object.keys(handoff.parsedMatches[0].players)).toEqual(["alpha", "beta"]);
    expect(handoff.parsedMatches[0].players.alpha.clips[0].client_clip_uid).toBeTruthy();
    expect(handoff.parsedMatches[0].demo_path).toBe("C:/demos/match.dem");
    expect(handoff.parsedMatches[0].has_player_keyboard_input).toBe(false);
    expect(buildPendingDemoAnalysisSpecs([loaded])).toEqual([]);
  });

  test.each(["match-workspace-2026.10.11-spec-slot-v3", undefined])(
    "withholds obsolete clips from recording and reparses the full roster (%s)",
    (algorithmVersion) => {
      const loaded = buildLoadedLibraryDemo({
        id: 7,
        filename: "match.dem",
        path: "C:/demos/match.dem",
        result: {
          analyzed_target_players: ["alpha"],
          analysis_workspace: algorithmVersion ? {
            version: 1,
            algorithm_version: algorithmVersion,
            rounds: [{ round_number: 1 }],
          } : null,
          players: {
            alpha: {
              clips: [{
                clip_id: "old-slot",
                target_spec_slot: 11,
                category: "compilation",
                compilation_kind: "freeze_to_death",
                freeze_to_death_round_filter: [2, 4],
              }],
            },
          },
        },
      }, { players: [{ name: "alpha" }, { name: "beta" }], match_meta: null });

      const handoff = prepareLibraryAnalysisHandoff([loaded], { 7: ["alpha"] });

      expect(handoff.parsedMatches).toEqual([null]);
      expect(handoff.selectedPlayers).toEqual({ 0: ["alpha"] });
      expect(handoff.freezeToDeathRoundsByMatch).toEqual({ 0: { picked: [2, 4] } });
      expect(buildPendingDemoAnalysisSpecs([loaded])).toEqual([{
        index: 0,
        players: ["alpha", "beta"],
      }]);
    },
  );

  test("falls back to the live roster when no cached analysis exists", () => {
    const loaded = buildLoadedLibraryDemo(
      { id: 9, filename: "fresh.dem", path: "C:/demos/fresh.dem" },
      { players: [{ player_name: "fresh-player" }], match_meta: null },
    );

    const handoff = prepareLibraryAnalysisHandoff([loaded]);

    expect(handoff.parsedMatches).toEqual([null]);
    expect(handoff.selectedPlayers).toEqual({ 0: ["fresh-player"] });
  });
});
