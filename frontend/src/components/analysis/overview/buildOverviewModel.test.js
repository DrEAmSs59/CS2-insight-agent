import { describe, expect, it } from "vitest";
import { buildOverviewModel } from "./buildOverviewModel";

function sideForRound(roundNumber, halftime = 13) {
  if (roundNumber < halftime) return { team_a_side: "T", team_b_side: "CT" };
  const otIndex = roundNumber - ((halftime - 1) * 2 + 1);
  if (otIndex >= 0) {
    const otHalf = Math.floor(otIndex / 3);
    const base = otHalf % 2 === 0 ? "T" : "CT";
    return { team_a_side: base, team_b_side: base === "T" ? "CT" : "T" };
  }
  return { team_a_side: "CT", team_b_side: "T" };
}

function buildRounds(winners, halftime = 13) {
  let scoreA = 0;
  let scoreB = 0;
  return winners.map((winner, index) => {
    const roundNumber = index + 1;
    const team_a_score_before = scoreA;
    const team_b_score_before = scoreB;
    if (winner === "a") scoreA += 1;
    else scoreB += 1;
    return {
      round_number: roundNumber,
      winner_team_key: winner,
      team_a_score_before,
      team_b_score_before,
      team_a_score_after: scoreA,
      team_b_score_after: scoreB,
      ...sideForRound(roundNumber, halftime),
    };
  });
}

function tagLabels(model) {
  return model.mainline.tags.map((tag) => tag.label);
}

