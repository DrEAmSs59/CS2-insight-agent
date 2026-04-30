import { Loader2, OctagonX } from "lucide-react";

export default function ProgressBar({ text, active, batchRecording = false, onAbortBatch }) {
  const showSpinner = active || batchRecording;
  return (
    <div className="bg-cs2-bg-card rounded-xl border border-cs2-border p-4">
      <div className="flex flex-wrap items-center gap-3">
        {showSpinner && <Loader2 className="h-4 w-4 shrink-0 animate-spin text-cs2-orange" aria-hidden />}
        <span className="min-w-0 flex-1 text-xs font-mono text-cs2-text-secondary">{text}</span>
        {batchRecording && typeof onAbortBatch === "function" ? (
          <button
            type="button"
            onClick={() => void onAbortBatch()}
            className="inline-flex shrink-0 items-center gap-1.5 rounded-lg border border-red-500/50 bg-red-500/10 px-3 py-2 text-xs font-bold text-red-300 transition-colors hover:border-red-400 hover:bg-red-500/20"
          >
            <OctagonX className="h-3.5 w-3.5 shrink-0" aria-hidden />
            中止录制
          </button>
        ) : null}
      </div>
      {active && (
        <div className="mt-3 h-1 overflow-hidden rounded-full bg-cs2-bg-input">
          <div className="h-full w-[40%] animate-[indeterminate_1.5s_ease-in-out_infinite] rounded-full bg-gradient-to-r from-cs2-orange to-cs2-orange-light" />
        </div>
      )}
    </div>
  );
}
