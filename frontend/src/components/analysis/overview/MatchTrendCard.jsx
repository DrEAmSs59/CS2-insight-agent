import { Activity } from "lucide-react";
import InsightCard from "./InsightCard";

/** 相对原尺寸等比放大约 20% */
const W = 432;
const H = 144;
/** 纵轴线贴 SVG 左缘；刻度写在轴右侧，避免挤占队名间距 */
const AXIS_X = 1;
const PLOT_LEFT = 28;
const PAD_RIGHT = 10;
const PAD_Y = 22;
const CHART_HEIGHT_PX = 134;
const CHART_HEIGHT_CLASS = "h-[134px]";
/** 按 viewBox 比例算出 SVG 宽度，避免 meet 留白导致整体偏左 */
const SVG_WIDTH_PX = Math.round(CHART_HEIGHT_PX * (W / H));
/** 队名右缘到纵坐标轴线的间距 */
const TEAM_AXIS_GAP_PX = 3;

function leadColor(lead) {
  if (lead > 0) return "#38bdf8";
  if (lead < 0) return "#fbbf24";
  return "#64748b";
}

function buildAnnotations(points, phaseMeta) {
  if (!points.length) return [];
  const first = points[0];
  const last = points[points.length - 1];
  const byRound = new Map(points.map((p) => [p.roundNumber, p]));
  const annotations = [];

  // Prefer explicit kickoff (0:0); otherwise first point.
  const kickoff = points.find((p) => p.isKickoff) || first;
  annotations.push({ roundNumber: kickoff.roundNumber, label: "开局", point: kickoff });

  const half = phaseMeta?.halftimeRound;
  if (
    half != null &&
    byRound.has(half) &&
    half !== kickoff.roundNumber &&
    half !== last.roundNumber
  ) {
    annotations.push({ roundNumber: half, label: "换边", point: byRound.get(half) });
  }

  const otStart =
    phaseMeta?.regulationEndRound != null
      ? phaseMeta.regulationEndRound + 1
      : phaseMeta?.overtimeRounds?.[0]?.round_number;
  if (
    otStart != null &&
    byRound.has(otStart) &&
    otStart !== kickoff.roundNumber &&
    otStart !== last.roundNumber &&
    otStart !== half
  ) {
    annotations.push({ roundNumber: otStart, label: "加时", point: byRound.get(otStart) });
  }

  if (last.roundNumber !== kickoff.roundNumber) {
    annotations.push({ roundNumber: last.roundNumber, label: "终局", point: last });
  }

  return annotations;
}

function yAxisTicks(maxAbs) {
  if (maxAbs <= 1) return [-1, 0, 1];
  if (maxAbs <= 3) return [-maxAbs, -1, 0, 1, maxAbs].filter((v, i, arr) => arr.indexOf(v) === i);
  const mid = Math.round(maxAbs / 2);
  return [-maxAbs, -mid, 0, mid, maxAbs].filter((v, i, arr) => arr.indexOf(v) === i);
}

function LeadChart({ points, phaseMeta, teamAName, teamBName }) {
  if (points.length < 2) {
    return (
      <p className={`flex ${CHART_HEIGHT_CLASS} items-center justify-center text-[11px] text-cs2-text-muted`}>
        当前解析结果不足以生成比赛走势。
      </p>
    );
  }

  const leads = points.map((p) => Number(p.lead) || 0);
  const maxAbs = Math.max(1, ...leads.map((v) => Math.abs(v)));
  const xSpan = Math.max(1, points.length - 1);
  const plotW = W - PLOT_LEFT - PAD_RIGHT;
  const toX = (index) => PLOT_LEFT + (index / xSpan) * plotW;
  const toY = (lead) => {
    const mid = H / 2;
    const amp = (H - PAD_Y * 2) / 2;
    return mid - (lead / maxAbs) * amp;
  };
  const annotations = buildAnnotations(points, phaseMeta);
  const annRounds = new Set(annotations.map((a) => a.roundNumber));
  const ticks = yAxisTicks(maxAbs);

  return (
    <div className={`flex w-full shrink-0 justify-center ${CHART_HEIGHT_CLASS}`}>
      <div className="flex h-full items-stretch" style={{ gap: TEAM_AXIS_GAP_PX }}>
        {/* 队名紧贴纵坐标左侧 3px，上/下半区垂直居中，完整显示 */}
        <div className="flex shrink-0 flex-col">
          <div className="flex flex-1 items-center justify-end">
            <span className="whitespace-nowrap text-right text-[9px] font-bold leading-none text-sky-400">
              {teamAName}
            </span>
          </div>
          <div className="flex flex-1 items-center justify-end">
            <span className="whitespace-nowrap text-right text-[9px] font-bold leading-none text-amber-400">
              {teamBName}
            </span>
          </div>
        </div>

        <svg
          width={SVG_WIDTH_PX}
          height={CHART_HEIGHT_PX}
          viewBox={`0 0 ${W} ${H}`}
          preserveAspectRatio="xMidYMid meet"
          className="shrink-0"
          role="img"
          aria-label="比赛走势折线"
        >
        {/* Y axis flush to SVG left → team names sit 3px away */}
        <line
          x1={AXIS_X}
          y1={PAD_Y}
          x2={AXIS_X}
          y2={H - PAD_Y}
          stroke="currentColor"
          strokeOpacity="0.35"
          strokeWidth="1"
          className="text-cs2-text-muted"
        />
        {ticks.map((tick) => {
          const y = toY(tick);
          return (
            <g key={`ytick-${tick}`}>
              <line
                x1={AXIS_X}
                y1={y}
                x2={W - PAD_RIGHT}
                y2={y}
                stroke="currentColor"
                strokeOpacity={tick === 0 ? 0.35 : 0.12}
                strokeWidth={tick === 0 ? 1.25 : 1}
                className="text-cs2-text-muted"
              />
              <text
                x={AXIS_X + 4}
                y={y + 3.5}
                textAnchor="start"
                className="fill-cs2-text-muted"
                fontSize="10"
              >
                {tick > 0 ? `+${tick}` : tick}
              </text>
            </g>
          );
        })}

        {points.slice(1).map((point, i) => {
          const prev = points[i];
          return (
            <line
              key={`${prev.roundNumber}-${point.roundNumber}`}
              x1={toX(i)}
              y1={toY(prev.lead)}
              x2={toX(i + 1)}
              y2={toY(point.lead)}
              stroke={leadColor(point.lead)}
              strokeWidth="2.4"
              strokeLinecap="round"
            />
          );
        })}
        {points.map((point, index) => {
          const x = toX(index);
          const y = toY(point.lead);
          const isAnn = annRounds.has(point.roundNumber);
          return (
            <circle
              key={`pt-${point.roundNumber}-${index}`}
              cx={x}
              cy={y}
              r={isAnn ? 4 : 2.2}
              fill={leadColor(point.lead)}
            />
          );
        })}
        {annotations.map((ann) => {
          const index = points.findIndex((p) => p.roundNumber === ann.roundNumber);
          if (index < 0) return null;
          const x = toX(index);
          const y = toY(ann.point.lead);
          const labelAbove = y >= H / 2;
          return (
            <text
              key={`ann-${ann.roundNumber}`}
              x={x}
              y={labelAbove ? y - 10 : y + 16}
              textAnchor={index === 0 ? "start" : "middle"}
              className="fill-cs2-text-secondary"
              fontSize="11"
              fontWeight="600"
            >
              {ann.label}
            </text>
          );
        })}
        </svg>
      </div>
    </div>
  );
}

