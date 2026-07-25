import { Activity } from "lucide-react";
import InsightCard from "./InsightCard";

const W = 280;
const H = 88;
const PAD_X = 10;
const PAD_Y = 10;

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

  annotations.push({ roundNumber: first.roundNumber, label: "开局", point: first });

  const half = phaseMeta?.halftimeRound;
  if (half != null && byRound.has(half) && half !== first.roundNumber && half !== last.roundNumber) {
    annotations.push({ roundNumber: half, label: "换边", point: byRound.get(half) });
  }

  const otStart =
    phaseMeta?.regulationEndRound != null
      ? phaseMeta.regulationEndRound + 1
      : phaseMeta?.overtimeRounds?.[0]?.round_number;
  if (
    otStart != null &&
    byRound.has(otStart) &&
    otStart !== first.roundNumber &&
    otStart !== last.roundNumber &&
    otStart !== half
  ) {
    annotations.push({ roundNumber: otStart, label: "加时", point: byRound.get(otStart) });
  }

  if (last.roundNumber !== first.roundNumber) {
    annotations.push({ roundNumber: last.roundNumber, label: "终局", point: last });
  }

  return annotations;
}

function LeadChart({ points, phaseMeta }) {
  if (points.length < 2) {
    return (
      <p className="py-4 text-center text-[11px] text-cs2-text-muted">
        当前解析结果不足以生成比赛走势。
      </p>
    );
  }

  const leads = points.map((p) => Number(p.lead) || 0);
  const maxAbs = Math.max(1, ...leads.map((v) => Math.abs(v)));
  const xSpan = Math.max(1, points.length - 1);
  const toX = (index) => PAD_X + (index / xSpan) * (W - PAD_X * 2);
  const toY = (lead) => {
    const mid = H / 2;
    const amp = (H - PAD_Y * 2) / 2;
    return mid - (lead / maxAbs) * amp;
  };
  const annotations = buildAnnotations(points, phaseMeta);

  return (
    <svg viewBox={`0 0 ${W} ${H}`} className="h-[88px] w-full" role="img" aria-label="比赛走势折线">
      <line
        x1={PAD_X}
        y1={H / 2}
        x2={W - PAD_X}
        y2={H / 2}
        stroke="currentColor"
        strokeOpacity="0.2"
        strokeWidth="1"
        className="text-cs2-text-muted"
      />
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
            strokeWidth="2"
            strokeLinecap="round"
          />
        );
      })}
      {annotations.map((ann) => {
        const index = points.findIndex((p) => p.roundNumber === ann.roundNumber);
        if (index < 0) return null;
        const x = toX(index);
        const y = toY(ann.point.lead);
        return (
          <g key={`ann-${ann.roundNumber}`}>
            <circle cx={x} cy={y} r="2.5" fill={leadColor(ann.point.lead)} />
            <text
              x={x}
              y={y < H / 2 ? y - 6 : y + 12}
              textAnchor="middle"
              className="fill-cs2-text-muted"
              fontSize="8"
            >
              {ann.label}
            </text>
          </g>
        );
      })}
    </svg>
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

  const footerParts = [
    `上半场 ${stage.firstHalf?.a ?? 0}:${stage.firstHalf?.b ?? 0}`,
    `下半场 ${stage.secondHalf?.a ?? 0}:${stage.secondHalf?.b ?? 0}`,
  ];
  if (hasOt) {
    footerParts.push(`加时 ${stage.overtime?.a ?? 0}:${stage.overtime?.b ?? 0}`);
  }
  if (deficit > 0) {
    const loserLead = maxLeadA >= maxLeadB ? maxLeadB : maxLeadA;
    if (loserLead === 0 && maxLead > 0) {
      footerParts.push(`最大领先 ${maxLead}`);
    } else if (maxLeadA !== maxLeadB) {
      footerParts.push(`${maxLeadTeam} 最大领先 ${maxLead}`);
    } else {
      footerParts.push(`最大领先 ${maxLead}`);
    }
  }
  if (streak.length > 0) {
    footerParts.push(`最长连胜 ${streakText}`);
  }

  return (
    <InsightCard
      title="比赛走势"
      icon={<Activity className="h-3.5 w-3.5 text-sky-400" />}
      compact
      className={`h-full min-h-[180px] xl:min-h-[190px] ${className}`}
    >
      {model?.summary && points.length < 2 ? (
        <p className="mb-2 text-[11px] text-cs2-text-muted">{model.summary}</p>
      ) : null}
      <LeadChart points={points} phaseMeta={phaseMeta} />
      <p className="mt-1.5 truncate text-[10px] leading-relaxed text-cs2-text-muted">
        {footerParts.join(" · ")}
      </p>
    </InsightCard>
  );
}
