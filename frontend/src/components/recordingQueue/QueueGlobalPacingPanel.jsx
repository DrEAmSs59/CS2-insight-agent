import { useMemo } from "react";
import { RotateCcw, X } from "lucide-react";
import {
  BACKEND_DEFAULT_PACING,
  clipKillerPovEnqueueEligible,
  clipVictimPovEnqueueEligible,
  useRecordingQueue,
} from "../../stores/recordingQueueStore";
import { useT } from "../../i18n/useT.js";
import { RangeField, SettingsButton } from "../../pages/settings/SettingsControls.jsx";
import { MAX_RECORDING_MERGE_GAP_SECONDS } from "../../utils/recordingPacing.js";

const FIELDS = [
  { key: "pre_first_sec", labelKey: "settings.presetPreLabel", descKey: "settings.presetPreDesc", shortKey: "settings.presetPreShort", min: 0, max: 20, step: 0.1 },
  { key: "post_last_sec", labelKey: "settings.presetPostLabel", descKey: "settings.presetPostDesc", shortKey: "settings.presetPostShort", min: 0, max: 10, step: 0.1 },
  { key: "max_gap_sec", labelKey: "settings.presetGapLabel", descKey: "settings.presetGapDesc", shortKey: "queue.defaultsGapShort", min: 2, max: MAX_RECORDING_MERGE_GAP_SECONDS, step: 0.5 },
];

function effectiveValue(globalPacing, key) {
  const v = globalPacing?.[key];
  return typeof v === "number" && Number.isFinite(v) ? v : BACKEND_DEFAULT_PACING[key];
}

function povStatus(queue, eligible, key) {
  const items = queue.filter((q) => eligible(q.clipData));
  return { eligible: items.length, enabled: items.filter((q) => Boolean(q.pacing_override?.[key])).length };
}

/** One-line summary of the queue-wide defaults with the button that opens the editor. */
export function QueueDefaultsSummary({ open, onToggle }) {
  const t = useT();
  const globalPacing = useRecordingQueue((s) => s.globalPacing);
  return (
    <div
      data-testid="recording-queue-defaults-summary"
      className="flex h-8 flex-wrap items-center gap-x-3 rounded-[7px] border border-cs2-border-subtle bg-cs2-bg-card pl-3 pr-1 text-xs text-cs2-text-secondary"
    >
      <span className="text-cs2-text-muted">{t("queue.defaultsSummaryLabel")}</span>
      {FIELDS.map((field) => (
        <span key={field.key}>
          {t(field.shortKey)}{" "}
          <b className="font-mono font-semibold text-cs2-text-primary">{effectiveValue(globalPacing, field.key)}s</b>
        </span>
      ))}
      <SettingsButton variant="ghost" aria-expanded={open} onClick={onToggle}>
        {t(open ? "queue.defaultsClose" : "queue.defaultsEdit")}
      </SettingsButton>
    </div>
  );
}

/**
 * Queue-wide defaults: pacing used by every clip without its own override,
 * plus bulk switches for the replay views.
 *
 * @param {{ queue: import("../../stores/recordingQueueStore").RecordingQueueItem[], onClose?: () => void }} props
 */
export default function QueueGlobalPacingPanel({ queue, onClose }) {
  const t = useT();
  const globalPacing = useRecordingQueue((s) => s.globalPacing);
  const setGlobalPacing = useRecordingQueue((s) => s.setGlobalPacing);
  const resetGlobalPacing = useRecordingQueue((s) => s.resetGlobalPacing);
  const toggleVictimPov = useRecordingQueue((s) => s.toggleVictimPovForAllHighlightsInQueue);
  const toggleKillerPov = useRecordingQueue((s) => s.toggleKillerPovForAllEligibleInQueue);
  const victim = useMemo(() => povStatus(queue, clipVictimPovEnqueueEligible, "victim_pov"), [queue]);
  const killer = useMemo(() => povStatus(queue, clipKillerPovEnqueueEligible, "killer_pov"), [queue]);

  return (
    <section
      data-testid="recording-queue-global-card"
      aria-label={t("queue.defaultsTitle")}
      className="shrink-0 rounded-[10px] border border-cs2-border bg-cs2-bg-elevated shadow-lg"
    >
      <div className="flex items-center justify-between gap-3 px-4 pb-1 pt-3">
        <div>
          <h2 className="text-[13px] font-semibold text-cs2-text-primary">{t("queue.defaultsTitle")}</h2>
          <p className="mt-0.5 text-xs text-cs2-text-muted">{t("queue.defaultsDesc")}</p>
        </div>
        {onClose ? (
          <SettingsButton iconOnly variant="ghost" icon={X} aria-label={t("common.close")} onClick={onClose} />
        ) : null}
      </div>
      <div className="grid gap-x-6 gap-y-1 px-4 lg:grid-cols-3">
        {FIELDS.map((field) => (
          <div key={field.key} className="flex flex-col gap-1.5 py-2">
            <div>
              <p className="text-[13px] font-medium text-cs2-text-primary">{t(field.labelKey)}</p>
              <p className="text-xs text-cs2-text-muted">{t(field.descKey)}</p>
            </div>
            <RangeField
              ariaLabel={t(field.labelKey)}
              min={field.min}
              max={field.max}
              step={field.step}
              unit={t("settings.unitSeconds")}
              value={effectiveValue(globalPacing, field.key)}
              defaultValue={BACKEND_DEFAULT_PACING[field.key]}
              onChange={(n) => setGlobalPacing({ [field.key]: Math.min(field.max, Math.max(field.min, n)) })}
            />
          </div>
        ))}
      </div>
      <div className="flex flex-wrap items-center gap-2 border-t border-cs2-border-subtle px-4 py-3">
        <SettingsButton disabled={victim.eligible === 0} onClick={toggleVictimPov}>
          {t(victim.eligible > 0 && victim.enabled === victim.eligible ? "queue.defaultsVictimOff" : "queue.defaultsVictimOn")}
          <span className="font-mono text-[11px] text-cs2-text-muted">{victim.enabled}/{victim.eligible}</span>
        </SettingsButton>
        <SettingsButton disabled={killer.eligible === 0} onClick={toggleKillerPov}>
          {t(killer.eligible > 0 && killer.enabled === killer.eligible ? "queue.defaultsKillerOff" : "queue.defaultsKillerOn")}
          <span className="font-mono text-[11px] text-cs2-text-muted">{killer.enabled}/{killer.eligible}</span>
        </SettingsButton>
        <SettingsButton variant="ghost" icon={RotateCcw} className="ml-auto" onClick={resetGlobalPacing}>
          {t("queue.defaultsReset")}
        </SettingsButton>
      </div>
    </section>
  );
}
