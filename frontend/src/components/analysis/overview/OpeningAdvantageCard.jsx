import { Swords } from "lucide-react";

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
    <div className="grid grid-cols-[1fr_auto_auto] items-center gap-3 border-t border-cs2-border/50 py-1.5 first:border-t-0">
      <span className="text-[11px] text-cs2-text-muted">{label}</span>
      <span className="min-w-[3.5rem] text-right text-[12px] font-bold tabular-nums text-sky-400">
        {valueA}
        {sampleA ? (
          <span className="ml-1 text-[9px] font-medium text-cs2-text-muted">{sampleA}</span>
        ) : null}
      </span>
      <span className="min-w-[3.5rem] text-right text-[12px] font-bold tabular-nums text-amber-400">
        {valueB}
        {sampleB ? (
          <span className="ml-1 text-[9px] font-medium text-cs2-text-muted">{sampleB}</span>
        ) : null}
      </span>
    </div>
  );
}

/**
 * @param {{
 *   model?: object,
 *   teamAName?: string,
 *   teamBName?: string,
 * }} props
 */
export default function OpeningAdvantageCard({
  model,
  teamAName = "Team A",
  teamBName = "Team B",
}) {
  const teamA = model?.teamA || {};
  const teamB = model?.teamB || {};
  const summary = model?.summary || "";
  const hasData = model?.hasData !== false;

  return (
    <article className="flex min-h-[220px] flex-col rounded-xl border border-cs2-border bg-cs2-bg-card p-3.5">
      <header className="mb-2 flex items-center gap-2">
        <div className="flex h-7 w-7 shrink-0 items-center justify-center rounded-lg bg-amber-500/10 text-amber-400">
          <Swords className="h-3.5 w-3.5" />
        </div>
        <h3 className="text-[13px] font-bold text-cs2-text-primary">首杀与人数优势</h3>
      </header>
      {summary ? (
        <p className="mb-2 line-clamp-2 text-[11px] leading-snug text-cs2-text-secondary">{summary}</p>
      ) : null}

      {!hasData ? (
        <p className="mt-4 text-center text-[11px] text-cs2-text-muted">
          当前 Demo 未提供可用于统计的首杀事件。
        </p>
      ) : (
        <div className="mt-auto">
          <div className="mb-1 grid grid-cols-[1fr_auto_auto] gap-3 text-[9px] font-semibold uppercase tracking-wide text-cs2-text-muted">
            <span />
            <span className="min-w-[3.5rem] text-right text-sky-400/80">{teamAName}</span>
            <span className="min-w-[3.5rem] text-right text-amber-400/80">{teamBName}</span>
          </div>
          <MetricRow
            label="首杀数"
            valueA={teamA.firstKills ?? 0}
            valueB={teamB.firstKills ?? 0}
          />
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
        </div>
      )}
    </article>
  );
}
