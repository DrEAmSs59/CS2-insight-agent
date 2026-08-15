import {
  num,
  ratio,
  normalizeRounds,
  detectPhaseMeta,
  buildPlayerTeamMap,
  isValidEnemyKill,
} from "./overviewUtils";

const EMPTY_SIDE = { t: 0, ct: 0, total: 0 };

function emptySideBucket() {
  return {
    firstHalf: { ...EMPTY_SIDE },
    secondHalf: { ...EMPTY_SIDE },
    overtime: { ...EMPTY_SIDE },
    total: { t: 0, ct: 0, rounds: 0 },
  };
}

function teamName(data, teamKey) {
  if (teamKey === "a") return data.team_a_name || "Team A";
  if (teamKey === "b") return data.team_b_name || "Team B";
  return "—";
}

function getFinalScores(data, rounds) {
  if (!rounds.length) {
    return {
      scoreA: num(data.team_a_score),
      scoreB: num(data.team_b_score),
    };
  }
  const last = rounds[rounds.length - 1];
  return {
    scoreA: num(last.team_a_score_after, num(data.team_a_score)),
    scoreB: num(last.team_b_score_after, num(data.team_b_score)),
  };
}

function buildMatchState(data, rounds, phaseMeta) {
  const { scoreA, scoreB } = getFinalScores(data, rounds);
  const hasOvertime = phaseMeta.overtimeRounds.length > 0;
  const totalRounds = rounds.length;
  const scoreDiff = Math.abs(scoreA - scoreB);

  if (!totalRounds) {
    return {
      state: "empty",
      winnerKey: null,
      loserKey: null,
      scoreA,
      scoreB,
      totalRounds,
      scoreDiff,
      hasOvertime,
    };
  }

  if (scoreA === scoreB) {
    return {
      state: "tied",
      winnerKey: null,
      loserKey: null,
      scoreA,
      scoreB,
      totalRounds,
      scoreDiff,
      hasOvertime,
    };
  }

  const winnerKey = scoreA > scoreB ? "a" : "b";
  const loserKey = winnerKey === "a" ? "b" : "a";
  const maxScore = Math.max(scoreA, scoreB);
  const regulationTarget =
    phaseMeta.halftimeRound != null ? phaseMeta.halftimeRound - 1 : 12;

  if (!hasOvertime && maxScore <= regulationTarget) {
    return {
      state: "incomplete",
      winnerKey: null,
      loserKey: null,
      scoreA,
      scoreB,
      totalRounds,
      scoreDiff,
      hasOvertime,
    };
  }

  // MR12 OT (MR3): finished only when a side reaches regulationTarget+4 (16).
  // Keeps 19:16 / 16:14 completed; treats cut demos like 13:12 as incomplete.
  if (hasOvertime && maxScore < regulationTarget + 4) {
    return {
      state: "incomplete",
      winnerKey: null,
      loserKey: null,
      scoreA,
      scoreB,
      totalRounds,
      scoreDiff,
      hasOvertime,
    };
  }

  return {
    state: "completed",
    winnerKey,
    loserKey,
    scoreA,
    scoreB,
    totalRounds,
    scoreDiff,
    hasOvertime,
  };
}

function computeRoundStats(rounds, phaseMeta, match) {
  let maxLeadA = 0;
  let maxLeadB = 0;
  let leadChanges = 0;
  let tieCount = 0;
  let previousLeader = null;
  let currentStreak = { teamKey: "", start: 0, end: 0, length: 0 };
  let longestStreak = { teamKey: "", start: 0, end: 0, length: 0 };
  const points = [];
  const worstDeficits = { a: 0, b: 0 };

  const stageScores = {
    firstHalf: { a: 0, b: 0 },
    secondHalf: { a: 0, b: 0 },
    overtime: { a: 0, b: 0 },
  };

  const firstHalfSet = new Set(
    phaseMeta.firstHalfRounds.map((round) => round.round_number),
  );
  const secondHalfSet = new Set(
    phaseMeta.secondHalfRounds.map((round) => round.round_number),
  );
  const overtimeSet = new Set(
    phaseMeta.overtimeRounds.map((round) => round.round_number),
  );

  // Kickoff at 0:0 so the chart starts on the baseline before R1.
  points.push({
    roundNumber: 0,
    scoreA: 0,
    scoreB: 0,
    lead: 0,
    isKickoff: true,
  });

  for (const round of rounds) {
    const scoreA = num(round.team_a_score_after);
    const scoreB = num(round.team_b_score_after);
    const lead = scoreA - scoreB;
    points.push({
      roundNumber: round.round_number,
      scoreA,
      scoreB,
      lead,
    });

    if (lead > 0) maxLeadA = Math.max(maxLeadA, lead);
    if (lead < 0) maxLeadB = Math.max(maxLeadB, -lead);
    if (lead === 0) tieCount += 1;

    if (scoreB > scoreA) worstDeficits.a = Math.max(worstDeficits.a, scoreB - scoreA);
    if (scoreA > scoreB) worstDeficits.b = Math.max(worstDeficits.b, scoreA - scoreB);

    const leader = lead > 0 ? "a" : lead < 0 ? "b" : null;
    if (leader && previousLeader && leader !== previousLeader) {
      leadChanges += 1;
    }
    if (leader) previousLeader = leader;

    const winner = round.winner_team_key;
    if (winner === "a" || winner === "b") {
      const roundNumber = round.round_number;
      if (currentStreak.teamKey === winner) {
        currentStreak = {
          ...currentStreak,
          end: roundNumber,
          length: currentStreak.length + 1,
        };
      } else {
        currentStreak = {
          teamKey: winner,
          start: roundNumber,
          end: roundNumber,
          length: 1,
        };
      }
      if (currentStreak.length > longestStreak.length) {
        longestStreak = { ...currentStreak };
      }

      if (firstHalfSet.has(roundNumber)) stageScores.firstHalf[winner] += 1;
      else if (secondHalfSet.has(roundNumber)) stageScores.secondHalf[winner] += 1;
      else if (overtimeSet.has(roundNumber)) stageScores.overtime[winner] += 1;
    }
  }

  const winnerKey = match.winnerKey;
  const winnerMaxDeficit = winnerKey ? worstDeficits[winnerKey] : 0;

  let turningRound = null;
  if (winnerKey && winnerMaxDeficit >= 3) {
    let worstDeficit = 0;
    for (const round of rounds) {
      const scoreA = num(round.team_a_score_after);
      const scoreB = num(round.team_b_score_after);
      const deficit =
        winnerKey === "a" ? scoreB - scoreA : scoreA - scoreB;
      if (deficit > worstDeficit) {
        worstDeficit = deficit;
        turningRound = round.round_number + 1;
      }
    }
  }

  let leadRound = 1;
  for (const round of rounds) {
    const scoreA = num(round.team_a_score_after);
    const scoreB = num(round.team_b_score_after);
    if (winnerKey === "a" && scoreA > scoreB) {
      leadRound = round.round_number;
      break;
    }
    if (winnerKey === "b" && scoreB > scoreA) {
      leadRound = round.round_number;
      break;
    }
  }

  const winnerOtRounds = winnerKey ? stageScores.overtime[winnerKey] : 0;
  const regulationScore = `${stageScores.firstHalf.a + stageScores.secondHalf.a}:${stageScores.firstHalf.b + stageScores.secondHalf.b}`;

  const secondHalfGain =
    match.loserKey != null
      ? stageScores.secondHalf[match.loserKey] -
        stageScores.secondHalf[match.winnerKey]
      : 0;

  return {
    points,
    maxLeadA,
    maxLeadB,
    leadChanges,
    tieCount,
    longestStreak,
    stageScores,
    winnerMaxDeficit,
    turningRound,
    leadRound,
    winnerOtRounds,
    regulationScore,
    secondHalfGain,
    winnerMaxLead:
      winnerKey === "a"
        ? maxLeadA
        : winnerKey === "b"
          ? maxLeadB
          : 0,
  };
}

