const HUD_ICON_BASE = "/hud-death-notice";

function HudEquipmentIcon({ stem, className = "", style }) {
  return (
    <img
      src={`${HUD_ICON_BASE}/${stem}.svg`}
      alt=""
      draggable={false}
      className={`block object-contain ${className}`}
      style={style}
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
 * `fitScale` counters scene CSS shrink so the chip stays readable at Fit.
 */
export default function ReplayBombMarker({ status, site = "", style, className = "", fitScale = 1 }) {
  const muted = status === "defused" || status === "exploded";
  const planted = status === "planted";
  const dropped = status === "dropped";
  const invFit = 1 / Math.max(Number(fitScale) || 1, 0.05);
  // Target ~14px (dropped) / ~18px (planted) on-screen at Fit.
  const chipPx = (dropped ? 14 : 18) * invFit;
  const iconPx = (dropped ? 10 : 13) * invFit;
  const ringPx = 18 * invFit;

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
              className="planted-c4-ring pointer-events-none absolute left-1/2 top-1/2 rounded-full border-2 border-orange-500"
              style={{ width: ringPx, height: ringPx, marginLeft: -ringPx / 2, marginTop: -ringPx / 2 }}
              aria-hidden="true"
            />
            <span
              className="planted-c4-ring pointer-events-none absolute left-1/2 top-1/2 rounded-full border-2 border-orange-500"
              style={{ width: ringPx, height: ringPx, marginLeft: -ringPx / 2, marginTop: -ringPx / 2 }}
              aria-hidden="true"
            />
          </>
        )}
        <div
          className={`relative z-[1] flex items-center justify-center rounded-[2px] border ${chipTone}`}
          style={{ width: chipPx, height: chipPx }}
        >
          <HudEquipmentIcon stem="c4" className="brightness-0" style={{ width: iconPx, height: iconPx }} />
        </div>
      </div>
    </div>
  );
}
