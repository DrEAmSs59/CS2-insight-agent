import { describe, expect, test } from "vitest";

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
      result: {
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
  });

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
