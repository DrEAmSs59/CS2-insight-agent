import { ShieldCheck } from "lucide-react";
import InsightCard from "./InsightCard";

function formatSide(bucket) {
  return `${bucket?.t ?? 0}/${bucket?.ct ?? 0}`;
}

function TeamRow({ name, colorClass, bucket, showOt }) {
  return (
    <tr className="border-t border-cs2-border/60">
      <td className="py-1.5 pr-2">
        <span className="inline-flex max-w-full items-center gap-1.5">
          <span className={`h-1.5 w-1.5 shrink-0 rounded-full ${colorClass}`} />
          <span className="truncate font-semibold text-cs2-text-primary">{name}</span>
        </span>
      </td>
      <td className="py-1.5 text-center tabular-nums text-cs2-text-secondary">
        {formatSide(bucket?.firstHalf)}
      </td>
      <td className="py-1.5 text-center tabular-nums text-cs2-text-secondary">
        {formatSide(bucket?.secondHalf)}
      </td>
      {showOt ? (
        <td className="py-1.5 text-center tabular-nums text-cs2-text-secondary">
          {formatSide(bucket?.overtime)}
        </td>
      ) : null}
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
 *   className?: string,
 * }} props
 */
export default function SidePerformanceCard({
  model,
  teamAName = "Team A",
  teamBName = "Team B",
  className = "",
}) {
  const summary = model?.summary || "";
  const showOt = Boolean(model?.hasOvertime);

  return (
    <InsightCard
      title="阵营表现"
      icon={<ShieldCheck className="h-3.5 w-3.5 text-emerald-400" />}
      summary={summary}
      compact
      className={`h-full min-h-[180px] xl:min-h-[190px] ${className}`}
    >
      <div className="overflow-x-auto">
        <table className="w-full min-w-[220px] text-[10px]">
          <thead>
            <tr className="text-cs2-text-muted">
              <th className="pb-1 text-left font-semibold">队伍</th>
              <th className="pb-1 font-semibold">上半场 T/CT</th>
              <th className="pb-1 font-semibold">下半场 T/CT</th>
              {showOt ? <th className="pb-1 font-semibold">加时 T/CT</th> : null}
              <th className="pb-1 font-semibold">总计</th>
            </tr>
          </thead>
          <tbody>
            <TeamRow name={teamAName} colorClass="bg-sky-400" bucket={model?.teamA} showOt={showOt} />
            <TeamRow name={teamBName} colorClass="bg-amber-400" bucket={model?.teamB} showOt={showOt} />
          </tbody>
        </table>
      </div>
    </InsightCard>
  );
}
