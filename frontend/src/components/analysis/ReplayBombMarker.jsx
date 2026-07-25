const HUD_ICON_BASE = "/hud-death-notice";

function HudEquipmentIcon({ stem, className = "" }) {
  return (
    <img
      src={`${HUD_ICON_BASE}/${stem}.svg`}
      alt=""
      draggable={false}
      className={`block object-contain ${className}`}
    />
  );
}

function bombTitle(status, site) {
  if (status === "planted") {
    return `C4 已放置${site ? ` · ${site} 区` : ""}`;
  }
  if (status === "dropped") return "C4 已掉落";
  if (status === "defused") return "C4 已拆除";
  if (status === "exploded") return "C4 已引爆";
  return "C4";
}

/**
 * Ground C4 marker: dropped (static dark-gold) vs planted (orange-red + pulse rings).
 * Positioning (`left`/`top` %) is passed via `style` from the scene canvas.
 */
export default function ReplayBombMarker({ status, site = "", style, className = "" }) {
  const muted = status === "defused" || status === "exploded";
  const planted = status === "planted";
  const dropped = status === "dropped";

  const chipSize = dropped ? "h-3 w-3" : "h-4 w-4";
  const iconSize = dropped ? "h-2.5 w-2.5" : "h-3 w-3";
  const chipTone = planted
    ? "border-orange-300 bg-orange-600"
    : dropped
      ? "border-amber-700 bg-amber-800"
      : "border-amber-200 bg-amber-400";

  return (
    <div
      className={`demo-c4-marker pointer-events-none absolute z-[4] -translate-x-1/2 -translate-y-1/2 ${muted ? "opacity-45" : ""} ${className}`}
      style={style}
      title={bombTitle(status, site)}
      data-bomb-status={status}
    >
      <style>{`
        @keyframes planted-c4-pulse {
          0% { transform: scale(0.55); opacity: 0.85; }
          100% { transform: scale(2.5); opacity: 0; }
        }
        .planted-c4-ring {
          animation: planted-c4-pulse 1.2s linear infinite;
          transform-origin: center;
        }
        .planted-c4-ring:nth-child(2) {
          animation-delay: 0.6s;
        }
      `}</style>
      <div className="relative flex items-center justify-center">
        {planted && (
          <>
            <span
              className="planted-c4-ring pointer-events-none absolute left-1/2 top-1/2 h-4 w-4 -ml-2 -mt-2 rounded-full border-2 border-orange-500"
              aria-hidden="true"
            />
            <span
              className="planted-c4-ring pointer-events-none absolute left-1/2 top-1/2 h-4 w-4 -ml-2 -mt-2 rounded-full border-2 border-orange-500"
              aria-hidden="true"
            />
          </>
        )}
        <div className={`relative z-[1] flex ${chipSize} items-center justify-center rounded-[2px] border ${chipTone}`}>
          <HudEquipmentIcon stem="c4" className={`${iconSize} brightness-0`} />
        </div>
      </div>
    </div>
  );
}
