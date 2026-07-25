import { ShieldCheck } from "lucide-react";

function formatSide(bucket) {
  const t = bucket?.t ?? 0;
  const ct = bucket?.ct ?? 0;
  return `${t} / ${ct}`;
}

function TeamRow({ name, colorClass, bucket }) {
  return (
    <tr className="border-t border-cs2-border/60">
      <td className="py-1.5 pr-2">
        <span className="inline-flex items-center gap-1.5">
          <span className={`h-1.5 w-1.5 rounded-full ${colorClass}`} />
          <span className="truncate font-semibold text-cs2-text-primary">{name}</span>
        </span>
      </td>
      <td className="py-1.5 text-center tabular-nums text-cs2-text-secondary">
        {formatSide(bucket?.firstHalf)}
      </td>
      <td className="py-1.5 text-center tabular-nums text-cs2-text-secondary">
        {formatSide(bucket?.secondHalf)}
      </td>
      <td className="py-1.5 text-center tabular-nums text-cs2-text-secondary">
        {formatSide(bucket?.overtime)}
      </td>
      <td className="py-1.5 text-center font-bold tabular-nums text-cs2-text-primary">
        {bucket?.total?.rounds ?? 0}
      </td>
    </tr>
  );
}

/**
 * @param {{
 *   model?: object,
 *   teamAName?: string,
 *   teamBName?: string,
 * }} props
 */
export default function SidePerformanceCard({
  model,
  teamAName = "Team A",
  teamBName = "Team B",
}) {
  const summary = model?.summary || "";

  return (
    <article className="flex min-h-[220px] flex-col rounded-xl border border-cs2-border bg-cs2-bg-card p-3.5">
      <header className="mb-2 flex items-center gap-2">
        <div className="flex h-7 w-7 shrink-0 items-center justify-center rounded-lg bg-emerald-500/10 text-emerald-400">
          <ShieldCheck className="h-3.5 w-3.5" />
        </div>
        <h3 className="text-[13px] font-bold text-cs2-text-primary">阵营表现</h3>
      </header>
      {summary ? (
        <p className="mb-2 line-clamp-2 text-[11px] leading-snug text-cs2-text-secondary">{summary}</p>
      ) : null}
      <div className="mt-auto overflow-x-auto">
        <table className="w-full min-w-[260px] text-[10px]">
          <thead>
            <tr className="text-cs2-text-muted">
              <th className="pb-1.5 text-left font-semibold">队伍</th>
              <th className="pb-1.5 font-semibold">上半场 T/CT</th>
              <th className="pb-1.5 font-semibold">下半场 T/CT</th>
              <th className="pb-1.5 font-semibold">加时 T/CT</th>
              <th className="pb-1.5 font-semibold">总计</th>
            </tr>
          </thead>
          <tbody>
            <TeamRow name={teamAName} colorClass="bg-sky-400" bucket={model?.teamA} />
            <TeamRow name={teamBName} colorClass="bg-amber-400" bucket={model?.teamB} />
          </tbody>
        </table>
      </div>
    </article>
  );
}
