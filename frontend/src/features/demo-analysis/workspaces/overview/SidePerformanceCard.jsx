import { ShieldCheck } from "lucide-react";
import InsightCard from "./InsightCard";

function formatSide(bucket) {
  return `${bucket?.t ?? 0}/${bucket?.ct ?? 0}`;
}

function TeamRow({ name, colorClass, bucket, showOt }) {
  return (
    <tr className="border-t border-cs2-border-subtle">
      <td className="py-2 pr-2">
        <span className="inline-flex max-w-full items-center gap-1.5">
          <span className={`h-2 w-2 shrink-0 rounded-full ${colorClass}`} />
          <span className="truncate font-semibold text-cs2-text-primary">{name}</span>
        </span>
      </td>
      <td className="py-2 text-center font-mono tabular-nums text-cs2-text-secondary">
        {formatSide(bucket?.firstHalf)}
      </td>
      <td className="py-2 text-center font-mono tabular-nums text-cs2-text-secondary">
        {formatSide(bucket?.secondHalf)}
      </td>
      {showOt ? (
        <td className="py-2 text-center font-mono tabular-nums text-cs2-text-secondary">
          {formatSide(bucket?.overtime)}
        </td>
      ) : null}
      <td className="py-2 text-center font-mono text-[13px] font-bold tabular-nums text-cs2-text-primary">
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
      icon={ShieldCheck}
      tone="green"
      summary="各半场 T / CT 方赢下的回合"
      className={className}
    >
      <div className="flex min-h-0 flex-1 flex-col">
        <div className="flex min-h-0 flex-1 flex-col justify-center overflow-x-auto">
          <table className="w-full min-w-[240px] text-xs">
            <thead>
              <tr className="text-[11px] text-cs2-text-muted">
                <th className="pb-1.5 text-left font-medium">队伍</th>
                <th className="pb-1.5 font-medium">上半场 T/CT</th>
                <th className="pb-1.5 font-medium">下半场 T/CT</th>
                {showOt ? <th className="pb-1.5 font-medium">加时 T/CT</th> : null}
                <th className="pb-1.5 font-medium">总计</th>
              </tr>
            </thead>
            <tbody>
              <TeamRow name={teamAName} colorClass="bg-cs2-team-blue" bucket={model?.teamA} showOt={showOt} />
              <TeamRow name={teamBName} colorClass="bg-cs2-team-amber" bucket={model?.teamB} showOt={showOt} />
            </tbody>
          </table>
        </div>
        {summary ? (
          <p className="mt-2 shrink-0 truncate text-[11.5px] leading-snug text-cs2-text-secondary" title={summary}>
            {summary}
          </p>
        ) : null}
      </div>
    </InsightCard>
  );
}