function buildTags(match, stats, phaseMeta, sidePerformance) {
  const candidates = [];
  const { scoreDiff } = match;
  const hasReverse = match.winnerKey && stats.winnerMaxDeficit >= 3;
  const hasBlowout = match.state === "completed" && scoreDiff >= 7;

  if (phaseMeta.overtimeRounds.length > 0) {
    candidates.push({ key: "overtime", label: "加时鏖战", tone: "accent" });
  }
  if (hasReverse) {
    candidates.push({ key: "reverse", label: "逆转局", tone: "amber" });
  } else if (hasBlowout) {
    candidates.push({ key: "blowout", label: "碾压局", tone: "amber" });
  }
  if (stats.leadChanges >= 3) {
    candidates.push({ key: "back-and-forth", label: "拉锯局", tone: "blue" });
  }

  const ctWins = (sidePerformance.teamA?.total?.ct || 0) + (sidePerformance.teamB?.total?.ct || 0);
  const tWins = (sidePerformance.teamA?.total?.t || 0) + (sidePerformance.teamB?.total?.t || 0);
  const totalSideRounds = ctWins + tWins;
  if (totalSideRounds > 0) {
    if (ctWins - tWins >= 4 && ratio(ctWins, totalSideRounds) >= 0.6) {
      candidates.push({ key: "ct-dominant", label: "CT 方主导", tone: "blue" });
    } else if (tWins - ctWins >= 4 && ratio(tWins, totalSideRounds) >= 0.6) {
      candidates.push({ key: "t-dominant", label: "T 方主导", tone: "amber" });
    }
  }

  if (stats.longestStreak.length >= 5) {
    candidates.push({ key: "streak", label: "连胜拉开", tone: "accent" });
  }

  const tags = [];
  const used = new Set();
  for (const tag of candidates) {
    if (tags.length >= 3) break;
    if (tag.key === "reverse" && used.has("blowout")) continue;
    if (tag.key === "blowout" && used.has("reverse")) continue;
    if (tag.key === "ct-dominant" && used.has("t-dominant")) continue;
    if (tag.key === "t-dominant" && used.has("ct-dominant")) continue;
    tags.push(tag);
    used.add(tag.key);
  }
  return tags;
}

function buildMainline(data, match, phaseMeta, stats, sidePerformance) {
  const title = "比赛主线";
  const { scoreA, scoreB } = match;

  const maxLead = Math.max(stats.maxLeadA || 0, stats.maxLeadB || 0) || undefined;
  const longestStreak =
    stats.longestStreak?.length > 0 ? stats.longestStreak.length : undefined;
  const metrics = { maxLead, longestStreak };

  if (match.state === "empty") {
    return {
      title,
      text: "当前解析结果没有可用于生成概览的正式回合。",
      tags: [],
      ...metrics,
    };
  }

  if (match.state === "tied") {
    return {
      title,
      text: `双方当前比分为 ${scoreA}:${scoreB}，比赛结束时战平。`,
      tags: buildTags(match, stats, phaseMeta, sidePerformance),
      ...metrics,
    };
  }

  if (match.state === "incomplete") {
    return {
      title,
      text: `Demo 在 ${scoreA}:${scoreB} 时结束，比赛尚未分出胜负。`,
      tags: buildTags(match, stats, phaseMeta, sidePerformance),
      ...metrics,
    };
  }

  const winnerName = teamName(data, match.winnerKey);
  const loserName = teamName(data, match.loserKey);
  const winnerScore = match.winnerKey === "a" ? scoreA : scoreB;
  const loserScore = match.loserKey === "a" ? scoreA : scoreB;

  let text;

  if (
    match.hasOvertime &&
    stats.winnerMaxDeficit >= 3 &&
    stats.winnerOtRounds > 0
  ) {
    text = `${winnerName} 常规阶段一度落后 ${stats.winnerMaxDeficit} 分，加时完成反超并以 ${winnerScore}:${loserScore} 获胜。`;
  } else if (match.hasOvertime) {
    text = `双方常规阶段战至 ${stats.regulationScore}，${winnerName} 加时拿下 ${stats.winnerOtRounds} 回合，以 ${winnerScore}:${loserScore} 获胜。`;
  } else if (stats.winnerMaxDeficit >= 3) {
    text = `${winnerName} 曾落后 ${stats.winnerMaxDeficit} 分，从 R${stats.turningRound || "?"} 扭转走势，以 ${winnerScore}:${loserScore} 完成逆转。`;
  } else if (match.scoreDiff >= 7) {
    text = `${winnerName} 从 R${stats.leadRound} 开始建立优势，并以 ${winnerScore}:${loserScore} 轻松获胜。`;
  } else if (stats.secondHalfGain >= 4) {
    text = `${loserName} 下半场追回 ${stats.secondHalfGain} 分，但 ${winnerName} 守住优势，以 ${winnerScore}:${loserScore} 获胜。`;
  } else if (match.scoreDiff <= 2) {
    text = `${winnerName} 以 ${winnerScore}:${loserScore} 险胜，双方分差较小，节奏胶着。`;
  } else {
    text = `${winnerName} 以 ${winnerScore}:${loserScore} 获胜。`;
  }

  return {
    title,
    text,
    tags: buildTags(match, stats, phaseMeta, sidePerformance),
    ...metrics,
  };
}

