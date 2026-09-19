import { describe, expect, it } from "vitest";
import {
  num, ratio, percent, detectPhaseMeta, isValidEnemyKill, buildPlayerTeamMap,
  buildRoundHeadline, rewriteStoredRoundHeadline,
} from "./overviewUtils";

describe("overviewUtils", () => {
  it("guards num/ratio/percent", () => {
    expect(num(undefined)).toBe(0);
    expect(ratio(1, 0)).toBe(0);
    expect(percent(1, 2)).toBe("50%");
    expect(percent(1, 0)).toBe("0%");
  });

  it("detects phases from first team_a_side flip (MR12 OT)", () => {
    const rounds = [];
    for (let i = 1; i <= 35; i += 1) {
      rounds.push({
        round_number: i,
        team_a_side: i < 13 ? "T" : "CT",
        team_b_side: i < 13 ? "CT" : "T",
      });
    }
    const phase = detectPhaseMeta({}, rounds);
    expect(phase.halftimeRound).toBe(13);
    expect(phase.regulationEndRound).toBe(24);
    expect(phase.overtimeRounds.map((r) => r.round_number)).toEqual(
      rounds.filter((r) => r.round_number >= 25).map((r) => r.round_number),
    );
  });

  it("prefers backend phase_meta", () => {
    const phase = detectPhaseMeta(
      { phase_meta: { halftime_round: 9, regulation_end_round: 16 } },
      [{ round_number: 1, team_a_side: "T" }, { round_number: 9, team_a_side: "CT" }],
    );
    expect(phase.halftimeRound).toBe(9);
    expect(phase.regulationEndRound).toBe(16);
  });

  it("rejects world/suicide/team kills", () => {
    const map = buildPlayerTeamMap([
      { name: "A1", team_key: "a" },
      { name: "B1", team_key: "b" },
      { name: "A2", team_key: "a" },
    ]);
    expect(isValidEnemyKill({ type: "kill", actor: "World", target: "A1" }, map)).toBe(false);
    expect(isValidEnemyKill({ type: "kill", actor: "A1", target: "A1" }, map)).toBe(false);
    expect(isValidEnemyKill({ type: "kill", actor: "A1", target: "A2" }, map)).toBe(false);
    expect(isValidEnemyKill({ type: "kill", actor: "A1", target: "B1" }, map)).toBe(true);
  });

  it("keeps help-winner copy, except losing triples", () => {
    const playerTeamMap = buildPlayerTeamMap([
      { name: "狩猎的瞬间的心态", team_key: "a" },
      { name: "XTangRay", team_key: "b" },
    ]);

    expect(buildRoundHeadline({
      events: [
        { type: "kill", actor: "狩猎的瞬间的心态" },
        { type: "kill", actor: "狩猎的瞬间的心态" },
        { type: "kill", actor: "狩猎的瞬间的心态" },
        { type: "kill", actor: "XTangRay" },
      ],
      playerTeamMap,
      winnerKey: "b",
      winnerLabel: "Team B",
      site: "A",
      roundNumber: 12,
    })).toBe("狩猎的瞬间的心态 三杀未能赢下回合，Team B 获胜");

    expect(buildRoundHeadline({
      events: [
        { type: "kill", actor: "XTangRay" },
        { type: "kill", actor: "XTangRay" },
        { type: "kill", actor: "XTangRay" },
      ],
      playerTeamMap,
      winnerKey: "b",
      winnerLabel: "Team B",
      site: "B",
      roundNumber: 1,
    })).toBe("XTangRay 三杀帮助 Team B 拿下回合");

    expect(rewriteStoredRoundHeadline("狩猎的瞬间的心态 三杀帮助 Team B 拿下回合", {
      events: [
        { type: "kill", actor: "狩猎的瞬间的心态" },
        { type: "kill", actor: "狩猎的瞬间的心态" },
        { type: "kill", actor: "狩猎的瞬间的心态" },
      ],
      playerTeamMap,
      winnerKey: "b",
      winnerLabel: "Team B",
      site: "A",
      roundNumber: 12,
    })).toBe("狩猎的瞬间的心态 三杀未能赢下回合，Team B 获胜");

    expect(rewriteStoredRoundHeadline("ZywOo 双杀守住 B 区", {
      events: [{ type: "kill", actor: "ZywOo" }, { type: "kill", actor: "ZywOo" }],
      playerTeamMap: buildPlayerTeamMap([{ name: "ZywOo", team_key: "a" }]),
      winnerKey: "a",
      winnerLabel: "Vitality",
      site: "B",
      roundNumber: 4,
    })).toBe("ZywOo 双杀守住 B 区");
  });
});
