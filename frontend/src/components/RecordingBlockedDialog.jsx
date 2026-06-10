import { ShieldAlert, X } from "lucide-react";
import { useNavigate } from "react-router-dom";
import { API_ERROR_SUBTITLE_KEYS } from "../utils/apiErrorMessages.js";
import { useT } from "../i18n/useT.js";

/**
 * 推断对话框副标题：优先 detail.code，其次根据后端文案关键词（兼容旧响应）。
 */
function recordingBlockedSubtitleKey(message, errorCode) {
  if (errorCode && API_ERROR_SUBTITLE_KEYS[errorCode]) {
    return API_ERROR_SUBTITLE_KEYS[errorCode];
  }
  const m = String(message || "");
  if (
    m.includes("分辨率") ||
    m.includes("屏幕比例") ||
    m.includes("宽高") ||
    m.includes("启动分辨率") ||
    m.includes("所选屏幕比例") ||
    m.includes("填写启动分辨率") ||
    m.toLowerCase().includes("resolution") ||
    m.toLowerCase().includes("aspect ratio")
  ) {
    return "dialog.recordBlockedSubResolution";
  }
  if (
    m.includes("GSI") ||
    m.includes("未就绪") ||
    m.includes("未进入游戏") ||
    m.toLowerCase().includes("not ready") ||
    m.toLowerCase().includes("did not enter")
  ) {
    return "dialog.recordBlockedSubGsi";
  }
  if (
    m.includes("正在运行") ||
    (m.includes("CS2") && m.includes("退出")) ||
    (m.toLowerCase().includes("cs2") && m.toLowerCase().includes("running"))
  ) {
    return "dialog.recordBlockedSubRunning";
  }
  if (m.includes("已有录制任务") || m.toLowerCase().includes("already in progress")) {
    return "dialog.recordBlockedSubAlreadyRecording";
  }
  if (
    m.includes("尚未恢复") ||
    m.includes("异常退出") ||
    m.includes("一键恢复") ||
    m.includes("玩家配置") ||
    m.toLowerCase().includes("restore") && m.toLowerCase().includes("config")
  ) {
    return "dialog.recordBlockedSubConfigRestore";
  }
  return "dialog.recordBlockedSubDefault";
}

function isConfigBackupMessage(message, errorCode) {
  if (
    errorCode === "RECORDING_CONFIG_RESTORE_REQUIRED" ||
    errorCode === "CONFIG_RESTORE_REQUIRED"
  ) {
    return true;
  }
  const m = String(message || "");
  return (
    m.includes("尚未恢复") ||
    m.includes("异常退出") ||
    m.includes("一键恢复") ||
    m.includes("玩家配置") ||
    (m.toLowerCase().includes("restore") && m.toLowerCase().includes("config"))
  );
}

export default function RecordingBlockedDialog({ message, errorCode = null, onClose }) {
  const t = useT();
  const navigate = useNavigate();
  if (!message) return null;
  const subtitleKey = recordingBlockedSubtitleKey(message, errorCode);
  const showConfigLink = isConfigBackupMessage(message, errorCode);
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
          aria-label={t("dialog.recordBlockedClose")}
        >
          <X className="h-4 w-4" />
        </button>

        <div className="flex items-start gap-3 border-b border-cs2-border px-5 py-4">
          <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg border border-cs2-accent/30 bg-cs2-accent/10 text-cs2-accent">
            <ShieldAlert className="h-5 w-5" />
          </div>
          <div className="min-w-0 pr-7">
            <h2 id="recording-blocked-title" className="text-sm font-bold text-cs2-text-primary">
              {t("dialog.recordBlockedTitle")}
            </h2>
            <p className="mt-1 text-[12px] leading-relaxed text-cs2-text-muted">{t(subtitleKey)}</p>
          </div>
        </div>

        <div className="px-5 py-4">
          <p className="text-sm leading-6 text-cs2-text-secondary whitespace-pre-wrap break-words">{message}</p>
        </div>

        <div className="flex justify-end gap-2.5 border-t border-cs2-border bg-cs2-bg-input/30 px-5 py-3">
          {showConfigLink ? (
            <button
              type="button"
              onClick={() => { onClose(); navigate("/player-game-config"); }}
              className="rounded-lg border border-cs2-accent/40 bg-cs2-accent/10 px-4 py-2 text-sm font-bold text-cs2-accent transition-colors hover:bg-cs2-accent/20"
            >
              {t("dialog.recordBlockedGoConfig")}
            </button>
          ) : null}
          <button
            type="button"
            onClick={onClose}
            className="rounded-lg bg-cs2-accent px-4 py-2 text-sm font-extrabold text-cs2-text-on-accent shadow-lg shadow-cs2-accent/20 transition-colors hover:bg-cs2-accent-light"
          >
            {t("dialog.recordBlockedOk")}
          </button>
        </div>
      </div>
    </div>
  );
}