function buildTrend(rounds, phaseMeta, stats, match) {
  const { stageScores, longestStreak } = stats;
  // Compact layout: half / OT / lead / streak live in the chart footer — no prose summary.
  let summary = "";
  if (!rounds.length) {
    summary = "暂无可用回合数据。";
  } else if (match.state === "tied" || match.state === "incomplete") {
    summary = `当前比分 ${match.scoreA}:${match.scoreB}。`;
  }

  return {
    points: stats.points,
    maxLeadA: stats.maxLeadA,
    maxLeadB: stats.maxLeadB,
    longestStreak,
    stageScores,
    summary,
    hasOvertime: (phaseMeta.overtimeRounds || []).length > 0,
  };
}

function incrementSideBucket(bucket, side) {
  if (side === "T") bucket.t += 1;
  if (side === "CT") bucket.ct += 1;
  bucket.total += 1;
}

function buildSidePerformance(rounds, phaseMeta, data) {
  const teamA = emptySideBucket();
  const teamB = emptySideBucket();

  const firstHalfSet = new Set(
    phaseMeta.firstHalfRounds.map((round) => round.round_number),
  );
  const secondHalfSet = new Set(
    phaseMeta.secondHalfRounds.map((round) => round.round_number),
  );
  const overtimeSet = new Set(
    phaseMeta.overtimeRounds.map((round) => round.round_number),
  );

  for (const round of rounds) {
    const winner = round.winner_team_key;
    if (winner !== "a" && winner !== "b") continue;

    const side =
      winner === "a" ? round.team_a_side : round.team_b_side;
    if (!side) continue;

    const bucket = winner === "a" ? teamA : teamB;
    const roundNumber = round.round_number;

    if (firstHalfSet.has(roundNumber)) incrementSideBucket(bucket.firstHalf, side);
    else if (secondHalfSet.has(roundNumber)) incrementSideBucket(bucket.secondHalf, side);
    else if (overtimeSet.has(roundNumber)) incrementSideBucket(bucket.overtime, side);

    if (side === "T") bucket.total.t += 1;
    if (side === "CT") bucket.total.ct += 1;
    bucket.total.rounds += 1;
  }

  const ctWins = teamA.total.ct + teamB.total.ct;
  const tWins = teamA.total.t + teamB.total.t;
  let dominantSide = null;
  if (ctWins - tWins >= 4) dominantSide = "CT";
  else if (tWins - ctWins >= 4) dominantSide = "T";

  const teamACtGap = teamA.total.ct - teamA.total.t;
  const teamBCtGap = teamB.total.ct - teamB.total.t;
  const teamATGap = teamA.total.t - teamA.total.ct;
  const teamBTGap = teamB.total.t - teamB.total.ct;
  const nameA = teamName(data, "a");
  const nameB = teamName(data, "b");

  let summary = "双方在 T/CT 两侧的得分差异不明显。";
  if (teamACtGap >= 4 && teamACtGap > teamBCtGap) {
    summary = `${nameA} 在 CT 方拿下 ${teamA.total.ct} 回合，CT 表现更胜一筹`;
    dominantSide = "CT";
  } else if (teamBCtGap >= 4 && teamBCtGap > teamACtGap) {
    summary = `${nameB} 在 CT 方拿下 ${teamB.total.ct} 回合，CT 表现更胜一筹`;
    dominantSide = "CT";
  } else if (teamATGap >= 4 && teamATGap > teamBTGap) {
    summary = `${nameA} 在 T 方拿下 ${teamA.total.t} 回合，T 表现更胜一筹`;
    dominantSide = "T";
  } else if (teamBTGap >= 4 && teamBTGap > teamATGap) {
    summary = `${nameB} 在 T 方拿下 ${teamB.total.t} 回合，T 表现更胜一筹`;
    dominantSide = "T";
  } else if (dominantSide === "CT") {
    const leader = teamA.total.ct >= teamB.total.ct ? nameA : nameB;
    const wins = Math.max(teamA.total.ct, teamB.total.ct);
    summary = `${leader} 在 CT 方拿下 ${wins} 回合，CT 表现更胜一筹`;
  } else if (dominantSide === "T") {
    const leader = teamA.total.t >= teamB.total.t ? nameA : nameB;
    const wins = Math.max(teamA.total.t, teamB.total.t);
    summary = `${leader} 在 T 方拿下 ${wins} 回合，T 表现更胜一筹`;
  }

  return {
    teamA,
    teamB,
    dominantSide,
    summary,
    hasOvertime: (phaseMeta.overtimeRounds || []).length > 0,
  };
}

function isPistolRound(round) {
  return round.team_a_economy === "pistol" || round.team_b_economy === "pistol";
}

function isEconomyUpset(winnerEquip, loserEquip) {
  return (
    winnerEquip > 0 &&
    loserEquip > 0 &&
    winnerEquip / loserEquip <= 0.65 &&
    loserEquip - winnerEquip >= 5000
  );
}

function rateBucket(wins, total) {
  return {
    wins,
    total,
    rate: total < 3 ? null : ratio(wins, total),
    sampleTooSmall: total < 3,
  };
}

function emptyTeamOpening() {
  return {
    firstKills: 0,
    fiveVFour: rateBucket(0, 0),
    fourVFive: rateBucket(0, 0),
    clutch1vN: rateBucket(0, 0),
  };
}

function getFirstKillTeam(round, playerTeamMap) {
  for (const event of round.events || []) {
    if (!isValidEnemyKill(event, playerTeamMap)) continue;
    const actorTeam = playerTeamMap.get(String(event.actor).trim().toLowerCase());
    return actorTeam || null;
  }
  return null;
}

