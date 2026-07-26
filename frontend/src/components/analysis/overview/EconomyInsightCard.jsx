import { Coins } from "lucide-react";
import InsightCard from "./InsightCard";

/** 赢下几个手枪局，以及每个手枪局之后分别连胜多少 */
function formatPistolStreak(bucket) {
  if (!bucket || !(bucket.wins > 0)) return "未赢下手枪局";
  const streaks = Array.isArray(bucket.postWinStreaks) ? bucket.postWinStreaks : [];
  const wins = bucket.wins;
  if (streaks.length === 0) return `赢下 ${wins} 个手枪局`;
  const detail = streaks
    .map((n, i) => `第 ${i + 1} 个后连胜 ${n} 局`)
    .join(" · ");
  return `赢下 ${wins} 个手枪局 · ${detail}`;
}

function teamLabel(key, teamAName, teamBName) {
  if (key === "a") return teamAName;
  if (key === "b") return teamBName;
  return "—";
}

function CompactRow({ label, children }) {
  return (
    <div className="flex min-h-[32px] items-center gap-2 border-t border-cs2-border/50 first:border-t-0">
      <span className="w-[78px] shrink-0 text-[10px] text-cs2-text-muted">{label}</span>
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
      title="经济表现"
      icon={<Coins className="h-3.5 w-3.5 text-cs2-accent" />}
      compact
      className={className}
    >
      {!hasData ? (
        <p className="text-[11px] text-cs2-text-muted">
          {model?.summary || "本场未产生明显经济翻盘回合"}
        </p>
      ) : (
        <div className="flex flex-1 flex-col justify-center text-[11px]">
          <CompactRow label="手枪局转化率">
            <div className="flex flex-col gap-0.5 leading-snug">
              <span>
                <span className="text-sky-400">{teamAName}</span>{" "}
                <span className="font-semibold text-cs2-text-primary">{formatPistolStreak(teamA)}</span>
              </span>
              <span>
                <span className="text-amber-400">{teamBName}</span>{" "}
                <span className="font-semibold text-cs2-text-primary">{formatPistolStreak(teamB)}</span>
              </span>
            </div>
          </CompactRow>
          <CompactRow label="强起翻盘回合">
            <div className="flex flex-wrap items-center gap-x-3 gap-y-0.5">
              <span>
                <span className="text-sky-400">{teamAName}</span>{" "}
                <span className="font-bold tabular-nums text-cs2-text-primary">{forceCountA}</span>
              </span>
              <span>
                <span className="text-amber-400">{teamBName}</span>{" "}
                <span className="font-bold tabular-nums text-cs2-text-primary">{forceCountB}</span>
              </span>
            </div>
          </CompactRow>
          <CompactRow label="关键经济回合">
            {keyRound ? (
              <span className="min-w-0 truncate text-cs2-text-secondary">
                R{keyRound.roundNumber}
                {keyRound.scoreA != null && keyRound.scoreB != null
                  ? ` ${keyRound.scoreA}:${keyRound.scoreB}`
                  : ""}
                {" · "}
                {teamLabel(keyRound.winnerTeamKey, teamAName, teamBName)}
                {keyRound.isForceUpset ? " 强起翻盘" : " 经济翻盘"}
              </span>
            ) : (
              <span className="text-cs2-text-muted">本场无明显经济翻盘回合</span>
            )}
          </CompactRow>
        </div>
      )}
    </InsightCard>
  );
}
