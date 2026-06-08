import { Clapperboard } from "lucide-react";
import { useT } from "../i18n/useT.js";

/**
 * 合辑工作台门控：FFmpeg 未配置或不可用时展示，不可通过遮罩/关闭按钮 dismiss。
 */
export default function FfmpegRequiredDialog({ subtitle, message, onGoSettings }) {
  const t = useT();
  return (
    <div
      className="fixed inset-0 z-[130] flex items-center justify-center bg-black/70 px-4 py-6 backdrop-blur-sm"
      role="dialog"
      aria-modal="true"
      aria-labelledby="ffmpeg-required-title"
    >
      <div className="relative w-full max-w-md overflow-hidden rounded-xl border border-cs2-border bg-cs2-bg-card shadow-2xl">
        <div className="flex items-start gap-3 border-b border-cs2-border px-5 py-4">
          <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg border border-cs2-accent/30 bg-cs2-accent/10 text-cs2-accent">
            <Clapperboard className="h-5 w-5" />
          </div>
          <div className="min-w-0">
            <h2 id="ffmpeg-required-title" className="text-sm font-bold text-cs2-text-primary">
              {t("dialog.ffmpegRequiredTitle")}
            </h2>
            <p className="mt-1 text-[12px] leading-relaxed text-cs2-text-muted">
              {subtitle || t("dialog.ffmpegRequiredSubtitleDefault")}
            </p>
          </div>
        </div>

        <div className="px-5 py-4">
          <p className="text-sm leading-6 text-cs2-text-secondary whitespace-pre-wrap break-words">
            {message}
          </p>
        </div>

        <div className="flex justify-end border-t border-cs2-border bg-cs2-bg-input/30 px-5 py-3">
          <button
            type="button"
            onClick={onGoSettings}
            className="rounded-lg bg-cs2-accent px-4 py-2 text-sm font-extrabold text-cs2-text-on-accent shadow-lg shadow-cs2-accent/20 transition-colors hover:bg-cs2-accent-light"
          >
            {t("dialog.ffmpegRequiredGoSettings")}
          </button>
        </div>
      </div>
    </div>
  );
}
