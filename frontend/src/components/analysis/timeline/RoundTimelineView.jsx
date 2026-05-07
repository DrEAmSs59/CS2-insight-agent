import { Film } from "lucide-react";
import RoundTimelineItem from "./RoundTimelineItem";

/**
 * @param {{
 *   roundTimeline?: unknown[] | null,
 *   focusedPlayer?: string,
 *   demoFilename?: string,
 *   mapName?: string,
 *   queuedClientClipUids?: Set<string>,
 *   onAddEvent?: (event: Record<string, unknown>, roundRow: Record<string, unknown>) => void,
 *   onAddRound?: (roundRow: Record<string, unknown>) => void,
 *   onAddEventsBatch?: (events: Record<string, unknown>[]) => void,
 *   suppressSummaryHeader?: boolean,
 * }} props
 */
export default function RoundTimelineView({
  roundTimeline,
  focusedPlayer = "",
  demoFilename = "",
  mapName = "",
  queuedClientClipUids,
  onAddEvent,
  onAddRound,
  onAddEventsBatch,
  suppressSummaryHeader = false,
}) {
  const rounds = Array.isArray(roundTimeline) ? roundTimeline : [];
  let kc = 0;
  let dc = 0;
  for (const r of rounds) {
    const s = r?.summary;
    if (s && typeof s === "object") {
      kc += Number(s.kills) || 0;
      dc += Number(s.deaths) || 0;
    }
  }
  const rc = rounds.length;

  return (
    <div className="space-y-4">
      {!suppressSummaryHeader && (
        <div className="flex flex-wrap items-center gap-2">
          <Film className="h-4 w-4 text-cs2-orange" />
          <h2 className="text-sm font-bold uppercase tracking-wide">回合时间线</h2>
          <span className="ml-auto text-right text-[11px] font-mono leading-snug text-cs2-text-secondary sm:text-xs">
            共 <span className="text-zinc-300">{rc}</span> 回合 ·{" "}
            <span className="text-emerald-400/90">{kc}</span> 击杀 ·{" "}
            <span className="text-rose-400/90">{dc}</span> 死亡
          </span>
        </div>
      )}

      {rounds.length === 0 ? (
        <div className="rounded-lg border border-dashed border-white/10 py-10 text-center text-[13px] text-zinc-600">
          暂无时间线数据（请重新解析该 Demo）
        </div>
      ) : (
        <div className="timeline-root relative pl-1">
          <div
            className="pointer-events-none absolute bottom-0 left-8 top-2 w-px bg-gradient-to-b from-[rgba(255,140,0,0.5)] to-[rgba(255,140,0,0.15)] opacity-50"
            aria-hidden
          />
          <div className="space-y-2">
            {rounds.map((row) => (
              <RoundTimelineItem
                key={`r-${row?.round_number ?? row?.round}`}
                roundRow={row}
                focusedPlayer={focusedPlayer}
                mapName={mapName}
                demoFilename={demoFilename}
                queuedUids={queuedClientClipUids}
                onAddEvent={onAddEvent}
                onAddRound={onAddRound}
                onAddEventsBatch={onAddEventsBatch}
              />
            ))}
          </div>
        </div>
      )}
    </div>
  );
}
