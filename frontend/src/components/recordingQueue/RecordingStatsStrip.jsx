/**
 * @param {{
 *   pendingCount: number,
 *   totalEstimateSec: number,
 *   povSegmentCount: number,
 *   demoCount: number,
 *   queueStatusLabel: "待开始" | "录制中" | "已完成",
 *   obsConnected: boolean | null,
 *   obsEndpointLabel: string,
 * }} props
 */
export default function RecordingStatsStrip({
  pendingCount,
  totalEstimateSec,
  povSegmentCount,
  demoCount,
  queueStatusLabel,
  obsConnected,
  obsEndpointLabel,
}) {
  let durationNum = "—";
  let durationUnit = "";
  if (totalEstimateSec > 0) {
    if (totalEstimateSec >= 3600) {
      durationNum = `${Math.floor(totalEstimateSec / 3600)}h${Math.round((totalEstimateSec % 3600) / 60)}m`;
    } else {
      durationNum = String(Math.max(1, Math.round(totalEstimateSec / 60)));
      durationUnit = "m";
    }
  }

  const sep = <span className="h-3.5 w-px shrink-0 bg-white/10" aria-hidden />;

  return (
    <div className="flex min-w-0 flex-wrap items-center justify-end gap-3.5">
      <div className="flex items-baseline gap-1.5">
        <span className="font-mono text-[18px] tabular-nums leading-none text-cs2-orange">{pendingCount}</span>
        <span className="text-[11px] leading-none text-zinc-500">片段</span>
      </div>
      {sep}
      <div className="flex items-baseline gap-1.5">
        <span className="font-mono text-[18px] tabular-nums leading-none text-white">{durationNum}</span>
        {durationUnit ? <span className="text-[11px] leading-none text-zinc-500">{durationUnit}</span> : null}
      </div>
      {sep}
      <div className="flex items-baseline gap-1.5">
        <span className="font-mono text-[18px] tabular-nums leading-none text-sky-300">{povSegmentCount}</span>
        <span className="text-[11px] leading-none text-zinc-500">回看</span>
      </div>
      {sep}
      <div className="flex items-baseline gap-1.5">
        <span className="font-mono text-[18px] tabular-nums leading-none text-white">{demoCount}</span>
        <span className="text-[11px] leading-none text-zinc-500">Demo</span>
      </div>
      <span className="rounded-full border border-cs2-orange/30 bg-cs2-orange/10 px-2 py-0.5 text-[11px] font-medium leading-none text-cs2-orange">
        {queueStatusLabel}
      </span>
      <span
        className={
          obsConnected === true
            ? "rounded-full border border-emerald-500/25 bg-emerald-500/10 px-2 py-0.5 text-[11px] font-medium leading-none text-emerald-300"
            : obsConnected === false
              ? "rounded-full border border-rose-500/30 bg-rose-500/10 px-2 py-0.5 text-[11px] font-medium leading-none text-rose-300"
              : "rounded-full border border-white/[0.08] bg-white/[0.04] px-2 py-0.5 text-[11px] font-medium leading-none text-zinc-500"
        }
      >
        {obsConnected === false ? "OBS · 未连接" : `OBS · ${obsEndpointLabel}`}
      </span>
    </div>
  );
}
