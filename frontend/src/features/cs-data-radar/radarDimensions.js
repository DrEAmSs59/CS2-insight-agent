/**
 * 数据雷达图六维模型 — 与后端 radar_model.py 对齐。
 * 满分基准线（蓝色外圈 = 最高刻度）：
 *   KPR 0.85 · Surviving 44% · ADR 85 · KAST 78% · Multi-kill 8 回合 · Rating 1.3
 */

export const RADAR_DIMENSIONS = [
  { key: "kpr", name: "KPR", labelZh: "场均击杀", maxScore: 0.85, minScore: 0, percentage: false, integer: false },
  { key: "survival_rate", name: "Surviving", labelZh: "生存率", maxScore: 0.44, minScore: 0, percentage: true, integer: false },
  { key: "adr", name: "ADR", labelZh: "场均伤害", maxScore: 85, minScore: 0, percentage: false, integer: false },
  { key: "kast", name: "KAST", labelZh: "团队贡献", maxScore: 0.78, minScore: 0, percentage: true, integer: false },
  { key: "multi_kill", name: "Multi-kill", labelZh: "多杀回合", maxScore: 8, minScore: 0, percentage: false, integer: true },
  { key: "rating", name: "Rating", labelZh: "综合评分", maxScore: 1.3, minScore: 0, percentage: false, integer: false },
];

function num(value, fallback = 0) {
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
}

/**
 * 从对局解析的玩家数据推导雷达取值。Rating 只有传入时才写入。
 * @param {Record<string, unknown>} stats — workspace.players 行
 * @param {number|string|null|undefined} rating — 手填评级
 */
export function deriveRadarStats(stats, rating) {
  const s = stats && typeof stats === "object" ? stats : {};
  const kills = num(s.kills);
  const deaths = num(s.deaths);
  let kpr = num(s.kpr);
  let dpr = num(s.dpr);
  const adr = num(s.adr);

  let rounds = num(s.rounds ?? s.total_rounds);
  if (rounds <= 0 && kpr > 0) rounds = kills / kpr;
  rounds = Math.max(1, rounds);
  if (kpr <= 0 && rounds > 0) kpr = kills / rounds;
  if (dpr <= 0 && rounds > 0) dpr = deaths / rounds;

  const kastRaw = num(s.kast);
  const kast = kastRaw > 1 ? kastRaw / 100 : kastRaw;
  const survRaw = num(s.survival_rate);
  const survival = survRaw > 1 ? survRaw / 100 : survRaw;

  const multiKillRounds =
    num(s.two_kill_rounds) + num(s.three_kill_rounds) + num(s.four_kill_rounds) + num(s.five_kill_rounds);

  const clamp = (v) => Math.max(0, Number(v.toFixed(2)));
  const out = {
    kpr: clamp(kpr),
    survival_rate: clamp(survival),
    adr: Math.max(0, Number(adr.toFixed(1))),
    kast: clamp(kast),
    multi_kill: Math.max(0, Math.round(multiKillRounds)),
  };
  if (rating !== undefined && rating !== null && String(rating).trim() !== "") {
    const parsed = Number(rating);
    if (Number.isFinite(parsed)) out.rating = clamp(parsed);
  }
  return out;
}

export function hasManualRating(radar) {
  if (!radar || typeof radar !== "object" || !Object.prototype.hasOwnProperty.call(radar, "rating")) {
    return false;
  }
  const value = radar.rating;
  if (value === undefined || value === null || String(value).trim() === "") return false;
  return Number.isFinite(Number(value));
}

export function activeRadarDimensions(radar) {
  if (hasManualRating(radar)) return RADAR_DIMENSIONS;
  return RADAR_DIMENSIONS.filter((dim) => dim.key !== "rating");
}

/** 归一化上限：超过满分刻度的数据允许溢出到蓝色外圈之外，上限 1.6 防止极端值跑出画布。 */
export const NORMALIZE_CEILING = 1.6;

/** 当前展示维度归一化取值（相对各自满分刻度；超过满分可溢出外圈，仅限 1.6）。 */
export function normalizeRadarValues(radar) {
  return activeRadarDimensions(radar).map((dim) => {
    const raw = num(radar?.[dim.key]);
    const span = Math.max(0.0001, dim.maxScore - dim.minScore);
    return Math.max(0, Math.min(NORMALIZE_CEILING, (raw - dim.minScore) / span));
  });
}

/** 六维归一化平均值。 */
export function averageRadarValue(radar) {
  const values = normalizeRadarValues(radar);
  return Number((values.reduce((a, b) => a + b, 0) / Math.max(1, values.length)).toFixed(3));
}

/** 按维度配置格式化展示文本（百分数 / 小数 / 整数）。 */
export function formatRadarValue(key, value) {
  const dim = RADAR_DIMENSIONS.find((d) => d.key === key);
  const v = num(value);
  if (!dim) return v.toFixed(2);
  if (dim.percentage) return `${Math.round(v * 100)}%`;
  if (dim.integer) return String(Math.round(v));
  const digits = key === "kpr" || key === "rating" ? 2 : key === "adr" ? 1 : 0;
  return v.toFixed(digits);
}

/** 六维构成的紧凑展示行（合辑编排 / 预览用）。 */
export function radarCompositionLine(radar) {
  return activeRadarDimensions(radar).map((dim) => `${dim.name} ${formatRadarValue(dim.key, radar?.[dim.key])}`).join(" · ");
}

/** 本局中位数多边形的整体水平。 */
export function matchAvgRadarValue(matchAvgRadar) {
  if (!matchAvgRadar || typeof matchAvgRadar !== "object") return null;
  const values = normalizeRadarValues(matchAvgRadar);
  return Number((values.reduce((a, b) => a + b, 0) / Math.max(1, values.length)).toFixed(3));
}

/**
 * 该玩家整体水平相对本局中位数：1 = 高于中位数，0 = 持平，-1 = 低于中位数。
 * @param {object} radar 该玩家六维取值
 * @param {object} matchAvgRadar 本局中位数
 */
export function compareToMatchAvg(radar, matchAvgRadar) {
  const player = averageRadarValue(radar);
  const match = matchAvgRadarValue(matchAvgRadar);
  if (match == null) return 0;
  const delta = player - match;
  if (Math.abs(delta) < 0.02) return 0;
  return delta > 0 ? 1 : -1;
}
