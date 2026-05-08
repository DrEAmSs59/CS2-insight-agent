import { useMemo, useState } from "react";
import { ChevronDown } from "lucide-react";
import KillfeedEventRow from "./KillfeedEventRow";
import TimelineNode from "./TimelineNode";
import RoundSummaryPanel from "./RoundSummaryPanel";
import { queueItemClientUid } from "../../../utils/recordingBatch";
import { buildTimelineEventClipData, buildTimelineRoundClipData } from "../../../utils/timelineQueue";

/**
 * @param {{
 *   roundRow: Record<string, unknown>,
 *   focusedPlayer: string,
 *   mapName?: string,
 *   demoFilename?: string,
 *   queuedUids?: Set<string>,
 *   onAddEvent?: (event: Record<string, unknown>, roundRow: Record<string, unknown>) => void,
 *   onAddRound?: (roundRow: Record<string, unknown>) => void,
 *   onAddEventsBatch?: (events: Record<string, unknown>[]) => void,
 * }} props
 */
export default function RoundTimelineItem({
  roundRow,
  focusedPlayer,
  mapName = "",
  demoFilename = "",
  queuedUids,
  onAddEvent,
  onAddRound,
  onAddEventsBatch,
}) {
  const rn = Number(roundRow?.round_number ?? roundRow?.round);
  const events = Array.isArray(roundRow?.events) ? roundRow.events : [];
  const sum = roundRow?.summary || {};
  const pstats = roundRow?.player_stats && typeof roundRow.player_stats === "object" ? roundRow.player_stats : null;
  const tk = Number(pstats?.kills ?? sum.kills) || 0;
  const td = Number(pstats?.deaths ?? sum.deaths) || 0;
  const ta = Number(pstats?.assists ?? sum.assists) || 0;
  const ths = Number(pstats?.headshots) || 0;
  const res = roundRow?.result;
  const st = roundRow?.start_tick;
  const en = roundRow?.end_tick;
  const scoreText = String(roundRow?.score_text || "—");
  const side = roundRow?.side ? String(roundRow.side) : "";

  const killsOnly = useMemo(
    () => events.filter((e) => e?.record_type === "kill" || e?.type === "kill"),
    [events],
  );
  const deathsOnly = useMemo(
    () => events.filter((e) => e?.record_type === "death" || e?.type === "death"),
    [events],
  );
  const assistOnlyCount = useMemo(
    () => events.filter((e) => String(e?.type || "") === "assist_only").length,
    [events],
  );

  const hasKillOrDeath = killsOnly.length > 0 || deathsOnly.length > 0;
  const onlyAssists = events.length > 0 && !hasKillOrDeath && assistOnlyCount > 0;
  const noEvents = events.length === 0;
  const defaultCollapsed = noEvents || onlyAssists;
  const [expanded, setExpanded] = useState(!defaultCollapsed);
  const [hovered, setHovered] = useState(false);

  const isQueued = (ev) => {
    if (!queuedUids || !ev) return false;
    const cd = buildTimelineEventClipData({
      event: ev,
      mapName,
      targetPlayer: focusedPlayer,
      round: rn,
    });
    return queuedUids.has(
      queueItemClientUid({
        clientClipUid: cd.client_clip_uid,
        clipData: cd,
        demoFilename,
        clipId: cd.clip_id,
      }),
    );
  };

  const roundUid = `tl_round_${Number.isFinite(rn) ? rn : "x"}`;
  const roundQueued =
    queuedUids &&
    queuedUids.has(
      queueItemClientUid({
        clientClipUid: roundUid,
        clipData: { client_clip_uid: roundUid, clip_id: roundUid },
        demoFilename,
        clipId: roundUid,
      }),
    );

  let outcomeZh = "—";
  if (res === "win") outcomeZh = "胜利";
  else if (res === "loss") outcomeZh = "失败";

  const collapsedSummary = noEvents
    ? "无事件"
    : onlyAssists
      ? `无击杀 / 无死亡 / ${ta} 助攻`
      : `${tk} 杀 / ${td} 死 / ${ta} 助攻`;

  if (!expanded) {
    return (
      <button
        type="button"
        onClick={() => setExpanded(true)}
        className="group/round grid w-full grid-cols-[56px_1fr] items-center gap-x-3 rounded-xl border border-white/[0.08] bg-[rgb(22,22,22)]/95 py-2 pl-0 pr-2 text-left transition-colors hover:border-[rgba(255,140,0,0.35)] max-[1279px]:grid-cols-[44px_1fr]"
      >
        <TimelineNode result={res} targetKills={tk} targetDeaths={td} glow={hovered} />
        <div className="min-w-0">
          <p className="text-[13px] font-semibold text-zinc-200">
            第 {Number.isFinite(rn) ? rn : "?"} 回合
            <span className="ml-2 text-[12px] font-normal text-zinc-500">{collapsedSummary}</span>
          </p>
          <p className="mt-0.5 text-[11px] text-zinc-600">点击展开</p>
        </div>
      </button>
    );
  }

  return (
    <div
      className="group/round grid w-full grid-cols-[56px_minmax(0,1fr)_280px] gap-x-3 rounded-xl border border-white/[0.08] bg-[rgb(22,22,22)]/95 py-2 pl-0 pr-2 transition-[border-color,box-shadow] duration-150 hover:border-[rgba(255,140,0,0.42)] hover:shadow-[0_0_0_1px_rgba(255,140,0,0.12)] max-[1279px]:grid-cols-[44px_minmax(0,1fr)]"
      onMouseEnter={() => setHovered(true)}
      onMouseLeave={() => setHovered(false)}
    >
      <div className="flex flex-col items-center">
        <TimelineNode result={res} targetKills={tk} targetDeaths={td} glow={hovered} />
      </div>

      <div className="min-w-0 border-r border-white/[0.05] pr-3 max-[1279px]:col-span-1 max-[1279px]:border-r-0 max-[1279px]:pr-0">
        <div className="mb-2 flex flex-wrap items-center justify-between gap-2 gap-y-1 text-[11px] text-zinc-400">
          <div className="flex min-w-0 flex-wrap items-center gap-2">
            <span className="font-bold text-zinc-100">第 {Number.isFinite(rn) ? rn : "?"} 回合</span>
            <span
              className={
                res === "win"
                  ? "rounded border border-emerald-500/35 bg-emerald-500/10 px-1.5 py-0 text-[10px] font-semibold text-emerald-400"
                  : res === "loss"
                    ? "rounded border border-rose-500/35 bg-rose-500/10 px-1.5 py-0 text-[10px] font-semibold text-rose-400"
                    : "rounded border border-white/10 px-1.5 py-0 text-[10px] font-semibold text-zinc-500"
              }
            >
              {outcomeZh}
            </span>
            {side ? <span className="font-mono text-[10px] text-zinc-500">{side}</span> : null}
            <span className="font-mono text-[10px] text-zinc-400">{scoreText}</span>
          </div>
          {st != null && en != null ? (
            <span className="shrink-0 font-mono text-[10px] text-zinc-600">
              tick {st} → {en}
            </span>
          ) : null}
        </div>

        <div className="flex flex-col gap-1">
          {events.map((ev) => (
            <div
              key={String(ev?.id || `${ev?.tick}-${ev?.type}`)}
              className="rounded-md transition-colors duration-150 group-hover/round:bg-white/[0.04]"
            >
              <KillfeedEventRow
                event={ev}
                focusedPlayer={focusedPlayer}
                queued={isQueued(ev)}
                variant="timeline"
                onRowClick={
                  ev?.can_record && onAddEvent && String(ev?.type || "") !== "assist_only"
                    ? () => onAddEvent(ev, roundRow)
                    : undefined
                }
              />
            </div>
          ))}
        </div>

        <button
          type="button"
          onClick={() => setExpanded(false)}
          className="mt-2 inline-flex items-center gap-1 text-[11px] font-semibold text-zinc-500 hover:text-zinc-300"
        >
          <ChevronDown className="h-3.5 w-3.5 rotate-180" />
          收起本回合
        </button>
      </div>

      <div className="min-w-0 max-[1279px]:col-span-2 max-[1279px]:mt-3 max-[1279px]:border-t max-[1279px]:border-white/[0.06] max-[1279px]:pt-3">
        <RoundSummaryPanel
          kills={tk}
          deaths={td}
          assists={ta}
          headshots={ths}
          extraTags={[]}
          roundQueued={Boolean(roundQueued)}
          killsOnly={killsOnly}
          deathsOnly={deathsOnly}
          onAddRound={onAddRound && !roundQueued ? () => onAddRound(roundRow) : undefined}
          onAddKills={
            killsOnly.length && onAddEventsBatch ? () => onAddEventsBatch(killsOnly) : undefined
          }
          onAddDeaths={
            deathsOnly.length && onAddEventsBatch ? () => onAddEventsBatch(deathsOnly) : undefined
          }
        />
      </div>
    </div>
  );
}
