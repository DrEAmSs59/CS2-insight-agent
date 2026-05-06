import {
  classifyDemoStatus,
  formatDurationMinutesPlain,
  formatLibraryAddedAt,
  formatScoreLine,
} from "./demoLibraryDisplay";

/** @param {Record<string, unknown>} item */
export function canLikelyPreviewScoreboard(item) {
  const st = String(item.status ?? "").toLowerCase();
  if (st === "error") return false;
  const hasResult = item.result && typeof item.result === "object";
  const hasHeader =
    !!(item.map_name && String(item.map_name).trim()) ||
    (item.total_rounds != null && Number.isFinite(Number(item.total_rounds)));
  return Boolean(hasResult || hasHeader || st === "done" || st === "parsed");
}

/**
 * @param {number | string | null | undefined} k
 * @param {number | string | null | undefined} d
 */
export function computeKd(k, d) {
  const kk = Number(k);
  const dd = Number(d);
  const nk = Number.isFinite(kk) ? kk : 0;
  const nd = Number.isFinite(dd) ? dd : 0;
  return (nk / Math.max(nd, 1)).toFixed(2);
}

/**
 * @param {Record<string, unknown>} raw
 */
function normalizePlayer(raw) {
  const name =
    String(raw.player_name ?? raw.name ?? raw.persona_name ?? raw.nickname ?? "Unknown").trim() || "Unknown";
  const kills = Number(raw.kills ?? raw.k ?? 0);
  const deaths = Number(raw.deaths ?? raw.d ?? 0);
  const assists = Number(raw.assists ?? raw.a ?? 0);
  const kdRaw = raw.kd != null ? Number(raw.kd) : null;
  const kd =
    kdRaw != null && Number.isFinite(kdRaw)
      ? Number(kdRaw).toFixed(2)
      : computeKd(Number.isFinite(kills) ? kills : 0, Number.isFinite(deaths) ? deaths : 0);
  const adrRaw = raw.adr ?? raw.damage_avg ?? raw.avg_damage_round;
  const adr = adrRaw != null && Number.isFinite(Number(adrRaw)) ? Number(adrRaw) : undefined;
  const ratingRaw = raw.rating ?? raw.hltv_rating;
  const rating =
    ratingRaw != null && Number.isFinite(Number(ratingRaw)) ? Number(Number(ratingRaw).toFixed(2)) : undefined;
  const steam =
    raw.steam_id64 != null && String(raw.steam_id64).trim()
      ? String(raw.steam_id64).trim()
      : raw.steam_id != null && String(raw.steam_id).trim()
        ? String(raw.steam_id).trim()
        : "";
  let teamNum = null;
  if (raw.team_number != null && Number.isFinite(Number(raw.team_number))) teamNum = Number(raw.team_number);
  else if (raw.team != null && Number.isFinite(Number(raw.team))) teamNum = Number(raw.team);
  else if (raw.team_num != null && Number.isFinite(Number(raw.team_num))) teamNum = Number(raw.team_num);

  return {
    name,
    kills: Number.isFinite(kills) ? kills : 0,
    assists: Number.isFinite(assists) ? assists : 0,
    deaths: Number.isFinite(deaths) ? deaths : 0,
    kd,
    adr,
    rating,
    steam,
    teamNum,
    sortKey: Number.isFinite(kills) ? kills : 0,
  };
}

function sortPlayersDesc(arr) {
  return [...arr].sort((a, b) => b.sortKey - a.sortKey || a.name.localeCompare(b.name, "zh-CN"));
}

function takeFive(arr) {
  return sortPlayersDesc(arr).slice(0, 5);
}

/**
 * @param {Record<string, unknown>} item
 * @param {Record<string, unknown>[]} rawPlayers
 */
export function buildMiniScoreboardTeams(item, rawPlayers) {
  const r = item.result && typeof item.result === "object" ? item.result : null;
  const mm = r?.match_meta && typeof r.match_meta === "object" ? r.match_meta : {};
  const ta = item.team_a_score ?? mm.team_a_score;
  const tb = item.team_b_score ?? mm.team_b_score;
  const taN = ta != null && Number.isFinite(Number(ta)) ? Number(ta) : null;
  const tbN = tb != null && Number.isFinite(Number(tb)) ? Number(tb) : null;

  const players = Array.isArray(rawPlayers) ? rawPlayers.map(normalizePlayer) : [];

  if (players.length === 0) {
    return {
      left: { key: "empty", label: "—", score: null, players: [] },
      right: { key: "empty2", label: "—", score: null, players: [] },
      playersCount: 0,
    };
  }

  const has23 = players.some((p) => p.teamNum === 2 || p.teamNum === 3);

  if (has23) {
    /** 与 MatchScoreboard / PlayerSelect：左队伍 A = team 3 → team_b_score；右队伍 B = team 2 → team_a_score */
    const teamA = players.filter((p) => p.teamNum === 3);
    const teamB = players.filter((p) => p.teamNum === 2);
    return {
      left: { key: "a", label: "队伍 A", score: tbN, players: takeFive(teamA) },
      right: { key: "b", label: "队伍 B", score: taN, players: takeFive(teamB) },
      playersCount: players.length,
    };
  }

  const sorted = sortPlayersDesc(players);
  return {
    left: { key: "a", label: "队伍 A", score: taN, players: sorted.slice(0, 5) },
    right: { key: "b", label: "队伍 B", score: tbN, players: sorted.slice(5, 10) },
    playersCount: players.length,
  };
}

/**
 * @param {Record<string, unknown>} item
 */
export function buildScoreboardHeader(item) {
  const r = item.result && typeof item.result === "object" ? item.result : null;
  const mm = r?.match_meta && typeof r.match_meta === "object" ? r.match_meta : {};
  const map =
    (item.map_name && String(item.map_name).trim()) ||
    (mm.map_name && String(mm.map_name).trim()) ||
    "—";
  const roundsRaw = item.total_rounds ?? mm.total_rounds;
  const rounds =
    roundsRaw != null && Number.isFinite(Number(roundsRaw)) ? String(roundsRaw) : "—";
  const duration = formatDurationMinutesPlain(item.duration_mins ?? mm.duration_mins);
  const date = formatLibraryAddedAt(item.added_at);
  const score = formatScoreLine(item.team_a_score ?? mm.team_a_score, item.team_b_score ?? mm.team_b_score);
  const status = classifyDemoStatus(item);
  return { map, score, rounds, duration, date, statusLabel: status.label, statusKind: status.kind };
}

/**
 * @param {{ adr?: number; rating?: number }[]} players
 */
export function scoreboardHasOptionalAdr(players) {
  return players.some((p) => p.adr != null && Number.isFinite(p.adr));
}

/**
 * @param {{ rating?: number }[]} players
 */
export function scoreboardHasOptionalRating(players) {
  return players.some((p) => p.rating != null && Number.isFinite(p.rating));
}
