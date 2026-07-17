import { useCallback, useEffect, useRef, useState } from "react";
import { AlertCircle, Play, X } from "lucide-react";
import { useT } from "../i18n/useT.js";

/**
 * Demo 库同款播放结果 toast。
 * @returns {{
 *   playToast: { ok: boolean, label: string } | null,
 *   showPlayToast: (ok: boolean, label: string) => void,
 *   PlayDemoToast: () => import("react").ReactNode,
 * }}
 */
export function usePlayDemoToast() {
  const t = useT();
  const [playToast, setPlayToast] = useState(null);
  const playToastTimer = useRef(null);

  const showPlayToast = useCallback((ok, label) => {
    clearTimeout(playToastTimer.current);
    setPlayToast({ ok, label });
    playToastTimer.current = setTimeout(() => setPlayToast(null), 4000);
  }, []);

  useEffect(() => () => clearTimeout(playToastTimer.current), []);

  const PlayDemoToast = useCallback(() => {
    if (!playToast) return null;
    return (
      <div
        className="fixed bottom-6 right-6 z-[200] flex items-start gap-3 rounded-lg border bg-cs2-bg-card px-4 py-3 shadow-2xl animate-in slide-in-from-bottom-4 fade-in duration-200"
        style={{
          borderColor: playToast.ok ? "rgb(52 211 153 / 0.4)" : "rgb(248 113 113 / 0.4)",
        }}
      >
        <div
          className={`mt-0.5 flex h-5 w-5 shrink-0 items-center justify-center rounded-full ${
            playToast.ok
              ? "bg-cs2-emerald-surface text-cs2-emerald-on-surface"
              : "bg-cs2-red-surface text-cs2-red-on-surface"
          }`}
        >
          {playToast.ok ? (
            <Play className="h-3 w-3 fill-current" />
          ) : (
            <AlertCircle className="h-3 w-3" />
          )}
        </div>
        <div className="flex flex-col gap-0.5">
          <span
            className={`text-[12px] font-semibold ${
              playToast.ok ? "text-cs2-emerald-on-surface" : "text-cs2-red-on-surface"
            }`}
          >
            {playToast.ok ? t("library.playToastOk") : t("library.playToastFail")}
          </span>
          <span
            className="max-w-[260px] truncate font-mono text-[11px] text-cs2-text-muted"
            title={playToast.label}
          >
            {playToast.label}
          </span>
        </div>
        <button
          type="button"
          className="ml-2 mt-0.5 text-cs2-text-muted hover:text-cs2-text-primary"
          onClick={() => setPlayToast(null)}
        >
          <X className="h-3.5 w-3.5" />
        </button>
      </div>
    );
  }, [playToast, t]);

  return { playToast, showPlayToast, PlayDemoToast };
}
