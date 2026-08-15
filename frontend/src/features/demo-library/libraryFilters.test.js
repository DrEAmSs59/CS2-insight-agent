import { describe, expect, test } from "vitest";

import { appendLibraryFilterParams, hasActiveLibraryFilters } from "./libraryFilters";

const EMPTY = {
  mapName: "",
  status: "all",
  playerQuery: "",
  steamQuery: "",
  minKills: "",
  maxDeaths: "",
  minAssists: "",
  minKd: "",
  roundsMin: "",
  roundsMax: "",
  durationMin: "",
  durationMax: "",
  dateFrom: "",
  dateTo: "",
};

describe("Demo Library filters", () => {
  test("maps UI filter names to the backend query contract", () => {
    const params = appendLibraryFilterParams({}, {
      ...EMPTY,
      mapName: " de_nuke ",
      status: "done",
      playerQuery: " alpha ",
      minKills: "12",
      minKd: "1.25",
    });

    expect(params).toEqual({
      map_name: "de_nuke",
      status: "done",
      player_query: "alpha",
      min_kills: 12,
      min_kd: 1.25,
    });
  });

  test("reports whether advanced filters are active", () => {
    expect(hasActiveLibraryFilters(EMPTY)).toBe(false);
    expect(hasActiveLibraryFilters({ ...EMPTY, steamQuery: "7656119" })).toBe(true);
  });
});
