import { Play } from "lucide-react";

const TONE_STYLES = {
  accent: {
    badge: "bg-cs2-accent-soft text-cs2-accent",
    dot: "bg-cs2-accent",
  },
  amber: {
    badge: "bg-cs2-amber-surface text-cs2-amber-on-surface",
    dot: "bg-amber-400",
  },
  violet: {
    badge: "bg-cs2-violet-surface text-cs2-violet-on-surface",
    dot: "bg-violet-400",
  },
  blue: {
    badge: "bg-cs2-cyan-surface text-cs2-cyan-on-surface",
    dot: "bg-sky-400",
  },
};

function typeBadgeLabel(types) {
  const set = new Set(types || []);
  if (set.has("final")) return "终局";
  if (set.has("clutch")) return "残局";
  if (set.has("ace")) return "ACE";
  if (set.has("multikill")) return "四杀";
  if (set.has("force_upset")) return "强起";
  if (set.has("economy_upset")) return "经济";
  if (set.has("pistol")) return "手枪局";
  if (set.has("lead_change")) return "转折";
  if (set.has("streak_start")) return "连胜";
  if (set.has("match_point")) return "赛点";
  return "关键";
}

function resolveTone(round) {
  if (round?.tone && TONE_STYLES[round.tone]) return round.tone;
  const set = new Set(round?.types || []);
  if (set.has("final")) return "accent";
  if (set.has("clutch")) return "violet";
  if (set.has("force_upset") || set.has("economy_upset")) return "amber";
  if (set.has("ace") || set.has("multikill")) return "accent";
  return "blue";
}

function roundHeading(round) {
  const n = round.roundNumber;
  if (n == null) return "回合";
  if (round.scoreA != null && round.scoreB != null) {
    return `R${n} ${round.scoreA}:${round.scoreB}`;
  }
  return `R${n}`;
}

/**
 * @param {{
 *   rounds?: Array<object>,
 *   onOpenRound?: (roundNumber: number) => void,
 *   onOpenReplayRound?: (roundNumber: number) => void,
 * }} props
 */
export default function KeyRoundsTimeline({ rounds, onOpenRound, onOpenReplayRound }) {
  const list = Array.isArray(rounds) ? rounds : [];
  const canOpen = typeof onOpenRound === "function";
  const canReplay = typeof onOpenReplayRound === "function";

  if (list.length === 0) return null;

  return (
    <section className="rounded-[10px] border border-cs2-border bg-cs2-bg-card p-3">
      <div className="mb-2 flex items-center gap-2">
        <span className="h-3.5 w-1 rounded-full bg-cs2-accent" />
        <h2 className="text-[12px] font-bold text-cs2-text-primary">关键回合</h2>
      </div>

      <div className="overflow-x-auto pb-0.5">
        <div className="flex w-full min-w-0 gap-2.5">
          {list.map((round) => {
            const tone = resolveTone(round);
            const styles = TONE_STYLES[tone] || TONE_STYLES.blue;
            const roundNumber = round.roundNumber;
            const openEnabled = canOpen && roundNumber != null;
            const replayEnabled = canReplay && roundNumber != null;

            return (
              <div key={roundNumber} className="flex min-w-[188px] flex-1 basis-0 flex-col">
                <div
                  role={openEnabled ? "button" : undefined}
                  tabIndex={openEnabled ? 0 : undefined}
                  onClick={() => {
                    if (openEnabled) onOpenRound(roundNumber);
                  }}
                  onKeyDown={(e) => {
                    if (!openEnabled) return;
                    if (e.key === "Enter" || e.key === " ") {
                      e.preventDefault();
                      onOpenRound(roundNumber);
                    }
                  }}
                  className={`flex h-[88px] flex-col rounded-lg border border-cs2-border bg-cs2-bg-input/30 px-2.5 py-2 text-left transition-colors ${
                    openEnabled ? "cursor-pointer hover:border-cs2-accent/40" : ""
                  }`}
                >
                  <div className="flex items-center gap-1.5">
                    <span className="whitespace-nowrap font-mono text-[11px] font-bold text-cs2-text-primary">
                      {roundHeading(round)}
                    </span>
                    <span
                      data-overview-tone-tag
                      className={`inline-flex rounded px-1.5 py-0.5 text-[9px] font-semibold ${styles.badge}`}
                    >
                      {typeBadgeLabel(round.types)}
                    </span>
                    <span className="flex-1" />
                    {replayEnabled ? (
                      <button
                        type="button"
                        title="打开 2D 回放"
                        className="flex h-6 w-6 shrink-0 items-center justify-center rounded-md border border-cs2-border bg-cs2-bg-card text-cs2-text-secondary hover:border-cs2-accent/45 hover:text-cs2-accent"
                        onClick={(e) => {
                          e.stopPropagation();
                          onOpenReplayRound(roundNumber);
                        }}
                      >
                        <Play className="h-3 w-3" fill="currentColor" />
                      </button>
                    ) : null}
                  </div>
                  <p className="mt-1 truncate text-[11px] font-semibold text-cs2-text-primary">
                    {round.playerName ? `${round.playerName} · ` : ""}
                    {round.title || "关键回合"}
                  </p>
                  <p className="mt-0.5 line-clamp-2 text-[10px] leading-snug text-cs2-text-muted">
                    {round.description || ""}
                  </p>
                </div>

                <div className="mt-1.5 flex flex-col items-center">
                  <div className="h-2 w-px bg-cs2-border" />
                  <span className={`h-2 w-2 rounded-full ${styles.dot}`} />
                  <span className="mt-0.5 font-mono text-[9px] text-cs2-text-muted">
                    {round.timestamp || `R${roundNumber}`}
                  </span>
                </div>
              </div>
            );
          })}
        </div>
      </div>
    </section>
  );
}
