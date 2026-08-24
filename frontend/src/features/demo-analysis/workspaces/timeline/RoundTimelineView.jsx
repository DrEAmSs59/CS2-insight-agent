import { Film } from "lucide-react";
import RoundTimelineItem from "./RoundTimelineItem";
import { useT } from "../../../../i18n/useT.js";
import { useRecordingQueue } from "../../../../stores/recordingQueueStore";

/**
 * 与设置界面「加载玩家头像与饰品图片」Toggle 一致的动画开关样式
 * （同款 Tailwind 轨道/滑块 transition，无跨 feature 依赖）。
 * @param {{ checked: boolean, onChange: (v: boolean) => void, title?: string }} props
 */
function MergeSwitch({ checked, onChange, title }) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      title={title}
      onClick={() => onChange(!checked)}
      className={`relative inline-flex h-5 w-9 shrink-0 rounded-full border-2 border-transparent transition-colors ${checked ? "bg-cs2-accent" : "bg-cs2-bg-input"}`}
    >
      <span
        className={`pointer-events-none inline-block h-4 w-4 rounded-full bg-cs2-text-on-accent shadow transition-transform ${checked ? "translate-x-4" : "translate-x-0.5"}`}
      />
    </button>
  );
}

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
 *   onRemoveEvent?: (event: Record<string, unknown>, roundRow: Record<string, unknown>) => void,
 *   onRemoveRound?: (roundRow: Record<string, unknown>) => void,
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
  onRemoveEvent,
  onRemoveRound,
  suppressSummaryHeader = false,
}) {
  const t = useT();
  const mergeEnabled = useRecordingQueue((s) => s.mergeTimelineClipsEnabled);
  const setMergeTimelineClips = useRecordingQueue((s) => s.setMergeTimelineClips);
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
      <div className="flex flex-wrap items-center gap-2">
        <Film className="h-4 w-4 text-cs2-accent" />
        <h2 className="text-sm font-bold uppercase tracking-wide">{t("analysis.timelineTitle")}</h2>
        <label
          className="ml-1 inline-flex items-center gap-1.5 text-[11px] font-medium text-cs2-text-secondary"
          title={t("analysis.mergeTimelineClipsTip")}
        >
          <MergeSwitch
            checked={mergeEnabled}
            onChange={(v) => setMergeTimelineClips(v)}
            title={t("analysis.mergeTimelineClipsTip")}
          />
          <span>{t("analysis.mergeTimelineClips")}</span>
        </label>
        {!suppressSummaryHeader && (
          <span className="ml-auto text-right text-[11px] font-mono leading-snug text-cs2-text-secondary sm:text-xs">
            {t("analysis.roundCount", { n: rc })} ·{" "}
            <span className="text-cs2-emerald-on-surface">{t("analysis.killCount", { n: kc })}</span>{" "}
            ·{" "}
            <span className="text-cs2-rose-on-surface">{t("analysis.deathCount", { n: dc })}</span>
          </span>
        )}
      </div>

      {rounds.length === 0 ? (
        <div className="rounded-lg border border-dashed border-cs2-border py-10 text-center text-[13px] text-cs2-text-muted">
          {t("analysis.timelineEmpty")}
        </div>
      ) : (
        <div className="timeline-root relative pl-1">
          <div
            className="pointer-events-none absolute bottom-0 left-8 top-2 w-px bg-gradient-to-b from-[rgba(224,127,10,0.5)] to-[rgba(224,127,10,0.15)] opacity-50"
            aria-hidden
          />
          <div className="analysis-list-surface">
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
                onRemoveEvent={onRemoveEvent}
                onRemoveRound={onRemoveRound}
              />
            ))}
          </div>
        </div>
      )}
    </div>
  );
}
