import {
  Crosshair,
  Flame,
  Play,
  Shield,
  Swords,
  Target,
  Trophy,
} from "lucide-react";

const TONE_STYLES = {
  accent: {
    badge: "border-cs2-accent/35 bg-cs2-accent-soft text-cs2-accent",
    dot: "bg-cs2-accent",
    icon: "bg-cs2-accent-soft text-cs2-accent",
  },
  amber: {
    badge: "border-amber-500/30 bg-amber-500/10 text-amber-300",
    dot: "bg-amber-400",
    icon: "bg-amber-500/10 text-amber-300",
  },
  violet: {
    badge: "border-violet-500/30 bg-violet-500/10 text-violet-300",
    dot: "bg-violet-400",
    icon: "bg-violet-500/10 text-violet-300",
  },
  blue: {
    badge: "border-sky-500/30 bg-sky-500/10 text-sky-300",
    dot: "bg-sky-400",
    icon: "bg-sky-500/10 text-sky-300",
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

function roundIcon(types) {
  const set = new Set(types || []);
  if (set.has("final")) return Trophy;
  if (set.has("clutch")) return Shield;
  if (set.has("ace") || set.has("multikill")) return Flame;
  if (set.has("force_upset") || set.has("economy_upset")) return Target;
  if (set.has("pistol")) return Crosshair;
  return Swords;
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

  if (list.length === 0) {
    return (
      <section className="rounded-xl border border-cs2-border bg-cs2-bg-card p-4">
        <h2 className="text-[13px] font-bold text-cs2-text-primary">关键回合</h2>
        <p className="mt-3 text-center text-[11px] text-cs2-text-muted">暂无关键回合可展示。</p>
      </section>
    );
  }

  return (
    <section className="rounded-xl border border-cs2-border bg-cs2-bg-card p-3.5 shadow-sm">
      <div className="mb-3 flex items-center gap-2">
        <span className="h-4 w-1 rounded-full bg-cs2-accent" />
        <h2 className="text-[13px] font-bold text-cs2-text-primary">关键回合</h2>
      </div>

      <div className="overflow-x-auto pb-1">
        <div className="flex min-w-max gap-3">
          {list.map((round) => {
            const tone = resolveTone(round);
            const styles = TONE_STYLES[tone] || TONE_STYLES.blue;
            const Icon = roundIcon(round.types);
            const roundNumber = round.roundNumber;
            const openEnabled = canOpen && roundNumber != null;
            const replayEnabled = canReplay && roundNumber != null;

            return (
              <div key={roundNumber} className="flex w-[220px] shrink-0 flex-col">
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
                  className={`relative flex min-h-[112px] flex-col rounded-xl border border-cs2-border bg-cs2-bg-input/30 p-3 text-left transition-colors ${
                    openEnabled ? "cursor-pointer hover:border-cs2-accent/40" : ""
                  }`}
                >
                  <div className="flex items-start gap-2">
                    <div
                      className={`flex h-8 w-8 shrink-0 items-center justify-center rounded-lg ${styles.icon}`}
                    >
                      <Icon className="h-3.5 w-3.5" />
                    </div>
                    <div className="min-w-0 flex-1">
                      <div className="flex items-center gap-1.5">
                        <span className="font-mono text-[11px] font-bold text-cs2-text-primary">
                          R{roundNumber}
                        </span>
                        <span
                          className={`inline-flex rounded border px-1.5 py-0.5 text-[9px] font-semibold ${styles.badge}`}
                        >
                          {typeBadgeLabel(round.types)}
                        </span>
                      </div>
                      <p className="mt-0.5 truncate text-[12px] font-semibold text-cs2-text-primary">
                        {round.title || "关键回合"}
                      </p>
                    </div>
                    {replayEnabled ? (
                      <button
                        type="button"
                        title="打开 2D 回放"
                        className="flex h-7 w-7 shrink-0 items-center justify-center rounded-md border border-cs2-border bg-cs2-bg-card text-cs2-text-secondary hover:border-cs2-accent/45 hover:text-cs2-accent"
                        onClick={(e) => {
                          e.stopPropagation();
                          onOpenReplayRound(roundNumber);
                        }}
                      >
                        <Play className="h-3 w-3" fill="currentColor" />
                      </button>
                    ) : null}
                  </div>
                  <p className="mt-2 line-clamp-2 text-[10px] leading-snug text-cs2-text-muted">
                    {round.description || ""}
                  </p>
                </div>

                <div className="mt-2 flex flex-col items-center">
                  <div className="h-3 w-px bg-cs2-border" />
                  <span className={`h-2.5 w-2.5 rounded-full ${styles.dot}`} />
                  <span className="mt-1 font-mono text-[9px] text-cs2-text-muted">
                    {round.timestamp || `R${roundNumber}`}
                  </span>
                </div>
              </div>
            );
          })}
        </div>

        {list.length > 1 ? (
          <div className="relative mx-3 mt-1 h-px bg-cs2-border">
            <div className="absolute inset-x-0 -top-px" />
          </div>
        ) : null}
      </div>
    </section>
  );
}
