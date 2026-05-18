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
    const effDismissMs = autoDismissAfterMs || (text?.includes("失败") || text?.includes("错误") || text?.includes("报错") ? 0 : 4500);
    if (!effDismissMs || effDismissMs <= 0 || !text?.trim()) return;
    // 解析读条 / 批量录制进行中时不计时，避免误关或中途消失
    if (active || batchRecording) return;
    const id = window.setTimeout(() => {
      onDismissRef.current?.();
    }, effDismissMs);
    return () => window.clearTimeout(id);
  }, [text, autoDismissAfterMs, active, batchRecording]);

  const showSpinner = active || batchRecording;
  return (
    <div className="relative bg-cs2-bg-card rounded-xl border border-cs2-border p-4">
      <div className="flex flex-wrap items-center gap-3">
        {showSpinner && <Loader2 className="h-4 w-4 shrink-0 animate-spin text-cs2-accent" aria-hidden />}
        <span className="min-w-0 flex-1 text-xs font-mono text-cs2-text-secondary">{text}</span>
        {showQueueNavigate ? (
          <button
            type="button"
            onClick={() => {
              navigate("/queue");
              onDismiss?.();
            }}
            className="inline-flex shrink-0 rounded-lg border border-cs2-accent/45 bg-cs2-accent/15 px-3 py-2 text-xs font-semibold text-cs2-accent transition-colors hover:bg-cs2-accent/25"
          >
            录制队列
          </button>
        ) : null}
        {dismissible && typeof onDismiss === "function" ? (
          <button
            type="button"
            onClick={() => onDismiss()}
            className="inline-flex shrink-0 rounded-md border border-cs2-border p-1.5 text-cs2-text-muted transition-colors hover:border-cs2-border hover:text-cs2-text-primary"
            aria-label="关闭通知"
          >
            <X className="h-3.5 w-3.5" />
          </button>
        ) : null}
        {batchRecording && typeof onAbortBatch === "function" ? (
          <button
            type="button"
            onClick={() => void onAbortBatch()}
            className="inline-flex shrink-0 items-center gap-1.5 rounded-lg border border-cs2-border-error/50 bg-cs2-rose-surface px-3 py-2 text-xs font-bold text-cs2-rose-on-surface transition-colors hover:bg-cs2-rose-surface"
          >
            <OctagonX className="h-3.5 w-3.5 shrink-0" aria-hidden />
            中止录制
          </button>
        ) : null}
      </div>
      {active && (
        <div className="mt-3 h-1 overflow-hidden rounded-full bg-cs2-bg-input">
          <div className="h-full w-[40%] animate-[indeterminate_1.5s_ease-in-out_infinite] rounded-full bg-gradient-to-r from-cs2-accent to-cs2-accent-light" />
        </div>
      )}
    </div>
  );
}