/**
 * 每回合每位选手最多计 1 次 1vN 残局：取最高对手人数（1v3→1v2 不重复）。
 * @returns {Array<{ teamKey: "a"|"b", opponents: number, won: boolean }>}
 */
function collectRoundClutch1vNAttempts(round, playerTeamMap) {
  const sources = [...(round.special_events || []), ...(round.events || [])];
  /** @type {Map<string, { teamKey: string, opponents: number, won: boolean }>} */
  const byPlayer = new Map();

  for (const event of sources) {
    if (event?.type !== "clutch") continue;
    const opponents = num(event.opponents);
    if (opponents < 1) continue;
    const playerKey = event.player ? String(event.player).trim().toLowerCase() : "";
    if (!playerKey) continue;

    let teamKey = event.team_key;
    if (teamKey !== "a" && teamKey !== "b") {
      teamKey = playerTeamMap.get(playerKey) || null;
    }
    if (teamKey !== "a" && teamKey !== "b") continue;

    const prev = byPlayer.get(playerKey);
    if (!prev || opponents > prev.opponents) {
      byPlayer.set(playerKey, { teamKey, opponents, won: event.won === true });
    } else if (opponents === prev.opponents && event.won === true) {
      byPlayer.set(playerKey, { ...prev, won: true });
    }
  }

  return [...byPlayer.values()].filter((attempt) => attempt.opponents >= 2);
}

function buildOpening(rounds, data) {
  const playerTeamMap = buildPlayerTeamMap(data.players);
  const teamA = emptyTeamOpening();
  const teamB = emptyTeamOpening();
  let hasData = false;

  for (const round of rounds) {
    const fkTeam = getFirstKillTeam(round, playerTeamMap);
    if (fkTeam) {
      hasData = true;

      const winner = round.winner_team_key;
      if (fkTeam === "a") {
        teamA.firstKills += 1;
        teamA.fiveVFour.total += 1;
        if (winner === "a") teamA.fiveVFour.wins += 1;
        teamB.fourVFive.total += 1;
        if (winner === "b") teamB.fourVFive.wins += 1;
      } else if (fkTeam === "b") {
        teamB.firstKills += 1;
        teamB.fiveVFour.total += 1;
        if (winner === "b") teamB.fiveVFour.wins += 1;
        teamA.fourVFive.total += 1;
        if (winner === "a") teamA.fourVFive.wins += 1;
      }
    }

    for (const attempt of collectRoundClutch1vNAttempts(round, playerTeamMap)) {
      const bucket = attempt.teamKey === "a" ? teamA.clutch1vN : teamB.clutch1vN;
      bucket.total += 1;
      if (attempt.won) bucket.wins += 1;
    }
  }

  teamA.fiveVFour = rateBucket(teamA.fiveVFour.wins, teamA.fiveVFour.total);
  teamA.fourVFive = rateBucket(teamA.fourVFive.wins, teamA.fourVFive.total);
  teamA.clutch1vN = rateBucket(teamA.clutch1vN.wins, teamA.clutch1vN.total);
  teamB.fiveVFour = rateBucket(teamB.fiveVFour.wins, teamB.fiveVFour.total);
  teamB.fourVFive = rateBucket(teamB.fourVFive.wins, teamB.fourVFive.total);
  teamB.clutch1vN = rateBucket(teamB.clutch1vN.wins, teamB.clutch1vN.total);

  let summary = "";
  if (!hasData) {
    summary = "当前 Demo 未提供可用于统计的首杀事件。";
  } else if (
    teamA.fiveVFour.total >= 3 &&
    teamB.fiveVFour.total >= 3 &&
    teamA.fiveVFour.rate != null &&
    teamB.fiveVFour.rate != null
  ) {
    const leader = teamA.fiveVFour.rate >= teamB.fiveVFour.rate ? "a" : "b";
    summary = `${teamName(data, leader)} 的 5v4 转化率更高。`;
  }

  return { teamA, teamB, summary, hasData };
}

function detectRoundEconomyUpset(round) {
  const winnerKey = round.winner_team_key;
  if (winnerKey !== "a" && winnerKey !== "b") return null;

  const equipA = num(round.team_a_equipment_value);
  const equipB = num(round.team_b_equipment_value);
  const winnerEquip = winnerKey === "a" ? equipA : equipB;
  const loserEquip = winnerKey === "a" ? equipB : equipA;

  if (!isEconomyUpset(winnerEquip, loserEquip)) return null;

  const winnerEcon = winnerKey === "a" ? round.team_a_economy : round.team_b_economy;
  const loserEcon = winnerKey === "a" ? round.team_b_economy : round.team_a_economy;
  const isForceUpset =
    (winnerEcon === "force" && loserEcon === "full") ||
    ((winnerEcon === "eco" || winnerEcon === "semi") &&
      isEconomyUpset(winnerEquip, loserEquip));

  return {
    roundNumber: round.round_number,
    winnerTeamKey: winnerKey,
    winnerEquipment: winnerEquip,
    loserEquipment: loserEquip,
    equipRatio: ratio(winnerEquip, loserEquip),
    gap: loserEquip - winnerEquip,
    isForceUpset,
    winnerEconomy: winnerEcon || null,
    loserEconomy: loserEcon || null,
  };
}

