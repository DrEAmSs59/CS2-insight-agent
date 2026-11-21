import { useT } from "../../../../i18n/useT.js";
import { Coins } from "lucide-react";
import InsightCard from "./InsightCard";

/** 赢下几个手枪局，以及每个手枪局之后分别连胜多少 */
function formatPistolStreak(bucket, t) {
  if (!bucket || !(bucket.wins > 0)) return t("analysis.overview.noPistolWins");
  const streaks = Array.isArray(bucket.postWinStreaks) ? bucket.postWinStreaks : [];
  const wins = bucket.wins;
  if (streaks.length === 0) return t("analysis.overview.pistolWins", { wins });
  const detail = streaks
    .map((n, i) => t("analysis.overview.pistolStreak", { i: i + 1, n }))
    .join(" · ");
  return `${t("analysis.overview.pistolWins", { wins })} · ${detail}`;
}

function teamLabel(key, teamAName, teamBName) {
  if (key === "a") return teamAName;
  if (key === "b") return teamBName;
  return "—";
}

function CompactRow({ label, children }) {
  return (
    <div className="flex min-h-[34px] items-center gap-2 border-t border-cs2-border-subtle py-1 first:border-t-0">
      <span className="w-[84px] shrink-0 text-xs text-cs2-text-muted">{label}</span>
      <div className="min-w-0 flex-1">{children}</div>
    </div>
  );
}

/**
 * @param {{
 *   model?: object,
 *   teamAName?: string,
 *   teamBName?: string,
 *   className?: string,
 * }} props
 */
export default function EconomyInsightCard({
  model,
  teamAName = "Team A",
  teamBName = "Team B",
  className = "",
}) {
  const t = useT();
  const pistol = model?.pistol || {};
  const teamA = pistol.teamA || {};
  const teamB = pistol.teamB || {};
  const upsetRounds = Array.isArray(model?.upsetRounds) ? model.upsetRounds : [];
  const forceCountA = upsetRounds.filter((u) => u.isForceUpset && u.winnerTeamKey === "a").length;
  const forceCountB = upsetRounds.filter((u) => u.isForceUpset && u.winnerTeamKey === "b").length;
  const keyRound = model?.keyRound || null;
  const hasData = model?.hasData !== false;

  return (
    <InsightCard
      title={t("analysis.overview.economyPerformance")}
      icon={Coins}
      tone="accent"
      className={className}
    >
      {!hasData ? (
        <p className="text-xs text-cs2-text-muted">
          {model?.summary || t("analysis.overview.noEconomyUpsets")}
        </p>
      ) : (
        <div className="flex flex-1 flex-col justify-center text-xs">
          <CompactRow label={t("analysis.overview.pistolConversion")}>
            <div className="flex flex-col gap-0.5 leading-snug">
              <span>
                <span className="text-cs2-team-blue">{teamAName}</span>{" "}
                <span className="font-semibold text-cs2-text-primary">{formatPistolStreak(teamA, t)}</span>
              </span>
              <span>
                <span className="text-cs2-team-amber">{teamBName}</span>{" "}
                <span className="font-semibold text-cs2-text-primary">{formatPistolStreak(teamB, t)}</span>
              </span>
            </div>
          </CompactRow>
          <CompactRow label={t("analysis.overview.forceUpsets")}>
            <div className="flex flex-wrap items-center gap-x-3 gap-y-0.5">
              <span>
                <span className="text-cs2-team-blue">{teamAName}</span>{" "}
                <span className="font-bold tabular-nums text-cs2-text-primary">{forceCountA}</span>
              </span>
              <span>
                <span className="text-cs2-team-amber">{teamBName}</span>{" "}
                <span className="font-bold tabular-nums text-cs2-text-primary">{forceCountB}</span>
              </span>
            </div>
          </CompactRow>
          <CompactRow label={t("analysis.overview.keyEconomy")}>
            {keyRound ? (
              <span className="min-w-0 truncate text-cs2-text-secondary">
                R{keyRound.roundNumber}
                {keyRound.scoreA != null && keyRound.scoreB != null
                  ? ` ${keyRound.scoreA}:${keyRound.scoreB}`
                  : ""}
                {" · "}
                {teamLabel(keyRound.winnerTeamKey, teamAName, teamBName)}
                {" "}{keyRound.isForceUpset ? t("analysis.overview.forceUpset") : t("analysis.overview.economyUpset")}
              </span>
            ) : (
              <span className="text-cs2-text-muted">{t("analysis.overview.noKeyEconomy")}</span>
            )}
          </CompactRow>
        </div>
      )}
    </InsightCard>
  );
}
