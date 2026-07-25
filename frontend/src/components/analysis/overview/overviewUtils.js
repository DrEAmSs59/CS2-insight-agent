export function num(value, fallback = 0) {
  const result = Number(value);
  return Number.isFinite(result) ? result : fallback;
}

export function ratio(numerator, denominator) {
  return denominator > 0 ? numerator / denominator : 0;
}

export function percent(numerator, denominator, digits = 0) {
  return `${(ratio(numerator, denominator) * 100).toFixed(digits)}%`;
}

export function normalizeRounds(data) {
  return [...(data?.rounds || [])]
    .filter((round) => Number(round?.round_number) > 0)
    .sort((a, b) => Number(a.round_number) - Number(b.round_number));
}

export function buildPlayerTeamMap(players) {
  const map = new Map();
  for (const player of players || []) {
    if (player?.name) {
      map.set(String(player.name).trim().toLowerCase(), player.team_key);
    }
  }
  return map;
}

export function isValidEnemyKill(event, playerTeamMap) {
  if (event?.type !== "kill") return false;
  const { actor, target } = event;
  if (!actor || actor === target || actor === "World") return false;
  const actorTeam = playerTeamMap.get(String(actor).trim().toLowerCase());
  const targetTeam = playerTeamMap.get(String(target).trim().toLowerCase());
  if (!actorTeam || !targetTeam) return false;
  return actorTeam !== targetTeam;
}

export function detectPhaseMeta(data, rounds) {
  const sortedRounds = [...rounds]
    .filter((round) => Number(round?.round_number) > 0)
    .sort((a, b) => Number(a.round_number) - Number(b.round_number));

  const phaseMeta = data?.phase_meta;
  let halftimeRound = null;
  let regulationEndRound = null;

  if (phaseMeta?.halftime_round != null) {
    halftimeRound = num(phaseMeta.halftime_round, null);
    regulationEndRound =
      phaseMeta.regulation_end_round != null
        ? num(phaseMeta.regulation_end_round, null)
        : halftimeRound > 1
          ? (halftimeRound - 1) * 2
          : null;
  } else {
    const firstSide = sortedRounds[0]?.team_a_side;
    const hasSideData = sortedRounds.some((r) => r.team_a_side != null);

    if (hasSideData && firstSide != null) {
      const flipRound = sortedRounds.find(
        (r, idx) => idx > 0 && r.team_a_side != null && r.team_a_side !== firstSide,
      );
      if (flipRound) {
        halftimeRound = flipRound.round_number;
        if (halftimeRound > 1) {
          regulationEndRound = (halftimeRound - 1) * 2;
        }
      }
    }

    if (halftimeRound == null && !hasSideData) {
      return {
        halftimeRound: null,
        regulationEndRound: null,
        firstHalfRounds: sortedRounds,
        secondHalfRounds: [],
        overtimeRounds: [],
      };
    }
  }

  let firstHalfRounds = [];
  let secondHalfRounds = [];
  let overtimeRounds = [];

  if (halftimeRound != null && regulationEndRound != null) {
    firstHalfRounds = sortedRounds.filter(
      (r) => r.round_number >= 1 && r.round_number < halftimeRound,
    );
    secondHalfRounds = sortedRounds.filter(
      (r) => r.round_number >= halftimeRound && r.round_number <= regulationEndRound,
    );
    overtimeRounds = sortedRounds.filter((r) => r.round_number > regulationEndRound);
  } else if (halftimeRound != null) {
    firstHalfRounds = sortedRounds.filter(
      (r) => r.round_number >= 1 && r.round_number < halftimeRound,
    );
    secondHalfRounds = sortedRounds.filter((r) => r.round_number >= halftimeRound);
  } else {
    firstHalfRounds = sortedRounds;
  }

  return {
    halftimeRound,
    regulationEndRound,
    firstHalfRounds,
    secondHalfRounds,
    overtimeRounds,
  };
}
