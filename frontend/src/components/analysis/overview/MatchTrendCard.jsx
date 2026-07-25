import { Activity } from "lucide-react";

const W = 280;
const H = 96;
const PAD_X = 10;
const PAD_Y = 12;

function leadColor(lead) {
  if (lead > 0) return "#38bdf8"; // sky-400
  if (lead < 0) return "#fbbf24"; // amber-400
  return "#64748b"; // slate-500
}

function buildAnnotations(points, phaseMeta) {
  if (!points.length) return [];
  const first = points[0];
  const last = points[points.length - 1];
  const byRound = new Map(points.map((p) => [p.roundNumber, p]));
  const annotations = [];

  annotations.push({
    roundNumber: first.roundNumber,
    label: "开局",
    point: first,
  });

  const half = phaseMeta?.halftimeRound;
  if (half != null && byRound.has(half) && half !== first.roundNumber && half !== last.roundNumber) {
    annotations.push({
      roundNumber: half,
      label: "换边",
      point: byRound.get(half),
    });
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
    annotations.push({
      roundNumber: otStart,
      label: "加时",
      point: byRound.get(otStart),
    });
  }

  if (last.roundNumber !== first.roundNumber) {
    annotations.push({
      roundNumber: last.roundNumber,
      label: "终局",
      point: last,
    });
  }

  return annotations;
}

function LeadChart({ points, phaseMeta }) {
  if (points.length < 2) {
    return (
      <p className="py-6 text-center text-[11px] text-cs2-text-muted">
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
    <svg viewBox={`0 0 ${W} ${H}`} className="h-24 w-full" role="img" aria-label="比赛走势折线">
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
 *   phaseMeta?: { halftimeRound?: number|null, regulationEndRound?: number|null, overtimeRounds?: Array<{round_number?: number}> },
 *   teamAName?: string,
 *   teamBName?: string,
 * }} props
 */
export default function MatchTrendCard({
  model,
  phaseMeta,
  teamAName = "Team A",
  teamBName = "Team B",
}) {
  const points = Array.isArray(model?.points) ? model.points : [];
  const stage = model?.stageScores || {};
  const streak = model?.longestStreak || {};
  const summary = model?.summary || "";

  const streakLabel =
    streak.length > 0 && (streak.teamKey === "a" || streak.teamKey === "b")
      ? `${streak.teamKey === "a" ? teamAName : teamBName} R${streak.start}–R${streak.end}（${streak.length}）`
      : "—";

  return (
    <article className="flex min-h-[220px] flex-col rounded-xl border border-cs2-border bg-cs2-bg-card p-3.5">
      <header className="mb-2 flex items-center gap-2">
        <div className="flex h-7 w-7 shrink-0 items-center justify-center rounded-lg bg-sky-500/10 text-sky-400">
          <Activity className="h-3.5 w-3.5" />
        </div>
        <h3 className="text-[13px] font-bold text-cs2-text-primary">比赛走势</h3>
      </header>
      {summary ? (
        <p className="mb-2 line-clamp-2 text-[11px] leading-snug text-cs2-text-secondary">{summary}</p>
      ) : null}
      <LeadChart points={points} phaseMeta={phaseMeta} />
      <div className="mt-auto grid grid-cols-2 gap-x-3 gap-y-1 pt-2 text-[10px] text-cs2-text-muted">
        <span>
          上半场{" "}
          <span className="font-semibold text-cs2-text-secondary">
            {stage.firstHalf?.a ?? 0}:{stage.firstHalf?.b ?? 0}
          </span>
        </span>
        <span>
          下半场{" "}
          <span className="font-semibold text-cs2-text-secondary">
            {stage.secondHalf?.a ?? 0}:{stage.secondHalf?.b ?? 0}
          </span>
        </span>
        {(stage.overtime?.a || stage.overtime?.b) ? (
          <span>
            加时{" "}
            <span className="font-semibold text-cs2-text-secondary">
              {stage.overtime?.a ?? 0}:{stage.overtime?.b ?? 0}
            </span>
          </span>
        ) : (
          <span />
        )}
        <span className="truncate">最长连胜 {streakLabel}</span>
        <span>
          {teamAName} 最大领先{" "}
          <span className="font-semibold text-sky-400">{model?.maxLeadA ?? 0}</span>
        </span>
        <span>
          {teamBName} 最大领先{" "}
          <span className="font-semibold text-amber-400">{model?.maxLeadB ?? 0}</span>
        </span>
      </div>
    </article>
  );
}
