import { ShieldAlert, X } from "lucide-react";

/**
 * 推断对话框副标题：根据后端返回的 detail 文本判定具体阻断场景。
 */
function recordingBlockedSubtitle(message) {
  const m = String(message || "");
  if (
    m.includes("分辨率") ||
    m.includes("屏幕比例") ||
    m.includes("宽高") ||
    m.includes("启动分辨率") ||
    m.includes("所选屏幕比例") ||
    m.includes("填写启动分辨率")
  ) {
    return "录制预热选项未通过校验";
  }
  if (m.includes("GSI") || m.includes("未就绪") || m.includes("未进入游戏")) {
    return "CS2 未在限定时间内进入游戏画面";
  }
  if (m.includes("正在运行") || (m.includes("CS2") && m.includes("退出"))) {
    return "当前检测到 CS2 正在运行";
  }
  if (m.includes("已有录制任务")) {
    return "已有录制任务进行中";
  }
  if (m.includes("尚未恢复") || m.includes("异常退出") || m.includes("一键恢复")) {
    return "玩家配置需要先恢复";
  }
  return "录制启动条件未满足";
}

export default function RecordingBlockedDialog({ message, onClose }) {
  if (!message) return null;
  const subtitle = recordingBlockedSubtitle(message);
  return (
    <div
      className="fixed inset-0 z-[120] flex items-center justify-center bg-black/70 px-4 py-6 backdrop-blur-sm"
      role="dialog"
      aria-modal="true"
      aria-labelledby="recording-blocked-title"
      onClick={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div className="relative w-full max-w-md overflow-hidden rounded-xl border border-cs2-border bg-cs2-bg-card shadow-2xl">
        <button
          type="button"
          onClick={onClose}
          className="absolute right-3 top-3 rounded-md p-1.5 text-cs2-text-muted hover:bg-cs2-bg-input/50 hover:text-cs2-text-secondary"
          aria-label="关闭"
        >
          <X className="h-4 w-4" />
        </button>

        <div className="flex items-start gap-3 border-b border-cs2-border px-5 py-4">
          <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg border border-cs2-accent/30 bg-cs2-accent/10 text-cs2-accent">
            <ShieldAlert className="h-5 w-5" />
          </div>
          <div className="min-w-0 pr-7">
            <h2 id="recording-blocked-title" className="text-sm font-bold text-cs2-text-primary">
              无法开始录制
            </h2>
            <p className="mt-1 text-[12px] leading-relaxed text-cs2-text-muted">{subtitle}</p>
          </div>
        </div>

        <div className="px-5 py-4">
          <p className="text-sm leading-6 text-cs2-text-secondary whitespace-pre-wrap break-words">{message}</p>
        </div>

        <div className="flex justify-end border-t border-cs2-border bg-cs2-bg-input/30 px-5 py-3">
          <button
            type="button"
            onClick={onClose}
            className="rounded-lg bg-cs2-accent px-4 py-2 text-sm font-extrabold text-cs2-text-on-accent shadow-lg shadow-cs2-accent/20 transition-colors hover:bg-cs2-accent-light"
          >
            知道了
          </button>
        </div>
      </div>
    </div>
  );
}
