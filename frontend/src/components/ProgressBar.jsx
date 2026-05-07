import { useEffect, useRef } from "react";
import { Loader2, OctagonX, X } from "lucide-react";
import { useNavigate } from "react-router-dom";

export default function ProgressBar({
  text,
  active,
  batchRecording = false,
  onAbortBatch,
  dismissible = false,
  onDismiss,
  /** 非空时，在展示若干毫秒后自动触发 onDismiss（用于短时成功/提示；失败请勿传此值） */
  autoDismissAfterMs,
  /** 为 true 时展示跳转录制队列按钮（点击后导航并关闭通知） */
  showQueueNavigate = false,
}) {
  const navigate = useNavigate();
  const onDismissRef = useRef(onDismiss);
  onDismissRef.current = onDismiss;

  useEffect(() => {
    if (!autoDismissAfterMs || autoDismissAfterMs <= 0 || !text?.trim()) return;
    // 解析读条 / 批量录制进行中时不计时，避免误关或中途消失
    if (active || batchRecording) return;
    const id = window.setTimeout(() => {
      onDismissRef.current?.();
    }, autoDismissAfterMs);
    return () => window.clearTimeout(id);
  }, [text, autoDismissAfterMs, active, batchRecording]);

  const showSpinner = active || batchRecording;
  return (
    <div className="relative bg-cs2-bg-card rounded-xl border border-cs2-border p-4">
      <div className="flex flex-wrap items-center gap-3">
        {showSpinner && <Loader2 className="h-4 w-4 shrink-0 animate-spin text-cs2-orange" aria-hidden />}
        <span className="min-w-0 flex-1 text-xs font-mono text-cs2-text-secondary">{text}</span>
        {showQueueNavigate ? (
          <button
            type="button"
            onClick={() => {
              navigate("/queue");
              onDismiss?.();
            }}
            className="inline-flex shrink-0 rounded-lg border border-cs2-orange/45 bg-cs2-orange/15 px-3 py-2 text-xs font-semibold text-cs2-orange transition-colors hover:bg-cs2-orange/25"
          >
            录制队列
          </button>
        ) : null}
        {dismissible && typeof onDismiss === "function" ? (
          <button
            type="button"
            onClick={() => onDismiss()}
            className="inline-flex shrink-0 rounded-md border border-white/12 p-1.5 text-zinc-500 transition-colors hover:border-white/25 hover:text-zinc-200"
            aria-label="关闭通知"
          >
            <X className="h-3.5 w-3.5" />
          </button>
        ) : null}
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
