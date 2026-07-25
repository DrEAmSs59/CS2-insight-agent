import { Coins, Play } from "lucide-react";
import InsightCard from "./InsightCard";

function formatPistol(bucket) {
  if (!bucket) return "—";
  const wins = bucket.wins ?? 0;
  if (!(bucket.conversionTotal > 0)) return `${wins}/—`;
  return `${wins}/${bucket.conversionWins ?? 0}`;
}

function teamLabel(key, teamAName, teamBName) {
  if (key === "a") return teamAName;
  if (key === "b") return teamBName;
  return "—";
}

function CompactRow({ label, children }) {
  return (
    <div className="flex min-h-[32px] items-center gap-2 border-t border-cs2-border/50 first:border-t-0">
      <span className="w-[72px] shrink-0 text-[10px] text-cs2-text-muted">{label}</span>
      <div className="min-w-0 flex-1">{children}</div>
    </div>
  );
}

/**
 * @param {{
 *   model?: object,
 *   onOpenRound?: (roundNumber: number) => void,
 *   teamAName?: string,
 *   teamBName?: string,
 *   className?: string,
 * }} props
 */
export default function EconomyInsightCard({
  model,
  onOpenRound,
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
  const canOpen = typeof onOpenRound === "function" && keyRound?.roundNumber != null;

  return (
    <InsightCard
      title="经济表现"
      icon={<Coins className="h-3.5 w-3.5 text-cs2-accent" />}
      compact
      className={`h-full min-h-[180px] xl:min-h-[190px] ${className}`}
    >
      {!hasData ? (
        <p className="text-[11px] text-cs2-text-muted">
          {model?.summary || "本场未产生明显经济翻盘回合"}
        </p>
      ) : (
        <div className="text-[11px]">
          <CompactRow label="手枪局转化">
            <div className="flex flex-wrap items-center gap-x-3 gap-y-0.5">
              <span>
                <span className="text-sky-400">{teamAName}</span>{" "}
                <span className="font-bold tabular-nums text-cs2-text-primary">{formatPistol(teamA)}</span>
              </span>
              <span>
                <span className="text-amber-400">{teamBName}</span>{" "}
                <span className="font-bold tabular-nums text-cs2-text-primary">{formatPistol(teamB)}</span>
              </span>
            </div>
          </CompactRow>
          <CompactRow label="强起翻盘">
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
          {keyRound ? (
            <button
              type="button"
              disabled={!canOpen}
              onClick={() => {
                if (canOpen) onOpenRound(keyRound.roundNumber);
              }}
              className="flex min-h-[32px] w-full items-center gap-2 border-t border-cs2-border/50 text-left transition-colors hover:text-cs2-accent disabled:cursor-default"
            >
              <span className="w-[72px] shrink-0 text-[10px] text-cs2-text-muted">关键经济回合</span>
              <span className="min-w-0 flex-1 truncate text-cs2-text-secondary">
                R{keyRound.roundNumber} · {teamLabel(keyRound.winnerTeamKey, teamAName, teamBName)}
                {keyRound.isForceUpset ? " 强起翻盘" : " 经济翻盘"}
              </span>
              {canOpen ? <Play className="h-3 w-3 shrink-0 text-cs2-accent" fill="currentColor" /> : null}
            </button>
          ) : null}
        </div>
      )}
    </InsightCard>
  );
}