function buildEconomy(rounds, data, _phaseMeta, stats) {
  const pistol = {
    teamA: {
      wins: 0,
      conversionWins: 0,
      conversionTotal: 0,
      conversionRate: null,
      postWinStreaks: [],
    },
    teamB: {
      wins: 0,
      conversionWins: 0,
      conversionTotal: 0,
      conversionRate: null,
      postWinStreaks: [],
    },
  };
  const upsetRounds = [];
  let hasEconomyData = false;

  for (let i = 0; i < rounds.length; i += 1) {
    const round = rounds[i];
    const equipA = num(round.team_a_equipment_value);
    const equipB = num(round.team_b_equipment_value);
    if (equipA > 0 || equipB > 0) hasEconomyData = true;

    if (isPistolRound(round)) {
      const winner = round.winner_team_key;
      if (winner === "a" || winner === "b") {
        const key = winner === "a" ? "teamA" : "teamB";
        pistol[key].wins += 1;
        let streak = 0;
        for (let j = i + 1; j < rounds.length; j += 1) {
          if (rounds[j].winner_team_key === winner) streak += 1;
          else break;
        }
        pistol[key].postWinStreaks.push(streak);
        if (i < rounds.length - 1) {
          const nextRound = rounds[i + 1];
          pistol[key].conversionTotal += 1;
          if (nextRound.winner_team_key === winner) {
            pistol[key].conversionWins += 1;
          }
        }
      }
    }

    const upset = detectRoundEconomyUpset(round);
    if (upset) upsetRounds.push(upset);
  }

  for (const key of ["teamA", "teamB"]) {
    const bucket = pistol[key];
    bucket.conversionRate =
      bucket.conversionTotal < 3
        ? null
        : ratio(bucket.conversionWins, bucket.conversionTotal);
    bucket.sampleTooSmall = bucket.conversionTotal < 3;
  }

  let keyRound = null;
  if (upsetRounds.length > 0) {
    const scoreUpset = (upset) => {
      let score = 1 - upset.equipRatio;
      const round = rounds.find((r) => r.round_number === upset.roundNumber);
      if (!round) return score;
      const beforeA = num(round.team_a_score_before);
      const beforeB = num(round.team_b_score_before);
      const wasBehind =
        upset.winnerTeamKey === "a" ? beforeB > beforeA : beforeA > beforeB;
      const wasTied = beforeA === beforeB;
      if (wasTied) score += 1;
      if (wasBehind) score += 1.5;
      if (
        stats.longestStreak.start === upset.roundNumber &&
        stats.longestStreak.length >= 3
      ) {
        score += 1;
      }
      if (upset.roundNumber >= rounds.length * 0.5) score += 0.5;
      return score;
    };
    keyRound = [...upsetRounds].sort((a, b) => scoreUpset(b) - scoreUpset(a))[0];
    if (keyRound) {
      const kr = rounds.find((r) => r.round_number === keyRound.roundNumber);
      if (kr) {
        keyRound = {
          ...keyRound,
          scoreA: num(kr.team_a_score_after),
          scoreB: num(kr.team_b_score_after),
        };
      }
    }
  }

  let summary = "";
  if (
    !hasEconomyData &&
    upsetRounds.length === 0 &&
    pistol.teamA.wins === 0 &&
    pistol.teamB.wins === 0
  ) {
    summary = "本场未产生明显经济翻盘回合";
  }

  return {
    pistol,
    conversions: {
      teamA: { ...pistol.teamA },
      teamB: { ...pistol.teamB },
    },
    upsetRounds,
    keyRound,
    summary,
    hasData:
      hasEconomyData ||
      upsetRounds.length > 0 ||
      pistol.teamA.wins > 0 ||
      pistol.teamB.wins > 0,
  };
}

function buildObjective(rounds, data) {
  const playerTeamMap = buildPlayerTeamMap(data.players);
  const teamA = {
    plants: 0,
    plantWins: 0,
    plantWinRate: null,
    defuses: 0,
    explodeWins: 0,
  };
  const teamB = {
    plants: 0,
    plantWins: 0,
    plantWinRate: null,
    defuses: 0,
    explodeWins: 0,
  };
  let siteA = 0;
  let siteB = 0;
  let hasData = false;

  for (const round of rounds) {
    const winner = round.winner_team_key;
    for (const event of round.events || []) {
      const type = event.type;
      if (!["plant", "defuse", "explode"].includes(type)) continue;

      const actorTeam = playerTeamMap.get(
        String(event.actor || "").trim().toLowerCase(),
      );
      if (!actorTeam) continue;
      hasData = true;

      const bucket = actorTeam === "a" ? teamA : teamB;
      if (type === "plant") {
        bucket.plants += 1;
        const site = String(event.site || "").toUpperCase();
        if (site === "A") siteA += 1;
        else if (site === "B") siteB += 1;
        if (winner === actorTeam) bucket.plantWins += 1;
      } else if (type === "defuse") {
        bucket.defuses += 1;
      } else if (type === "explode") {
        bucket.explodeWins += 1;
      }
    }
  }

  teamA.plantWinRate =
    teamA.plants > 0 ? ratio(teamA.plantWins, teamA.plants) : null;
  teamB.plantWinRate =
    teamB.plants > 0 ? ratio(teamB.plantWins, teamB.plants) : null;

  let summary = "";
  let dominantSite = null;
  const totalSites = siteA + siteB;
  if (!hasData) {
    summary = "本场没有可识别的下包事件。";
  } else if (totalSites >= 3) {
    const shareA = siteA / totalSites;
    const shareB = siteB / totalSites;
    if (shareA >= 0.65) {
      dominantSite = "A";
      summary = "主要下包点：A 点";
    } else if (shareB >= 0.65) {
      dominantSite = "B";
      summary = "主要下包点：B 点";
    }
  }

  return { teamA, teamB, siteA, siteB, summary, dominantSite, hasData };
}

const PLAYER_EVENT_PRIORITY = {
  clutch_1v5: 1,
  clutch_1v4: 2,
  ace: 3,
  clutch_1v3: 4,
  multikill_4k: 5,
  clutch_1v2: 6,
  first_kills: 7,
  utility_damage: 8,
  trade_kills: 9,
  clutch_aggregate: 10,
};