/**
 * @param {{
 *   model?: object,
 *   phaseMeta?: object,
 *   teamAName?: string,
 *   teamBName?: string,
 *   className?: string,
 * }} props
 */
export default function MatchTrendCard({
  model,
  phaseMeta,
  teamAName = "Team A",
  teamBName = "Team B",
  className = "",
}) {
  const points = Array.isArray(model?.points) ? model.points : [];
  const stage = model?.stageScores || {};
  const streak = model?.longestStreak || {};
  const hasOt = Boolean(model?.hasOvertime || stage.overtime?.a || stage.overtime?.b);
  const maxLeadA = Number(model?.maxLeadA || 0);
  const maxLeadB = Number(model?.maxLeadB || 0);
  const maxLead = Math.max(maxLeadA, maxLeadB);
  const maxLeadTeam = maxLeadA >= maxLeadB ? teamAName : teamBName;
  const deficit = Math.max(maxLeadA, maxLeadB);

  const streakText =
    streak.length > 0 && (streak.teamKey === "a" || streak.teamKey === "b")
      ? `${streak.length}`
      : "—";

  const summaryParts = [
    `上半场 ${stage.firstHalf?.a ?? 0}:${stage.firstHalf?.b ?? 0}`,
    `下半场 ${stage.secondHalf?.a ?? 0}:${stage.secondHalf?.b ?? 0}`,
  ];
  if (hasOt) {
    summaryParts.push(`加时 ${stage.overtime?.a ?? 0}:${stage.overtime?.b ?? 0}`);
  }
  if (deficit > 0) {
    const loserLead = maxLeadA >= maxLeadB ? maxLeadB : maxLeadA;
    if (loserLead === 0 && maxLead > 0) {
      summaryParts.push(`最大领先 ${maxLead}`);
    } else if (maxLeadA !== maxLeadB) {
      summaryParts.push(`${maxLeadTeam} 最大领先 ${maxLead}`);
    } else {
      summaryParts.push(`最大领先 ${maxLead}`);
    }
  }
  if (streak.length > 0) {
    summaryParts.push(`最长连胜 ${streakText}`);
  }

  const underTitle =
    points.length < 2 && model?.summary ? model.summary : summaryParts.join(" · ");

  return (
    <InsightCard
      title="比赛走势"
      icon={<Activity className="h-3.5 w-3.5 text-sky-400" />}
      compact
      className={className}
    >
      <p className="mb-1.5 shrink-0 truncate text-[10px] leading-relaxed text-cs2-text-muted">
        {underTitle}
      </p>
      <LeadChart
        points={points}
        phaseMeta={phaseMeta}
        teamAName={teamAName}
        teamBName={teamBName}
      />
      <div className="mt-1.5 flex shrink-0 flex-wrap items-center gap-x-3 gap-y-1 text-[9px] text-cs2-text-muted">
        <span className="inline-flex items-center gap-1">
          <span className="h-1.5 w-1.5 rounded-full bg-sky-400" />
          蓝线 / 上方 = {teamAName} 领先
        </span>
        <span className="inline-flex items-center gap-1">
          <span className="h-1.5 w-1.5 rounded-full bg-amber-400" />
          黄线 / 下方 = {teamBName} 领先
        </span>
      </div>
    </InsightCard>
  );
}
