import { Loader2, OctagonX, Radio, ShieldAlert } from "lucide-react";

import { useT } from "../../i18n/useT.js";
import Modal from "../ui/Modal.jsx";

export default function RecordingProgressModal({
  open,
  statusText = "",
  queueLength = 0,
  abortRequested = false,
  onAbort,
}) {
  const t = useT();
  const status = statusText || t("app.batchRecording");

  return (
    <Modal
      open={open}
      onClose={() => {}}
      closable={false}
      title={t("queue.recordingProgressTitle")}
      subtitle={t("queue.recordingProgressSubtitle", { n: queueLength })}
      icon={<Radio className="h-4 w-4 animate-pulse text-cs2-accent" />}
      maxWidth="max-w-lg"
      maxHeight="max-h-[82vh]"
      className="!h-auto"
      contentClassName="overflow-y-auto"
      zIndex={165}
    >
      <div className="space-y-3 px-5 py-4" data-testid="recording-progress-modal">
        <div
          className="flex min-h-36 flex-col items-center justify-center gap-3 rounded-lg border border-cs2-border bg-cs2-bg-input/35 px-5 py-6 text-center"
          role="status"
          aria-live="polite"
        >
          <div className="relative">
            <Loader2 className="h-8 w-8 animate-spin text-cs2-accent" aria-hidden />
            <span className="absolute inset-0 animate-ping rounded-full bg-cs2-accent/15" aria-hidden />
          </div>
          <div className="space-y-1">
            <p className="text-sm font-bold text-cs2-text-primary">
              {abortRequested ? t("queue.recordingProgressAborting") : t("queue.recordingProgressRunning")}
            </p>
            <p className="text-[12px] leading-relaxed text-cs2-text-muted">{status}</p>
          </div>
          <div className="h-1 w-full max-w-xs overflow-hidden rounded-full bg-cs2-bg-card">
            <div className="h-full w-[40%] animate-[indeterminate_1.5s_ease-in-out_infinite] rounded-full bg-gradient-to-r from-cs2-accent to-cs2-accent-light" />
          </div>
        </div>

        <div className="flex items-start gap-2 rounded-lg border border-amber-500/25 bg-cs2-amber-surface px-3 py-2.5 text-[11px] leading-relaxed text-cs2-text-secondary">
          <ShieldAlert className="mt-0.5 h-4 w-4 shrink-0 text-cs2-amber-on-surface" />
          <span>
            {abortRequested
              ? t("queue.recordingProgressAbortHint")
              : t("queue.recordingProgressHint")}
          </span>
        </div>

        <div className="flex justify-end">
          <button
            type="button"
            disabled={abortRequested || typeof onAbort !== "function"}
            onClick={() => void onAbort?.()}
            className="inline-flex items-center gap-1.5 rounded-lg border border-cs2-border-error/50 bg-cs2-rose-surface px-3 py-2 text-xs font-bold text-cs2-rose-on-surface transition-colors hover:border-cs2-border-error disabled:cursor-not-allowed disabled:opacity-55"
          >
            {abortRequested ? (
              <Loader2 className="h-3.5 w-3.5 animate-spin" aria-hidden />
            ) : (
              <OctagonX className="h-3.5 w-3.5" aria-hidden />
            )}
            {abortRequested
              ? t("queue.recordingProgressAbortingButton")
              : t("queue.recordingProgressAbortButton")}
          </button>
        </div>
      </div>
    </Modal>
  );
}