function buildPlayerEvents(rounds, data) {
  const playerTeamMap = buildPlayerTeamMap(data.players);
  const candidates = [];

  for (const round of rounds) {
    const specialEvents = round.special_events || [];
    for (const event of specialEvents) {
      if (event.type === "clutch" && event.won === true && event.player) {
        const opponents = num(event.opponents);
        // Gate to 1v2+ only — never label 0/1-opponent clutches as「1v2 残局」.
        if (opponents < 2) continue;
        let subType = "clutch_1v2";
        if (opponents >= 5) subType = "clutch_1v5";
        else if (opponents === 4) subType = "clutch_1v4";
        else if (opponents === 3) subType = "clutch_1v3";
        candidates.push({
          type: "clutch",
          subType,
          priority: PLAYER_EVENT_PRIORITY[subType] || 10,
          playerName: event.player,
          teamKey:
            event.team_key ||
            playerTeamMap.get(String(event.player).trim().toLowerCase()) ||
            null,
          roundNumber: round.round_number,
          scoreA: num(round.team_a_score_after),
          scoreB: num(round.team_b_score_after),
          label:
            opponents >= 5
              ? `1v${opponents} 残局`
              : opponents === 4
                ? "1v4 残局"
                : opponents === 3
                  ? "1v3 残局"
                  : "1v2 残局",
        });
      }
      if (event.type === "multikill" && event.player) {
        const kills = num(event.kills);
        if (kills < 4) continue;
        const subType = kills >= 5 ? "ace" : "multikill_4k";
        candidates.push({
          type: kills >= 5 ? "ace" : "multikill",
          subType,
          priority: PLAYER_EVENT_PRIORITY[subType],
          playerName: event.player,
          teamKey:
            event.team_key ||
            playerTeamMap.get(String(event.player).trim().toLowerCase()) ||
            null,
          roundNumber: round.round_number,
          scoreA: num(round.team_a_score_after),
          scoreB: num(round.team_b_score_after),
          label: kills >= 5 ? "ACE" : "四杀",
        });
      }
    }

    if (!specialEvents.length) {
      const killCounts = new Map();
      for (const event of round.events || []) {
        if (!isValidEnemyKill(event, playerTeamMap)) continue;
        const actor = String(event.actor).trim();
        killCounts.set(actor, (killCounts.get(actor) || 0) + 1);
      }
      for (const [actor, kills] of killCounts) {
        if (kills < 4) continue;
        const subType = kills >= 5 ? "ace" : "multikill_4k";
        candidates.push({
          type: kills >= 5 ? "ace" : "multikill",
          subType,
          priority: PLAYER_EVENT_PRIORITY[subType],
          playerName: actor,
          teamKey: playerTeamMap.get(actor.toLowerCase()) || null,
          roundNumber: round.round_number,
          scoreA: num(round.team_a_score_after),
          scoreB: num(round.team_b_score_after),
          label: kills >= 5 ? "ACE" : "四杀",
        });
      }
    }
  }

  const players = data.players || [];
  for (const teamKey of ["a", "b"]) {
    const teamPlayers = players.filter((p) => p.team_key === teamKey);
    if (teamPlayers.length < 2) continue;

    const byFk = [...teamPlayers].sort(
      (a, b) => num(b.first_kills) - num(a.first_kills),
    );
    if (
      num(byFk[0].first_kills) >= 6 &&
      num(byFk[0].first_kills) - num(byFk[1].first_kills) >= 2
    ) {
      candidates.push({
        type: "first_kills",
        subType: "first_kills",
        priority: PLAYER_EVENT_PRIORITY.first_kills,
        playerName: byFk[0].name,
        teamKey,
        roundNumber: null,
        label: `${num(byFk[0].first_kills)} 次首杀`,
      });
    }

    const byUtil = [...teamPlayers].sort(
      (a, b) => num(b.utility_damage) - num(a.utility_damage),
    );
    const topUtil = num(byUtil[0].utility_damage);
    const secondUtil = num(byUtil[1].utility_damage);
    if (topUtil >= 150 && secondUtil > 0 && topUtil >= secondUtil * 1.2) {
      candidates.push({
        type: "utility_damage",
        subType: "utility_damage",
        priority: PLAYER_EVENT_PRIORITY.utility_damage,
        playerName: byUtil[0].name,
        teamKey,
        roundNumber: null,
        label: `造成 ${topUtil} 点道具伤害`,
      });
    }

    const byTrade = [...teamPlayers].sort(
      (a, b) => num(b.trade_kills) - num(a.trade_kills),
    );
    if (
      num(byTrade[0].trade_kills) >= 6 &&
      num(byTrade[0].trade_kills) - num(byTrade[1].trade_kills) >= 2
    ) {
      candidates.push({
        type: "trade_kills",
        subType: "trade_kills",
        priority: PLAYER_EVENT_PRIORITY.trade_kills,
        playerName: byTrade[0].name,
        teamKey,
        roundNumber: null,
        label: `完成 ${num(byTrade[0].trade_kills)} 次补枪`,
      });
    }

    const byClutch = [...teamPlayers].sort(
      (a, b) => num(b.clutch_wins) - num(a.clutch_wins),
    );
    if (num(byClutch[0].clutch_wins) >= 2) {
      candidates.push({
        type: "clutch_aggregate",
        subType: "clutch_aggregate",
        priority: PLAYER_EVENT_PRIORITY.clutch_aggregate,
        playerName: byClutch[0].name,
        teamKey,
        roundNumber: null,
        label: `赢下 ${num(byClutch[0].clutch_wins)} 次残局`,
      });
    }
  }

  candidates.sort((a, b) => a.priority - b.priority);

  const selected = [];
  const playerCounts = new Map();
  for (const candidate of candidates) {
    if (selected.length >= 8) break;
    const count = playerCounts.get(candidate.playerName) || 0;
    if (count >= 2) continue;
    selected.push(candidate);
    playerCounts.set(candidate.playerName, count + 1);
  }

  return selected;
}

function formatRoundTimestamp(round, data, firstFreezeTick) {
  const tickRate = num(data.tick_rate);
  const freezeTick = num(round.freeze_end_tick);
  if (
    tickRate > 0 &&
    freezeTick > 0 &&
    firstFreezeTick > 0 &&
    freezeTick >= firstFreezeTick
  ) {
    const seconds = Math.floor((freezeTick - firstFreezeTick) / tickRate);
    const mins = Math.floor(seconds / 60);
    const secs = seconds % 60;
    return `${mins}:${String(secs).padStart(2, "0")}`;
  }
  return `R${round.round_number}`;
}

function getStreakStartingAt(rounds, roundNumber) {
  let length = 0;
  let teamKey = null;
  for (const round of rounds) {
    if (round.round_number < roundNumber) continue;
    const winner = round.winner_team_key;
    if (winner !== "a" && winner !== "b") return { teamKey: null, length: 0 };
    if (length === 0) {
      teamKey = winner;
      length = 1;
    } else if (winner === teamKey) {
      length += 1;
    } else {
      break;
    }
  }
  return { teamKey, length };
}

