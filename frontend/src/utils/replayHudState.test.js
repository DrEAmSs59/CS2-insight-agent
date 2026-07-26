import { describe, expect, test } from "vitest";
import { replayUtilityExposureByName, roundEnemyKillCounts } from "./replayHudState";

describe("roundEnemyKillCounts", () => {
  const players = [
    { name: "alpha", team_key: "a" },
    { name: "bravo", team_key: "b" },
    { name: "charlie", team_key: "a" },
  ];

  test("counts credited enemy kills but excludes world deaths, team kills and future events", () => {
    const events = [
      { type: "kill", tick: 10, actor: "alpha", target: "bravo", weapon: "ak47" },
      { type: "kill", tick: 11, actor: "alpha", target: "charlie", weapon: "hegrenade" },
      { type: "kill", tick: 12, actor: "World", target: "bravo", weapon: "c4" },
      { type: "kill", tick: 30, actor: "alpha", target: "bravo", weapon: "molotov" },
    ];
    expect(roundEnemyKillCounts(events, 20, players)).toEqual({ alpha: 1 });
  });

  test("caps stars at five", () => {
    const events = Array.from({ length: 7 }, (_, index) => ({
      type: "kill",
      tick: index + 1,
      actor: "alpha",
      target: "bravo",
      weapon: `weapon-${index}`,
    }));
    expect(roundEnemyKillCounts(events, 20, players)).toEqual({ alpha: 5 });
  });
});

describe("replayUtilityExposureByName", () => {
  test("requires a live player to intersect active smoke or inferno world cells", () => {
    const tracks = [
      {
        type: "smoke",
        start_tick: 100,
        end_tick: 200,
        cell_size: 20,
        samples: [{ tick: 100, cells: [[10, 20, 36, 1]] }],
      },
      {
        type: "inferno",
        start_tick: 100,
        end_tick: 150,
        samples: [{ tick: 100, cells: [[100, 200, 0, 1]] }],
      },
    ];
    const players = [
      { name: "smoked", x: 10, y: 20, z: 0, is_alive: true },
      { name: "burning", x: 100, y: 200, z: 8, is_alive: true },
      { name: "clear", x: 400, y: 400, z: 0, is_alive: true },
      { name: "dead", x: 10, y: 20, z: 0, is_alive: false },
    ];
    expect(replayUtilityExposureByName(players, tracks, 120)).toEqual({
      smoked: { smoked: true, burning: false },
      burning: { smoked: false, burning: true },
      clear: { smoked: false, burning: false },
    });
    expect(replayUtilityExposureByName(players, tracks, 250).smoked).toEqual({
      smoked: false,
      burning: false,
    });
  });
});
