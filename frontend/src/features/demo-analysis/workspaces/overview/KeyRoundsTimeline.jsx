import { useT } from "../../../../i18n/useT.js";
import { Play } from "lucide-react";
import { AccentButton, SectionHeader } from "../../AnalysisUi.jsx";

const TONE_STYLES = {
  accent: {
    badge: "bg-cs2-accent-soft text-cs2-accent",
    dot: "bg-cs2-accent",
  },
  amber: {
    badge: "bg-cs2-amber-surface text-cs2-amber-on-surface",
    dot: "bg-cs2-team-amber",
  },
  violet: {
    badge: "bg-cs2-violet-surface text-cs2-violet-on-surface",
    dot: "bg-violet-400",
  },
  blue: {
    badge: "bg-cs2-cyan-surface text-cs2-cyan-on-surface",
    dot: "bg-cs2-team-blue",
  },
};

function typeBadgeLabel(types, t) {
  const set = new Set(types || []);
  if (set.has("final")) return t("analysis.overview.badgeFinal");
  if (set.has("clutch")) return t("analysis.overview.clutch");
  if (set.has("ace")) return "ACE";
  if (set.has("multikill")) return t("analysis.overview.quadKill");
  if (set.has("force_upset")) return t("analysis.overview.badgeForce");
  if (set.has("economy_upset")) return t("analysis.overview.badgeEconomy");
  if (set.has("pistol")) return t("analysis.overview.pistolRound");
  if (set.has("lead_change")) return t("analysis.overview.badgeLeadChange");
  if (set.has("streak_start")) return t("analysis.overview.badgeStreak");
  if (set.has("match_point")) return t("analysis.overview.badgeMatchPoint");
  return t("analysis.overview.badgeKey");
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

function roundHeading(round, t) {
  const n = round.roundNumber;
  if (n == null) return t("analysis.overview.round");
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
  const t = useT();
  const list = Array.isArray(rounds) ? rounds : [];
  const canOpen = typeof onOpenRound === "function";
  const canReplay = typeof onOpenReplayRound === "function";

  if (list.length === 0) return null;

  return (
    <section>
      <SectionHeader
        level={2}
        title={t("analysis.overview.keyRounds")}
        description={canReplay ? t("analysis.overview.keyRoundsReplayHint") : t("analysis.overview.keyRoundsHint")}
        className="mb-2"
      />

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
                  className={`analysis-card flex min-h-[124px] flex-col p-3 text-left ${
                    openEnabled ? "analysis-card--interactive cursor-pointer" : ""
                  }`}
                >
                  <div className="flex items-center gap-1.5">
                    <span className="whitespace-nowrap font-mono text-[13px] font-bold text-cs2-text-primary">
                      {roundHeading(round, t)}
                    </span>
                    <span
                      data-overview-tone-tag
                      className={`inline-flex h-5 items-center rounded-full px-2 text-[11px] font-semibold ${styles.badge}`}
                    >
                      {typeBadgeLabel(round.types, t)}
                    </span>
                  </div>
                  <p className="mt-1.5 truncate text-[13px] font-semibold text-cs2-text-primary">
                    {round.playerName ? `${round.playerName} · ` : ""}
                    {round.title || t("analysis.overview.keyRounds")}
                  </p>
                  <p className="mt-0.5 line-clamp-2 text-[11.5px] leading-snug text-cs2-text-muted">
                    {round.description || ""}
                  </p>
                  {replayEnabled ? (
                    <div className="mt-auto pt-2">
                      <AccentButton
                        size="sm"
                        aria-label={t("analysis.overview.keyRoundReplay", { n: roundNumber })}
                        onClick={(e) => {
                          e.stopPropagation();
                          onOpenReplayRound(roundNumber);
                        }}
                      >
                        <Play className="h-3 w-3" fill="currentColor" aria-hidden />
                        {t("analysis.workspace.tabReplay")}
                      </AccentButton>
                    </div>
                  ) : null}
                </div>

                <div className="mt-1.5 flex flex-col items-center">
                  <div className="h-2 w-px bg-cs2-border" />
                  <span className={`h-2 w-2 rounded-full ${styles.dot}`} />
                  <span className="mt-0.5 font-mono text-[11px] text-cs2-text-muted">
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