function buildKeyRoundCandidates(
  rounds,
  data,
  match,
  phaseMeta,
  stats,
  economy,
  playerEvents,
) {
  const candidates = [];
  const totalRounds = rounds.length;
  const lateThreshold = Math.ceil(totalRounds * 0.7);
  const last30Threshold = Math.ceil(totalRounds * 0.7);
  const regulationTarget =
    phaseMeta.halftimeRound != null ? phaseMeta.halftimeRound - 1 : 12;
  const firstFreezeTick = num(rounds[0]?.freeze_end_tick);

  let winStreak = { teamKey: "", length: 0 };

  for (let i = 0; i < rounds.length; i += 1) {
    const round = rounds[i];
    const roundNumber = round.round_number;
    const scoreA = num(round.team_a_score_after);
    const scoreB = num(round.team_b_score_after);
    const beforeA = num(round.team_a_score_before);
    const beforeB = num(round.team_b_score_before);
    const winner = round.winner_team_key;
    const types = [];
    let score = 0;
    let title = "";
    let description = "";
    let tone = "blue";
    let playerName = null;

    const leader = scoreA > scoreB ? "a" : scoreB > scoreA ? "b" : null;
    const beforeLeader =
      beforeA > beforeB ? "a" : beforeB > beforeA ? "b" : null;

    if (isPistolRound(round)) {
      const isSidePistol =
        phaseMeta.halftimeRound != null &&
        roundNumber === phaseMeta.halftimeRound;
      types.push("pistol");
      score = Math.max(score, isSidePistol ? 52 : 42);
      title = isSidePistol ? "换边手枪局" : "手枪局";
    }

    const upset = economy.upsetRounds.find(
      (item) => item.roundNumber === roundNumber,
    );
    if (upset) {
      const type = upset.isForceUpset ? "force_upset" : "economy_upset";
      types.push(type);
      score = Math.max(score, 80);
      title = upset.isForceUpset ? "强起翻盘" : "经济翻盘";
      tone = "amber";
      if (upset.equipRatio <= 0.5) score += 8;
    }

    for (const event of playerEvents) {
      if (event.roundNumber !== roundNumber) continue;
      if (event.type === "ace") {
        types.push("ace");
        score = Math.max(score, 95);
        title = "ACE";
        playerName = event.playerName;
        tone = "accent";
      } else if (event.type === "multikill") {
        types.push("multikill");
        score = Math.max(score, 70);
        title = "四杀";
        playerName = event.playerName;
        tone = "accent";
      } else if (event.type === "clutch") {
        types.push("clutch");
        const opp = event.label?.includes("1v5")
          ? 5
          : event.label?.includes("1v4")
            ? 4
            : event.label?.includes("1v3")
              ? 3
              : 2;
        const clutchScore =
          opp >= 5 ? 95 : opp === 4 ? 90 : opp === 3 ? 85 : 78;
        score = Math.max(score, clutchScore);
        title = event.label || "残局";
        playerName = event.playerName;
        tone = "violet";
      }
    }

    for (const event of round.special_events || []) {
      if (event.type === "clutch" && event.won === true) {
        const opp = num(event.opponents);
        if (opp < 2) continue;
        types.push("clutch");
        const clutchScore =
          opp >= 5 ? 95 : opp === 4 ? 90 : opp === 3 ? 85 : 78;
        score = Math.max(score, clutchScore);
        title =
          opp >= 5
            ? `1v${opp} 残局`
            : opp === 4
              ? "1v4 残局"
              : opp === 3
                ? "1v3 残局"
                : "1v2 残局";
        playerName = event.player;
        tone = "violet";
      }
      if (event.type === "multikill") {
        const kills = num(event.kills);
        if (kills >= 5) {
          types.push("ace");
          score = Math.max(score, 95);
          title = "ACE";
        } else if (kills >= 4) {
          types.push("multikill");
          score = Math.max(score, 70);
          title = "四杀";
        }
        playerName = event.player;
        tone = "accent";
      }
    }

    if (roundNumber >= last30Threshold) {
      if (beforeLeader && leader && beforeLeader !== leader) {
        types.push("lead_change");
        score = Math.max(score, 78);
        if (!title) title = "关键反超";
        score += 12;
      } else if (beforeA !== beforeB && scoreA === scoreB) {
        types.push("tie");
        score = Math.max(score, 72);
        if (!title) title = "关键追平";
        score += 8;
      }
    }

    const streakFromHere = getStreakStartingAt(rounds, roundNumber);
    if (streakFromHere.length >= 5) {
      types.push("streak_start");
      score = Math.max(score, 74);
      if (!title) title = "连胜起点";
    } else if (streakFromHere.length >= 4) {
      types.push("streak_start");
      score = Math.max(score, 66);
      if (!title) title = "连胜起点";
    }

    if (winner === "a" || winner === "b") {
      if (
        winStreak.teamKey &&
        winStreak.teamKey !== winner &&
        winStreak.length >= 4
      ) {
        types.push("streak_end");
        score = Math.max(score, 64);
        if (!title) title = "终结连胜";
      }
      if (winStreak.teamKey === winner) {
        winStreak = { teamKey: winner, length: winStreak.length + 1 };
      } else {
        winStreak = { teamKey: winner, length: 1 };
      }
    }

    const maxScore = Math.max(scoreA, scoreB);
    if (
      maxScore >= regulationTarget - 1 &&
      leader &&
      match.state === "completed"
    ) {
      types.push("match_point");
      score = Math.max(score, 50);
      if (!title) title = "赛点回合";
    }

    if (roundNumber === stats.turningRound && stats.winnerMaxDeficit >= 3) {
      types.push("lead_change");
      score = Math.max(score, 82);
      if (!title) title = "走势转折";
      tone = "amber";
    }

    if (roundNumber >= lateThreshold) score += 8;

    if (types.length > 0) {
      if (!description) {
        const winnerName = teamName(data, winner);
        if (playerName && title) {
          description = `${playerName} 完成${title}，帮助 ${winnerName} 拿下本回合`;
        } else if (types.includes("force_upset")) {
          description = `${winnerName} 强起翻盘`;
        } else if (types.includes("economy_upset")) {
          description = `${winnerName} 经济翻盘`;
        } else if (types.includes("streak_start") && streakFromHere.length >= 4) {
          description = `${winnerName} 开启后续连胜`;
        } else {
          description = `${winnerName} 拿下本回合`;
        }
      }
      candidates.push({
        roundNumber,
        score,
        scoreA,
        scoreB,
        primaryType: types[0],
        types,
        title,
        description,
        tone,
        timestamp: formatRoundTimestamp(round, data, firstFreezeTick),
        playerName,
      });
    }
  }

  const lastRound = rounds[rounds.length - 1];
  const isFinalMatch = match.state === "completed" && match.winnerKey != null;
  candidates.push({
    roundNumber: lastRound.round_number,
    score: 100,
    scoreA: num(lastRound.team_a_score_after, match.scoreA),
    scoreB: num(lastRound.team_b_score_after, match.scoreB),
    primaryType: "final",
    types: ["final"],
    title: isFinalMatch ? "终结比赛" : "当前最后回合",
    description: isFinalMatch
      ? `比赛在 R${lastRound.round_number} 结束，最终比分 ${match.scoreA}:${match.scoreB}。`
      : `Demo 在 R${lastRound.round_number} 结束，当前比分 ${match.scoreA}:${match.scoreB}。`,
    tone: isFinalMatch ? "accent" : "blue",
    timestamp: formatRoundTimestamp(lastRound, data, firstFreezeTick),
    playerName: null,
  });

  return candidates;
}

