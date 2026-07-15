import { describe, expect, test } from "vitest";

import {
  applyClientSideDemoFilters,
  classifyDemoStatus,
  deriveTags,
} from "./demoLibraryDisplay";
import { canLikelyPreviewScoreboard } from "./demoScoreboardModel";


describe("compact demo library rows", () => {
  test("preserve result-derived tags and parsed status without result_json", () => {
    const row = {
      status: "done",
      has_result: true,
      clip_count: 4,
      primary_target: "donk",
      map_name: "de_mirage",
    };

    expect(deriveTags(row)).toEqual([
      { key: "status.clipsTag", params: { n: 4 } },
      "donk",
      "de_mirage",
    ]);
    expect(classifyDemoStatus(row).kind).toBe("done");
    expect(canLikelyPreviewScoreboard(row)).toBe(true);
  });

  test("matches SteamID64 and account IDs from compact roster rows", () => {
    const row = {
      players: [
        {
          name: "Alice",
          steam_id64: "76561198000000001",
          account_id: "39734273",
        },
      ],
    };

    expect(applyClientSideDemoFilters([row], { steamQuery: "00000001" })).toEqual([row]);
    expect(applyClientSideDemoFilters([row], { steamQuery: "39734273" })).toEqual([row]);
    expect(applyClientSideDemoFilters([row], { steamQuery: "missing" })).toEqual([]);
  });

  test("ignores negative numeric filters just like the API request builder", () => {
    const row = { total_rounds: 24, duration_mins: 35 };
    expect(applyClientSideDemoFilters([row], { roundsMax: "-1", durationMax: "-1" })).toEqual([row]);
  });
});
