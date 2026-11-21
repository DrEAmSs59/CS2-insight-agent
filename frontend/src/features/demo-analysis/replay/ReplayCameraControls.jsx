import { useT } from "../../../i18n/useT.js";

/**
 * Zoom / fit controls for the 2D replay viewport camera.
 */
export default function ReplayCameraControls({
  userZoom = 1,
  onZoomIn,
  onZoomOut,
  onFit,
  className = "top-3 left-3",
}) {
  const t = useT();
  const percent = Math.round(Number(userZoom) * 100) || 100;
  return (
    <div
      className={`pointer-events-auto absolute z-30 flex items-center gap-1 rounded-lg border border-cs2-border bg-cs2-bg-card/95 p-0.5 shadow-[var(--cs2-shadow-md)] backdrop-blur-sm ${className}`}
      role="group"
      aria-label={t("analysis.replay.mapZoom")}
    >
      <button
        type="button"
        aria-label={t("analysis.replay.zoomOut")}
        onClick={onZoomOut}
        className="flex h-7 w-7 items-center justify-center rounded-md text-sm font-semibold text-cs2-text-secondary transition-colors hover:bg-cs2-bg-hover hover:text-cs2-text-primary"
      >
        −
      </button>
      <span className="min-w-[3.25rem] px-1 text-center font-mono text-[11px] font-semibold text-cs2-text-primary" aria-live="polite">
        {percent}%
      </span>
      <button
        type="button"
        aria-label={t("analysis.replay.zoomIn")}
        onClick={onZoomIn}
        className="flex h-7 w-7 items-center justify-center rounded-md text-sm font-semibold text-cs2-text-secondary transition-colors hover:bg-cs2-bg-hover hover:text-cs2-text-primary"
      >
        +
      </button>
      <button
        type="button"
        aria-label={t("analysis.replay.fitMap")}
        onClick={onFit}
        className="h-7 rounded-md px-2.5 text-[11.5px] font-semibold text-cs2-text-secondary transition-colors hover:bg-cs2-bg-hover hover:text-cs2-text-primary"
      >
        {t("analysis.replay.fitMap")}
      </button>
    </div>
  );
}