function selectKeyRounds(candidates) {
  const byRound = new Map();
  for (const candidate of candidates) {
    const existing = byRound.get(candidate.roundNumber);
    if (!existing || candidate.score > existing.score) {
      byRound.set(candidate.roundNumber, {
        ...candidate,
        types: [...new Set([...(existing?.types || []), ...candidate.types])],
      });
    } else if (existing) {
      existing.types = [...new Set([...existing.types, ...candidate.types])];
      existing.score = Math.max(existing.score, candidate.score);
    }
  }

  const merged = [...byRound.values()];
  const finalRound = Math.max(...merged.map((item) => item.roundNumber));
  const finalEntry = merged.find(
    (item) =>
      item.roundNumber === finalRound && item.types.includes("final"),
  );
  const others = merged.filter(
    (item) =>
      item.roundNumber !== finalRound || !item.types.includes("final"),
  );

  others.sort((a, b) => b.score - a.score);

  const selected = [];
  let economyCount = 0;
  let pistolCount = 0;
  let personalCount = 0;
  const personalTypes = new Set(["ace", "multikill", "clutch"]);

  for (const item of others) {
    if (selected.length >= 4) break;

    // Pistol quota full: strip pistol type but keep the round if it still
    // has other valuable types (ace / economy / clutch / etc.).
    let types = [...item.types];
    if (types.includes("pistol") && pistolCount >= 1) {
      types = types.filter((t) => t !== "pistol");
      if (types.length === 0) continue;
    }

    const isEconomy = types.some(
      (t) => t === "economy_upset" || t === "force_upset",
    );
    const isPistol = types.includes("pistol");
    const isPersonal = types.some((t) => personalTypes.has(t));

    if (isEconomy && economyCount >= 2) continue;
    if (isPersonal && personalCount >= 2) continue;

    selected.push({ ...item, types });
    if (isEconomy) economyCount += 1;
    if (isPistol) pistolCount += 1;
    if (isPersonal) personalCount += 1;
  }

  const result = finalEntry ? [...selected, finalEntry] : selected;
  result.sort((a, b) => a.roundNumber - b.roundNumber);
  return result.slice(0, 5);
}

function buildKeyRounds(
  rounds,
  data,
  match,
  phaseMeta,
  stats,
  economy,
  playerEvents,
) {
  if (!rounds.length) return [];
  const candidates = buildKeyRoundCandidates(
    rounds,
    data,
    match,
    phaseMeta,
    stats,
    economy,
    playerEvents,
  );
  return selectKeyRounds(candidates);
}

function emptyEconomy() {
  return {
    pistol: {
      teamA: {
        wins: 0,
        conversionWins: 0,
        conversionTotal: 0,
        conversionRate: null,
        sampleTooSmall: true,
        postWinStreaks: [],
      },
      teamB: {
        wins: 0,
        conversionWins: 0,
        conversionTotal: 0,
        conversionRate: null,
        sampleTooSmall: true,
        postWinStreaks: [],
      },
    },
    conversions: {
      teamA: {
        wins: 0,
        conversionWins: 0,
        conversionTotal: 0,
        conversionRate: null,
        sampleTooSmall: true,
        postWinStreaks: [],
      },
      teamB: {
        wins: 0,
        conversionWins: 0,
        conversionTotal: 0,
        conversionRate: null,
        sampleTooSmall: true,
        postWinStreaks: [],
      },
    },
    upsetRounds: [],
    keyRound: null,
    summary: "本场未产生明显经济翻盘回合",
    hasData: false,
  };
}

function emptyOpening() {
  return {
    teamA: emptyTeamOpening(),
    teamB: emptyTeamOpening(),
    summary: "当前 Demo 未提供可用于统计的首杀事件。",
    hasData: false,
  };
}

function emptyObjective() {
  return {
    teamA: {
      plants: 0,
      plantWins: 0,
      plantWinRate: null,
      defuses: 0,
      explodeWins: 0,
    },
    teamB: {
      plants: 0,
      plantWins: 0,
      plantWinRate: null,
      defuses: 0,
      explodeWins: 0,
    },
    siteA: 0,
    siteB: 0,
    summary: "本场没有可识别的下包事件。",
    dominantSite: null,
    hasData: false,
  };
}

export function buildOverviewModel(data) {
  const rounds = normalizeRounds(data);
  const phaseMeta = detectPhaseMeta(data, rounds);
  const match = buildMatchState(data, rounds, phaseMeta);
  const stats = computeRoundStats(rounds, phaseMeta, match);
  const sidePerformance = buildSidePerformance(rounds, phaseMeta, data);

  const economy = rounds.length
    ? buildEconomy(rounds, data, phaseMeta, stats)
    : emptyEconomy();
  const opening = rounds.length ? buildOpening(rounds, data) : emptyOpening();
  const objective = rounds.length
    ? buildObjective(rounds, data)
    : emptyObjective();
  const playerEvents = rounds.length ? buildPlayerEvents(rounds, data) : [];
  const keyRounds = buildKeyRounds(
    rounds,
    data,
    match,
    phaseMeta,
    stats,
    economy,
    playerEvents,
  );

  return {
    match,
    phaseMeta,
    mainline: buildMainline(data, match, phaseMeta, stats, sidePerformance),
    trend: buildTrend(rounds, phaseMeta, stats, match),
    sidePerformance,
    economy,
    opening,
    objective,
    playerEvents,
    keyRounds,
  };
}