describe("buildOverviewModel", () => {
  describe("scenario A: blowout 13:5", () => {
    const winners = [
      "a", "a", "a", "a", "a", "a", "a", "a", "a",
      "b", "b", "b",
      "a", "a", "a", "a",
      "b", "b",
    ];
    const data = {
      team_a_name: "Team Alpha",
      team_b_name: "Team Beta",
      team_a_score: 13,
      team_b_score: 5,
      rounds: buildRounds(winners),
      players: [],
    };

    it("tags blowout and excludes reverse/overtime", () => {
      const model = buildOverviewModel(data);
      const labels = tagLabels(model);
      expect(labels).toContain("碾压局");
      expect(labels).not.toContain("逆转局");
      expect(labels).not.toContain("加时鏖战");
    });

    it("includes the last round in keyRounds", () => {
      const model = buildOverviewModel(data);
      const lastRound = data.rounds[data.rounds.length - 1].round_number;
      expect(model.keyRounds.some((item) => item.roundNumber === lastRound)).toBe(true);
    });
  });

  describe("scenario C: overtime 19:16 (35 rounds)", () => {
    const data = {
      team_a_name: "Spirit",
      team_b_name: "OG",
      team_a_score: 19,
      team_b_score: 16,
      rounds: (() => {
        const seq = [];
        let sa = 0;
        let sb = 0;
        const pattern = [
          ...Array(6).fill("a"),
          ...Array(6).fill("b"),
          ...Array(6).fill("a"),
          ...Array(6).fill("b"),
          ...Array(7).fill("a"),
          ...Array(4).fill("b"),
        ];
        return pattern.map((winner, index) => {
          const roundNumber = index + 1;
          const team_a_score_before = sa;
          const team_b_score_before = sb;
          if (winner === "a") sa += 1;
          else sb += 1;
          return {
            round_number: roundNumber,
            winner_team_key: winner,
            team_a_score_before,
            team_b_score_before,
            team_a_score_after: sa,
            team_b_score_after: sb,
            ...sideForRound(roundNumber, 13),
          };
        });
      })(),
      players: [],
    };

    it("detects overtime from round 25 after flip at 13", () => {
      const model = buildOverviewModel(data);
      expect(model.phaseMeta.halftimeRound).toBe(13);
      expect(model.phaseMeta.regulationEndRound).toBe(24);
      expect(model.phaseMeta.overtimeRounds.map((r) => r.round_number)).toEqual(
        data.rounds.filter((r) => r.round_number >= 25).map((r) => r.round_number),
      );
      expect(model.phaseMeta.secondHalfRounds.every((r) => r.round_number <= 24)).toBe(true);
    });

    it("mentions overtime in mainline", () => {
      const model = buildOverviewModel(data);
      expect(model.match.state).toBe("completed");
      expect(model.mainline.text).toMatch(/加时/);
    });

    it("populates sidePerformance overtime columns", () => {
      const model = buildOverviewModel(data);
      expect(model.sidePerformance.teamA.overtime.total).toBeGreaterThan(0);
      expect(model.sidePerformance.teamB.overtime.total).toBeGreaterThan(0);
    });
  });

  describe("scenario G: incomplete or tied demo", () => {
    it("handles 12:12 tie without victory language", () => {
      const winners = Array.from({ length: 24 }, (_, i) => (i % 2 === 0 ? "a" : "b"));
      const data = {
        team_a_name: "Team A",
        team_b_name: "Team B",
        team_a_score: 12,
        team_b_score: 12,
        rounds: buildRounds(winners),
        players: [],
      };
      const model = buildOverviewModel(data);
      expect(model.match.state).toBe("tied");
      expect(model.mainline.text).not.toMatch(/战胜/);
      const finalKey = model.keyRounds.find(
        (item) => item.roundNumber === data.rounds[data.rounds.length - 1].round_number,
      );
      expect(finalKey).toBeTruthy();
      expect(finalKey.title).not.toBe("终结比赛");
    });

    it("handles 8:7 incomplete demo without victory language", () => {
      const winners = ["a", "a", "a", "a", "a", "a", "a", "a", "b", "b", "b", "b", "b", "b", "b"];
      const data = {
        team_a_name: "Team A",
        team_b_name: "Team B",
        team_a_score: 8,
        team_b_score: 7,
        rounds: buildRounds(winners),
        players: [],
      };
      const model = buildOverviewModel(data);
      expect(model.match.state).toBe("incomplete");
      expect(model.mainline.text).not.toMatch(/战胜/);
      const finalKey = model.keyRounds.find(
        (item) => item.roundNumber === data.rounds[data.rounds.length - 1].round_number,
      );
      expect(finalKey).toBeTruthy();
      expect(finalKey.title).not.toBe("终结比赛");
    });

    it("treats cut OT 13:12 as incomplete without strong win wording", () => {
      const winners = [
        ...Array.from({ length: 24 }, (_, i) => (i % 2 === 0 ? "a" : "b")),
        "a",
      ];
      const data = {
        team_a_name: "Team A",
        team_b_name: "Team B",
        team_a_score: 13,
        team_b_score: 12,
        rounds: buildRounds(winners),
        players: [],
      };
      const model = buildOverviewModel(data);
      expect(model.match.hasOvertime).toBe(true);
      expect(model.match.state).toBe("incomplete");
      expect(model.mainline.text).not.toMatch(/战胜/);
      expect(model.mainline.text).not.toMatch(/结束比赛/);
      const finalKey = model.keyRounds.find(
        (item) => item.roundNumber === data.rounds[data.rounds.length - 1].round_number,
      );
      expect(finalKey).toBeTruthy();
      expect(finalKey.title).not.toBe("终结比赛");
    });
  });

  describe("scenario B: regulation reverse 13:10", () => {
    const winners = [
      "a", "a", "a",
      "b", "b", "b", "b", "b", "b", "b", "b",
      "a", "a", "a", "a", "a", "a", "a", "a", "a", "a",
      "b", "b",
    ];
    const data = {
      team_a_name: "Team Alpha",
      team_b_name: "Team Beta",
      team_a_score: 13,
      team_b_score: 10,
      rounds: buildRounds(winners),
      players: [],
    };

    it("mentions deficit, tags reverse, and includes turning round in keyRounds", () => {
      const model = buildOverviewModel(data);
      expect(model.match.state).toBe("completed");
      expect(model.match.winnerKey).toBe("a");
      expect(model.mainline.text).toMatch(/落后/);
      expect(tagLabels(model)).toContain("逆转局");
      const turning = model.keyRounds.find((item) => item.roundNumber === 12);
      expect(turning).toBeTruthy();
    });
  });

  describe("scenario D: economy upset", () => {
    const winners = [
      ...Array(11).fill("a"),
      "a",
      ...Array(2).fill("a"),
      "b",
      ...Array(3).fill("a"),
    ];

    function buildEconomyRound(roundNumber, winner, equipA, equipB, extra = {}) {
      let scoreA = 0;
      let scoreB = 0;
      for (let i = 0; i < roundNumber - 1; i += 1) {
        if (winners[i] === "a") scoreA += 1;
        else scoreB += 1;
      }
      if (winner === "a") scoreA += 1;
      else scoreB += 1;
      return {
        round_number: roundNumber,
        winner_team_key: winner,
        team_a_score_before: winner === "a" ? scoreA - 1 : scoreA,
        team_b_score_before: winner === "b" ? scoreB - 1 : scoreB,
        team_a_score_after: scoreA,
        team_b_score_after: scoreB,
        team_a_equipment_value: equipA,
        team_b_equipment_value: equipB,
        team_a_economy: extra.team_a_economy || "full",
        team_b_economy: extra.team_b_economy || "full",
        events: [],
        ...sideForRound(roundNumber),
      };
    }

    const rounds = winners.map((winner, index) => {
      const roundNumber = index + 1;
      if (roundNumber === 12) {
        return buildEconomyRound(roundNumber, "a", 9000, 22000, {
          team_a_economy: "force",
          team_b_economy: "full",
        });
      }
      if (roundNumber === 15) {
        return buildEconomyRound(roundNumber, "b", 0, 18000);
      }
      return buildEconomyRound(roundNumber, winner, 20000, 20000);
    });

    const data = {
      team_a_name: "Spirit",
      team_b_name: "OG",
      team_a_score: 18,
      team_b_score: 0,
      rounds,
      players: [],
    };

    it("detects economy upset and ignores zero equipment", () => {
      const model = buildOverviewModel(data);
      const upset = model.economy.upsetRounds.find((item) => item.roundNumber === 12);
      expect(upset).toBeTruthy();
      expect(upset.winnerEquipment).toBe(9000);
      expect(upset.loserEquipment).toBe(22000);
      expect(model.economy.upsetRounds.some((item) => item.roundNumber === 15)).toBe(false);
      expect(model.keyRounds.some((item) => item.roundNumber === 12)).toBe(true);
    });
  });

  describe("scenario E: opening kills and 4v5", () => {
    const players = [
      { name: "alpha1", team_key: "a" },
      { name: "alpha2", team_key: "a" },
      { name: "beta1", team_key: "b" },
      { name: "beta2", team_key: "b" },
    ];

    function roundWithEvents(roundNumber, winner, events, priorWinners) {
      let scoreA = 0;
      let scoreB = 0;
      for (let i = 0; i < roundNumber - 1; i += 1) {
        if (priorWinners[i] === "a") scoreA += 1;
        else scoreB += 1;
      }
      if (winner === "a") scoreA += 1;
      else scoreB += 1;
      return {
        round_number: roundNumber,
        winner_team_key: winner,
        team_a_score_before: winner === "a" ? scoreA - 1 : scoreA,
        team_b_score_before: winner === "b" ? scoreB - 1 : scoreB,
        team_a_score_after: scoreA,
        team_b_score_after: scoreB,
        events,
        ...sideForRound(roundNumber),
      };
    }

    const priorWinners = ["a", "a", "a", "b"];
    const data = {
      team_a_name: "Team Alpha",
      team_b_name: "Team Beta",
      team_a_score: 3,
      team_b_score: 2,
      rounds: [
        roundWithEvents(1, "a", [
          { type: "kill", actor: "alpha1", target: "beta1", tick: 100 },
        ], priorWinners),
        roundWithEvents(2, "a", [
          { type: "kill", actor: "World", target: "beta1", tick: 100 },
          { type: "kill", actor: "alpha1", target: "beta1", tick: 200 },
        ], priorWinners),
        roundWithEvents(3, "a", [
          { type: "kill", actor: "alpha1", target: "alpha2", tick: 100 },
        ], priorWinners),
        roundWithEvents(4, "b", [
          { type: "kill", actor: "beta1", target: "alpha1", tick: 100 },
        ], priorWinners),
        roundWithEvents(5, "a", [
          { type: "kill", actor: "beta1", target: "alpha1", tick: 100 },
        ], priorWinners),
      ],
      players,
    };

    it("maps first kills, excludes invalid kills, and protects small samples", () => {
      const model = buildOverviewModel(data);
      expect(model.opening.teamA.firstKills).toBe(2);
      expect(model.opening.teamB.firstKills).toBe(2);
      expect(model.opening.teamA.fiveVFour).toEqual({
        wins: 2,
        total: 2,
        rate: null,
        sampleTooSmall: true,
      });
      expect(model.opening.teamA.fourVFive).toEqual({
        wins: 1,
        total: 2,
        rate: null,
        sampleTooSmall: true,
      });
      expect(model.opening.teamB.fiveVFour.total).toBe(2);
      expect(model.opening.teamB.fourVFive.wins).toBe(0);
    });
  });

  describe("scenario F: missing events", () => {
    const data = {
      team_a_name: "Team A",
      team_b_name: "Team B",
      team_a_score: 5,
      team_b_score: 3,
      rounds: buildRounds(["a", "a", "b", "a", "b", "a", "a", "b"]),
      players: [],
    };

    it("does not throw and keeps trend/side while marking empty event cards", () => {
      const model = buildOverviewModel(data);
      expect(model.trend.points.length).toBe(8);
      expect(model.sidePerformance.teamA.total.rounds).toBeGreaterThan(0);
      expect(model.opening.hasData).toBe(false);
      expect(model.objective.hasData).toBe(false);
      expect(model.playerEvents).toEqual([]);
    });
  });

  describe("scenario I: key round selection caps (§17.4)", () => {
    const ECONOMY_TYPES = new Set(["economy_upset", "force_upset"]);
    const PERSONAL_TYPES = new Set(["ace", "multikill", "clutch"]);

    function buildCapRound(roundNumber, winner, extra = {}) {
      let scoreA = 0;
      let scoreB = 0;
      const winners = extra.priorWinners || [];
      for (let i = 0; i < roundNumber - 1; i += 1) {
        if (winners[i] === "a") scoreA += 1;
        else scoreB += 1;
      }
      const team_a_score_before = scoreA;
      const team_b_score_before = scoreB;
      if (winner === "a") scoreA += 1;
      else scoreB += 1;

      return {
        round_number: roundNumber,
        winner_team_key: winner,
        team_a_score_before,
        team_b_score_before,
        team_a_score_after: scoreA,
        team_b_score_after: scoreB,
        team_a_equipment_value: extra.equipA ?? 20000,
        team_b_equipment_value: extra.equipB ?? 20000,
        team_a_economy: extra.team_a_economy || "full",
        team_b_economy: extra.team_b_economy || "full",
        special_events: extra.special_events || [],
        events: extra.events || [],
        ...sideForRound(roundNumber),
      };
    }

    const winners = [
      "a", "a", "a", "a", "a", "a", "a", "a", "a",
      "b", "b", "b",
      "a", "a", "a", "a",
      "b", "b",
    ];

    const rounds = winners.map((winner, index) => {
      const roundNumber = index + 1;
      const base = {
        priorWinners: winners,
        equipA: 20000,
        equipB: 20000,
      };

      if (roundNumber === 1) {
        return buildCapRound(roundNumber, winner, {
          ...base,
          team_a_economy: "pistol",
          team_b_economy: "pistol",
        });
      }
      if (roundNumber === 13) {
        return buildCapRound(roundNumber, winner, {
          ...base,
          team_a_economy: "pistol",
          team_b_economy: "pistol",
        });
      }
      if ([4, 7, 10, 14, 16].includes(roundNumber)) {
        const equipA = winner === "a" ? 8000 : 22000;
        const equipB = winner === "a" ? 22000 : 8000;
        return buildCapRound(roundNumber, winner, {
          ...base,
          equipA,
          equipB,
          team_a_economy: winner === "a" ? "force" : "full",
          team_b_economy: winner === "b" ? "force" : "full",
        });
      }
      if (roundNumber === 5) {
        return buildCapRound(roundNumber, winner, {
          ...base,
          special_events: [
            { type: "multikill", player: "ace1", kills: 5, team_key: "a" },
          ],
        });
      }
      if (roundNumber === 8) {
        return buildCapRound(roundNumber, winner, {
          ...base,
          special_events: [
            { type: "clutch", player: "clutch1", won: true, opponents: 4, team_key: "a" },
          ],
        });
      }
      if (roundNumber === 11) {
        return buildCapRound(roundNumber, winner, {
          ...base,
          special_events: [
            { type: "multikill", player: "ace2", kills: 5, team_key: "a" },
          ],
        });
      }
      if (roundNumber === 15) {
        return buildCapRound(roundNumber, winner, {
          ...base,
          special_events: [
            { type: "clutch", player: "clutch2", won: true, opponents: 3, team_key: "b" },
          ],
        });
      }
      if (roundNumber === 17) {
        return buildCapRound(roundNumber, winner, {
          ...base,
          special_events: [
            { type: "multikill", player: "ace3", kills: 4, team_key: "b" },
          ],
        });
      }
      return buildCapRound(roundNumber, winner, base);
    });

    const data = {
      team_a_name: "Team Alpha",
      team_b_name: "Team Beta",
      team_a_score: 13,
      team_b_score: 5,
      rounds,
      players: [
        { name: "ace1", team_key: "a" },
        { name: "ace2", team_key: "a" },
        { name: "clutch1", team_key: "a" },
        { name: "ace3", team_key: "b" },
        { name: "clutch2", team_key: "b" },
      ],
    };

    it("respects §17.4 selection caps on a dense synthetic match", () => {
      const model = buildOverviewModel(data);
      const lastRound = rounds[rounds.length - 1].round_number;

      expect(model.keyRounds.length).toBeLessThanOrEqual(5);
      expect(model.keyRounds.some((item) => item.roundNumber === lastRound)).toBe(true);

      let economyCount = 0;
      let pistolCount = 0;
      let personalCount = 0;
      for (const item of model.keyRounds) {
        if (item.types.some((t) => ECONOMY_TYPES.has(t))) economyCount += 1;
        if (item.types.includes("pistol")) pistolCount += 1;
        if (item.types.some((t) => PERSONAL_TYPES.has(t))) personalCount += 1;
      }

      expect(economyCount).toBeLessThanOrEqual(2);
      expect(pistolCount).toBeLessThanOrEqual(1);
      expect(personalCount).toBeLessThanOrEqual(2);
    });

    it("keeps multi-type pistol rounds after pistol quota is full", () => {
      // Alternate aab… so no 4+ streaks crowd the cap; R13 pure side-pistol
      // selects first, R16 pistol+match_point must survive via pistol strip.
      const balanced = [];
      for (let i = 0; i < 5; i += 1) balanced.push("a", "a", "b");
      balanced.push("a", "a", "a");
      const sparseRounds = balanced.map((winner, index) => {
        const roundNumber = index + 1;
        const base = { priorWinners: balanced, equipA: 20000, equipB: 20000 };
        if (roundNumber === 13 || roundNumber === 16) {
          return buildCapRound(roundNumber, winner, {
            ...base,
            team_a_economy: "pistol",
            team_b_economy: "pistol",
          });
        }
        return buildCapRound(roundNumber, winner, base);
      });
      const sparseData = {
        team_a_name: "Team Alpha",
        team_b_name: "Team Beta",
        team_a_score: 13,
        team_b_score: 5,
        rounds: sparseRounds,
        players: [],
      };
      const model = buildOverviewModel(sparseData);
      expect(model.match.state).toBe("completed");
      const r16 = model.keyRounds.find((item) => item.roundNumber === 16);
      expect(r16).toBeTruthy();
      expect(r16.types).toContain("match_point");
      expect(r16.types).not.toContain("pistol");
      expect(
        model.keyRounds.filter((item) => item.types.includes("pistol")).length,
      ).toBeLessThanOrEqual(1);
    });
  });

  describe("scenario K: clutch 1v2+ gate", () => {
    it("excludes 1v1 clutch and includes 1v2+", () => {
      const winners = ["a", "b", "a"];
      const rounds = winners.map((winner, index) => {
        const roundNumber = index + 1;
        let scoreA = 0;
        let scoreB = 0;
        for (let i = 0; i < roundNumber - 1; i += 1) {
          if (winners[i] === "a") scoreA += 1;
          else scoreB += 1;
        }
        const beforeA = scoreA;
        const beforeB = scoreB;
        if (winner === "a") scoreA += 1;
        else scoreB += 1;
        const special_events =
          roundNumber === 1
            ? [{ type: "clutch", player: "solo", won: true, opponents: 1, team_key: "a" }]
            : roundNumber === 2
              ? [{ type: "clutch", player: "duelist", won: true, opponents: 2, team_key: "b" }]
              : [{ type: "clutch", player: "hero", won: true, opponents: 3, team_key: "a" }];
        return {
          round_number: roundNumber,
          winner_team_key: winner,
          team_a_score_before: beforeA,
          team_b_score_before: beforeB,
          team_a_score_after: scoreA,
          team_b_score_after: scoreB,
          special_events,
          ...sideForRound(roundNumber),
        };
      });
      const model = buildOverviewModel({
        team_a_name: "Team A",
        team_b_name: "Team B",
        team_a_score: 2,
        team_b_score: 1,
        rounds,
        players: [
          { name: "solo", team_key: "a" },
          { name: "duelist", team_key: "b" },
          { name: "hero", team_key: "a" },
        ],
      });

      const clutchEvents = model.playerEvents.filter((e) => e.type === "clutch");
      expect(clutchEvents.some((e) => e.playerName === "solo")).toBe(false);
      expect(clutchEvents.some((e) => e.label === "1v2 残局")).toBe(true);
      expect(clutchEvents.some((e) => e.label === "1v3 残局")).toBe(true);
      expect(clutchEvents.every((e) => !/1v1/.test(e.label))).toBe(true);

      const r1 = model.keyRounds.find((item) => item.roundNumber === 1);
      if (r1) {
        expect(r1.types).not.toContain("clutch");
        expect(r1.title).not.toMatch(/1v2/);
      }
    });
  });

  describe("scenario J: streak_end detection", () => {
    const winners = ["a", "a", "a", "a", "b"];
    const data = {
      team_a_name: "Team Alpha",
      team_b_name: "Team Beta",
      team_a_score: 4,
      team_b_score: 1,
      rounds: buildRounds(winners),
      players: [],
    };

    it("marks the round that breaks a 4+ win streak", () => {
      const model = buildOverviewModel(data);
      expect(model.match.state).toBe("incomplete");
      const streakBreak = model.keyRounds.find((item) => item.roundNumber === 5);
      expect(streakBreak).toBeTruthy();
      expect(streakBreak.types).toContain("streak_end");
    });

    it("does not false-positive streak_end when the streak continues", () => {
      const model = buildOverviewModel(data);
      const streakContinue = model.keyRounds.find((item) => item.roundNumber === 4);
      if (streakContinue) {
        expect(streakContinue.types).not.toContain("streak_end");
      }
    });
  });

  describe("scenario H: no rating/mvp/最佳", () => {
    const data = {
      team_a_name: "Team Alpha",
      team_b_name: "Team Beta",
      team_a_score: 13,
      team_b_score: 5,
      rounds: buildRounds([
        "a", "a", "a", "a", "a", "a", "a", "a", "a",
        "b", "b", "b",
        "a", "a", "a", "a",
        "b", "b",
      ]),
      players: [
        { name: "star", team_key: "a", rating: 1.45, first_kills: 8 },
      ],
    };

    it("never emits rating/mvp/最佳 strings in the overview model", () => {
      const model = buildOverviewModel(data);
      const blob = JSON.stringify(model).toLowerCase();
      expect(blob).not.toMatch(/\brating\b/);
      expect(blob).not.toMatch(/\bmvp\b/);
      expect(JSON.stringify(model)).not.toContain("最佳");
    });
  });
});
