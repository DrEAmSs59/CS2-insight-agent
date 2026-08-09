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
  const percent = Math.round(Number(userZoom) * 100) || 100;
  return (
    <div
      className={`pointer-events-auto absolute z-30 flex items-center gap-1 rounded-md border border-cs2-border bg-cs2-bg-card/95 p-0.5 shadow-lg ${className}`}
      role="group"
      aria-label="地图缩放"
    >
      <button
        type="button"
        aria-label="缩小"
        onClick={onZoomOut}
        className="flex h-7 w-7 items-center justify-center rounded text-[12px] font-bold text-cs2-text-secondary hover:bg-cs2-bg-input hover:text-cs2-text-primary"
      >
        −
      </button>
      <span className="min-w-[3.25rem] px-1 text-center font-mono text-[10px] font-bold text-cs2-text-primary" aria-live="polite">
        {percent}%
      </span>
      <button
        type="button"
        aria-label="放大"
        onClick={onZoomIn}
        className="flex h-7 w-7 items-center justify-center rounded text-[12px] font-bold text-cs2-text-secondary hover:bg-cs2-bg-input hover:text-cs2-text-primary"
      >
        +
      </button>
      <button
        type="button"
        aria-label="适应"
        onClick={onFit}
        className="rounded px-2 py-1 text-[9px] font-bold text-cs2-text-muted hover:bg-cs2-bg-input hover:text-cs2-text-primary"
      >
        适应
      </button>
    </div>
  );
}
