import { Swords } from "lucide-react";
import InsightCard from "./InsightCard";

function formatRate(bucket) {
  if (!bucket || bucket.sampleTooSmall || bucket.rate == null) return "—";
  return `${Math.round(bucket.rate * 100)}%`;
}

function formatSample(bucket) {
  if (!bucket || !(bucket.total > 0)) return "";
  return `${bucket.wins ?? 0}/${bucket.total}`;
}

function MetricRow({ label, valueA, valueB, sampleA, sampleB }) {
  return (
    <div className="grid grid-cols-[1fr_minmax(4.5rem,auto)_minmax(4.5rem,auto)] items-center gap-2 border-t border-cs2-border/50 py-1 first:border-t-0">
      <span className="text-[11px] text-cs2-text-muted">{label}</span>
      <span className="text-right text-[12px] font-bold tabular-nums text-sky-400">
        {valueA}
        {sampleA ? <span className="ml-1 text-[9px] font-medium text-cs2-text-muted">{sampleA}</span> : null}
      </span>
      <span className="text-right text-[12px] font-bold tabular-nums text-amber-400">
        {valueB}
        {sampleB ? <span className="ml-1 text-[9px] font-medium text-cs2-text-muted">{sampleB}</span> : null}
      </span>
    </div>
  );
}

/**
 * @param {{
 *   model?: object,
 *   teamAName?: string,
 *   teamBName?: string,
 *   className?: string,
 * }} props
 */
export default function OpeningAdvantageCard({
  model,
  teamAName = "Team A",
  teamBName = "Team B",
  className = "",
}) {
  const teamA = model?.teamA || {};
  const teamB = model?.teamB || {};
  const hasData = model?.hasData !== false;

  if (!hasData) return null;

  return (
    <InsightCard
      title="首杀与人数优势"
      icon={<Swords className="h-3.5 w-3.5 text-amber-400" />}
      compact
      className={className}
    >
      <div className="flex flex-1 flex-col justify-center">
        <div className="mb-0.5 grid grid-cols-[1fr_minmax(4.5rem,auto)_minmax(4.5rem,auto)] gap-2 text-[9px] font-semibold text-cs2-text-muted">
          <span />
          <span className="truncate text-right text-sky-400/80">{teamAName}</span>
          <span className="truncate text-right text-amber-400/80">{teamBName}</span>
        </div>
        <MetricRow label="首杀次数" valueA={teamA.firstKills ?? 0} valueB={teamB.firstKills ?? 0} />
        <MetricRow
          label="5v4 转化率"
          valueA={formatRate(teamA.fiveVFour)}
          valueB={formatRate(teamB.fiveVFour)}
          sampleA={formatSample(teamA.fiveVFour)}
          sampleB={formatSample(teamB.fiveVFour)}
        />
        <MetricRow
          label="4v5 翻盘率"
          valueA={formatRate(teamA.fourVFive)}
          valueB={formatRate(teamB.fourVFive)}
          sampleA={formatSample(teamA.fourVFive)}
          sampleB={formatSample(teamB.fourVFive)}
        />
        <MetricRow
          label="1vN 残局胜率"
          valueA={formatRate(teamA.clutch1vN)}
          valueB={formatRate(teamB.clutch1vN)}
          sampleA={formatSample(teamA.clutch1vN)}
          sampleB={formatSample(teamB.clutch1vN)}
        />
      </div>
    </InsightCard>
  );
}
