import {
  Clapperboard,
  Cpu,
  Layers,
  Timer,
  CircleDot,
  Wifi,
} from "lucide-react";

/**
 * @param {{
 *   pendingCount: number,
 *   totalEstimateSec: number,
 *   povSegmentCount: number,
 *   demoCount: number,
 *   recordingStatusLabel: string,
 *   obsStatusLabel: string,
 * }} props
 */
export default function RecordingStatsStrip({
  pendingCount,
  totalEstimateSec,
  povSegmentCount,
  demoCount,
  recordingStatusLabel,
  obsStatusLabel,
}) {
  const estMin =
    totalEstimateSec <= 0
      ? "—"
      : totalEstimateSec >= 3600
        ? `${Math.floor(totalEstimateSec / 3600)}h${Math.round((totalEstimateSec % 3600) / 60)}m`
        : `${Math.max(1, Math.round(totalEstimateSec / 60))}m`;

  const cards = [
    { icon: Layers, label: "待录制片段", value: String(pendingCount), mono: true },
    { icon: Timer, label: "预计总长", value: estMin, mono: false },
    { icon: CircleDot, label: "追加回看", value: String(povSegmentCount), mono: true },
    { icon: Clapperboard, label: "Demo", value: String(demoCount), mono: true },
    { icon: Cpu, label: "队列状态", value: recordingStatusLabel, mono: false },
    { icon: Wifi, label: "OBS", value: obsStatusLabel, mono: false },
  ];

  return (
    <div className="flex w-full min-w-0 shrink-0 flex-wrap gap-2 border-b border-white/[0.06] bg-black/25 px-2 py-2 sm:px-3">
      {cards.map(({ icon: Icon, label, value, mono }) => (
        <div
          key={label}
          className="flex h-[66px] min-w-[6.5rem] flex-1 basis-[8rem] items-center gap-2 rounded-md border border-white/[0.06] bg-cs2-bg-card/80 px-2.5 py-1.5 shadow-[inset_0_1px_0_rgba(255,255,255,0.03)] sm:h-[68px] sm:min-w-[7.5rem]"
        >
          <Icon className="h-3.5 w-3.5 shrink-0 text-zinc-600" aria-hidden />
          <div className="min-w-0 flex-1">
            <p className="truncate text-[9px] font-semibold uppercase tracking-wide text-zinc-600">{label}</p>
            <p
              className={`truncate text-[12px] font-semibold leading-tight text-zinc-200 ${mono ? "font-mono tabular-nums" : ""}`}
              title={value}
            >
              {value}
            </p>
          </div>
        </div>
      ))}
    </div>
  );
}
