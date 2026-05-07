/**
 * @param {{
 *   result?: string | null,
 *   targetKills: number,
 *   targetDeaths: number,
 *   glow?: boolean,
 * }} props
 */
export default function TimelineNode({ result, targetKills, targetDeaths, glow = false }) {
  const won = result === "win";
  const lost = result === "loss";
  const hasKill = targetKills > 0;
  const hasDeath = targetDeaths > 0;
  const multiKill = targetKills >= 3;

  let ring = "ring-1 ring-white/12";
  let fill = "bg-[#ff8c00]";
  if (won) {
    ring = "ring-2 ring-emerald-500/70";
    fill = "bg-emerald-500";
  } else if (lost) {
    ring = "ring-2 ring-rose-500/65";
    fill = "bg-rose-500";
  }

  const innerDot =
    hasDeath ? (
      <span className="absolute left-1/2 top-1/2 block h-1.5 w-1.5 -translate-x-1/2 -translate-y-1/2 rounded-full bg-rose-200 shadow-[0_0_6px_rgba(251,113,133,0.9)]" />
    ) : null;

  return (
    <div className="flex h-full min-h-[48px] w-full items-start justify-center pt-2">
      <div className="relative flex items-center justify-center">
        {hasKill ? (
          <span
            className={[
              "timeline-dot relative z-[1] flex h-4 w-4 shrink-0 items-center justify-center rounded-full border border-black/50",
              ring,
              fill,
              multiKill ? "shadow-[0_0_14px_rgba(250,204,21,0.75)]" : "",
              glow ? "shadow-[0_0_18px_rgba(255,140,0,0.85)]" : "",
            ].join(" ")}
          >
            {innerDot}
          </span>
        ) : (
          <span
            className={[
              "timeline-dot relative z-[1] flex h-3.5 w-3.5 shrink-0 items-center justify-center rounded-full border border-black/50",
              ring,
              fill,
              glow ? "shadow-[0_0_16px_rgba(255,140,0,0.8)]" : "",
            ].join(" ")}
          >
            {innerDot}
          </span>
        )}
      </div>
    </div>
  );
}
