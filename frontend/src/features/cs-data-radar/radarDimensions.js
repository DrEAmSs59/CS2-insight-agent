/**
 * cs数据图 六维雷达模型 — 与 Rock-Radar-main 的绘制结构对齐。
 * 满分基准线（蓝色外圈 = 最高刻度）：
 *   KPR 0.85 · Surviving 44% · ADR 85 · KAST 78% · Multi-kill 20% · Rating 1.3
 *
 * DIM_NAMES / BASE_MAX_SCORES / MIN_SCORES / USE_PERCENTAGE 逐维度控制
 * 绘制基准；deriveRadarStats 基于对局解析（workspace.players）自动推导
 * 各维度取值，供前端 Canvas 预览与合辑导出前的再渲染使用。
 */

export const RADAR_DIMENSIONS = [
  { key: "kpr", name: "KPR", labelZh: "回合击杀", maxScore: 0.85, minScore: 0, percentage: false },
  { key: "survival_rate", name: "Surviving", labelZh: "存活率", maxScore: 0.44, minScore: 0, percentage: true },
  { key: "adr", name: "ADR", labelZh: "回合伤害", maxScore: 85, minScore: 0, percentage: false },
  { key: "kast", name: "KAST", labelZh: "不白给率", maxScore: 0.78, minScore: 0, percentage: true },
  { key: "multi_kill", name: "Multi-kill", labelZh: "多杀回合", maxScore: 0.2, minScore: 0, percentage: true },
  { key: "rating", name: "Rating", labelZh: "评级", maxScore: 1.3, minScore: 0, percentage: false },
];

function num(value, fallback = 0) {
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
}

/**
 * 从对局解析的玩家数据推导六维雷达取值（自动读取解析后数据）。
 * @param {Record<string, unknown>} stats — workspace.players 行
 */
export function deriveRadarStats(stats) {
  const s = stats && typeof stats === "object" ? stats : {};
  const kills = num(s.kills);
  const deaths = num(s.deaths);
  const assists = num(s.assists);
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

  const apr = assists / rounds;
  // Multi-kill（多杀回合）：2 杀及以上回合数 ÷ 总回合数
  const multiKillRounds =
    num(s.two_kill_rounds) + num(s.three_kill_rounds) + num(s.four_kill_rounds) + num(s.five_kill_rounds);
  const multiKill = Math.min(1, multiKillRounds / rounds);

  const impact = 2.13 * kpr + 0.42 * apr - 0.41; // 仅用于 Rating 公式，不作为展示维度
  const hasData = kills > 0 || deaths > 0 || assists > 0 || kpr > 0 || dpr > 0 || adr > 0;
  const rating = hasData
    ? 0.3591 * kpr - 0.5329 * dpr + 0.2372 * impact + 0.0032 * adr + 0.1587
    : 0;

  const clamp = (v) => Math.max(0, Number(v.toFixed(2)));
  return {
    kpr: clamp(kpr),
    survival_rate: clamp(survival),
    adr: Math.max(0, Number(adr.toFixed(1))),
    kast: clamp(kast),
    multi_kill: clamp(multiKill),
    rating: clamp(rating),
  };
}

/** 归一化上限：超过满分刻度的数据允许溢出到蓝色外圈之外，上限 1.6 防止极端值跑出画布。 */
export const NORMALIZE_CEILING = 1.6;

/** 六维归一化取值（相对各自满分刻度；超过满分可溢出外圈，仅限 1.6），用于绘制顶点。 */
export function normalizeRadarValues(radar) {
  return RADAR_DIMENSIONS.map((dim) => {
    const raw = num(radar?.[dim.key]);
    const span = Math.max(0.0001, dim.maxScore - dim.minScore);
    return Math.max(0, Math.min(NORMALIZE_CEILING, (raw - dim.minScore) / span));
  });
}

/** 六维归一化平均值 —— 中心红色小六边形的半径比例。 */
export function averageRadarValue(radar) {
  const values = normalizeRadarValues(radar);
  return Number((values.reduce((a, b) => a + b, 0) / Math.max(1, values.length)).toFixed(3));
}

/** 按维度配置格式化展示文本（百分数 / 小数）。 */
export function formatRadarValue(key, value) {
  const dim = RADAR_DIMENSIONS.find((d) => d.key === key);
  const v = num(value);
  if (!dim) return v.toFixed(2);
  if (dim.percentage) return `${Math.round(v * 100)}%`;
  const digits = key === "kpr" || key === "rating" ? 2 : key === "adr" ? 1 : 0;
  return v.toFixed(digits);
}

/** 六维构成的紧凑展示行（合辑编排 / 预览用）。 */
export function radarCompositionLine(radar) {
  return RADAR_DIMENSIONS.map((dim) => `${dim.name} ${formatRadarValue(dim.key, radar?.[dim.key])}`).join(" · ");
}

/** 全场均值基准线：本场全部玩家六维平均值归一化后的整体水平（红色六边形标注值）。 */
export function matchAvgRadarValue(matchAvgRadar) {
  if (!matchAvgRadar || typeof matchAvgRadar !== "object") return null;
  const values = normalizeRadarValues(matchAvgRadar);
  return Number((values.reduce((a, b) => a + b, 0) / Math.max(1, values.length)).toFixed(3));
}

/**
 * 该玩家整体水平相对全场均值：1 = 高于全场，0 = 持平，-1 = 低于全场。
 * @param {object} radar 该玩家六维取值
 * @param {object} matchAvgRadar 全场均值
 */
export function compareToMatchAvg(radar, matchAvgRadar) {
  const player = averageRadarValue(radar);
  const match = matchAvgRadarValue(matchAvgRadar);
  if (match == null) return 0;
  const delta = player - match;
  if (Math.abs(delta) < 0.02) return 0;
  return delta > 0 ? 1 : -1;
}
