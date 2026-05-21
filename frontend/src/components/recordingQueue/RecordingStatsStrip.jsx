import { Link } from "react-router-dom";

/**
 * @param {{
 *   pendingCount: number,
 *   totalEstimateSec: number,
 *   povSegmentCount: number,
 *   demoCount: number,
 *   queueStatusLabel: "待开始" | "录制中" | "已完成",
 *   obsConfigured: boolean,
 *   obsEndpointLabel: string,
 *   obsConfigHasIssues: boolean | null,
 * }} props
 */
export default function RecordingStatsStrip({
  pendingCount,
  totalEstimateSec,
  povSegmentCount,
  demoCount,
  queueStatusLabel,
  obsConfigured,
  obsEndpointLabel,
  obsConfigHasIssues,
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

  const sep = <span className="h-3.5 w-px shrink-0 bg-cs2-border" aria-hidden />;

  return (
    <div className="flex min-w-0 flex-wrap items-center justify-end gap-3.5">
      <div className="flex items-baseline gap-1.5">
        <span className="font-mono text-[18px] tabular-nums leading-none text-cs2-accent">{pendingCount}</span>
        <span className="text-[11px] leading-none text-cs2-text-muted">片段</span>
      </div>
      {sep}
      <div className="flex items-baseline gap-1.5">
        <span className="font-mono text-[18px] tabular-nums leading-none text-cs2-text-primary">{durationNum}</span>
        {durationUnit ? <span className="text-[11px] leading-none text-cs2-text-muted">{durationUnit}</span> : null}
      </div>
      {sep}
      <div className="flex items-baseline gap-1.5">
        <span className="font-mono text-[18px] tabular-nums leading-none text-sky-300">{povSegmentCount}</span>
        <span className="text-[11px] leading-none text-cs2-text-muted">回看</span>
      </div>
      {sep}
      <div className="flex items-baseline gap-1.5">
        <span className="font-mono text-[18px] tabular-nums leading-none text-cs2-text-primary">{demoCount}</span>
        <span className="text-[11px] leading-none text-cs2-text-muted">Demo</span>
      </div>
      <span className="rounded-full border border-cs2-accent/30 bg-cs2-accent/10 px-2 py-0.5 text-[11px] font-medium leading-none text-cs2-accent">
        {queueStatusLabel}
      </span>
      <span
        className={
          obsConfigured
            ? "rounded-full border border-emerald-500/25 bg-emerald-500/10 px-2 py-0.5 text-[11px] font-medium leading-none text-emerald-300"
            : "rounded-full border border-cs2-border bg-cs2-bg-hover px-2 py-0.5 text-[11px] font-medium leading-none text-cs2-text-muted"
        }
      >
        {obsConfigured ? "OBS · 已配置" : "OBS · 未配置"}
      </span>
      {obsConfigured && obsConfigHasIssues === true && (
        <Link to="/obs-config-center">
          <span className="rounded-full border border-amber-500/30 bg-amber-500/10 px-2 py-0.5 text-[11px] font-medium leading-none text-amber-300 hover:bg-amber-500/20 transition-colors">
            OBS 配置待修复
          </span>
        </Link>
      )}
    </div>
  );
}
