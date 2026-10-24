import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { useT } from "../../i18n/useT";
import { useRecordingQueue } from "../../stores/recordingQueueStore";
import { DEFAULT_RECORDING_OPTIONS } from "../../recording/recordingRequestFactory";
import Modal from "../ui/Modal";

const FIELDS = ["round_freeze_preroll_sec", "round_death_post_sec", "round_alive_post_sec"];

function SecondsInput({ label, value, onChange, min = 0, max, warnAbove }) {
  const t = useT();
  const [draft, setDraft] = useState(String(value));
  const [pending, setPending] = useState(null);
  const inputRef = useRef(null);
  const cancelRef = useRef(null);
  const confirmRef = useRef(null);
  useEffect(() => setDraft(String(value)), [value]);
  const closeWarning = () => {
    setPending(null);
    setDraft(String(value));
    inputRef.current?.focus();
  };
  return <><label className="flex items-center justify-between gap-3 text-[11px] text-cs2-text-secondary">
    <span>{label}</span>
    <input
      ref={inputRef} type="number" min={min} max={max} step={0.1} value={draft}
      className="w-20 shrink-0 rounded border border-cs2-border bg-cs2-bg-input px-2 py-1 text-right font-mono text-cs2-text-primary"
      onChange={(event) => {
        const text = event.target.value;
        const number = Number(text);
        setDraft(text);
        if (!text.trim() || !Number.isFinite(number) || number < min || (max != null && number > max)) return;
        if (warnAbove != null && number > warnAbove && number > value) {
          // Keep previews and recording requests at the accepted value until confirmed.
          setDraft(String(value));
          setPending(number);
        } else {
          onChange(number);
        }
      }}
      onBlur={() => setDraft(String(value))}
    />
  </label>
    {pending != null && createPortal(<div onKeyDown={(event) => {
      if (event.key === "Escape") {
        event.preventDefault();
        event.stopPropagation();
        closeWarning();
      } else if (event.key === "Tab") {
        event.preventDefault();
        (event.target === cancelRef.current ? confirmRef : cancelRef).current?.focus();
      }
    }}>
      <Modal open onClose={closeWarning} closable={false} fillHeight={false} maxWidth="max-w-md"
        zIndex={200} title={t("ftd.deathTailWarningTitle")}
        contentClassName="px-5 py-4"
        footer={<div className="flex justify-end gap-3">
          <button ref={cancelRef} autoFocus type="button" onClick={closeWarning}
            className="rounded border border-cs2-border px-3 py-2 text-sm text-cs2-text-secondary hover:bg-cs2-bg-hover">
            {t("common.cancel")}
          </button>
          <button ref={confirmRef} type="button" onClick={() => { closeWarning(); onChange(pending); }}
            className="rounded bg-cs2-accent px-3 py-2 text-sm font-semibold text-black">
            {t("ftd.deathTailWarningConfirm", { seconds: pending })}
          </button>
        </div>}>
        <p className="text-sm leading-relaxed text-cs2-text-primary">{t("ftd.deathTailWarningBody")}</p>
      </Modal>
    </div>, document.body)}
  </>;
}

// Shared queue controls; only the backend planner computes recording windows.
export default function RoundCompilationTiming({ item, updateItemPacing }) {
  const t = useT();
  const globalPacing = useRecordingQueue((s) => s.globalPacing);
  return <div className="space-y-3">
    <p className="text-[10px] text-cs2-text-muted">{t("ftd.timingStepHint")}</p>
    {FIELDS.map((field) => <SecondsInput
      key={`${item.id}:${field}`}
      label={t(`ftd.${field}`)}
      value={item.pacing_override?.[field] ?? globalPacing?.[field] ?? DEFAULT_RECORDING_OPTIONS[field]}
      min={field === "round_freeze_preroll_sec" ? 3 : field === "round_death_post_sec" ? 2 : 1}
      max={field === "round_freeze_preroll_sec" ? 10 : field === "round_death_post_sec" ? 5 : 3}
      warnAbove={field === "round_death_post_sec" ? 2.3 : undefined}
      onChange={(value) => updateItemPacing(item.id, { [field]: value })}
    />)}
    <p className="text-[10px] leading-relaxed text-cs2-text-muted">{t("ftd.timingHint")}</p>
    <p className="text-[10px] leading-relaxed text-cs2-text-muted">{t("ftd.aliveTimingHint")}</p>
    <button type="button" className="text-[11px] text-cs2-accent hover:underline"
      onClick={() => updateItemPacing(item.id, Object.fromEntries(FIELDS.map((field) => [field, DEFAULT_RECORDING_OPTIONS[field]])))}>
      {t("ftd.timingReset")}
    </button>
  </div>;
}
