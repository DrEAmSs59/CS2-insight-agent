import { Coins, Crosshair, Target } from "lucide-react";

function formatRate(bucket) {
  if (!bucket || bucket.sampleTooSmall || bucket.conversionRate == null) return "—";
  return `${Math.round(bucket.conversionRate * 100)}%`;
}

function teamLabel(key, teamAName, teamBName) {
  if (key === "a") return teamAName;
  if (key === "b") return teamBName;
  return "—";
}

/**
 * @param {{
 *   model?: object,
 *   onOpenRound?: (roundNumber: number) => void,
 *   teamAName?: string,
 *   teamBName?: string,
 * }} props
 */
export default function EconomyInsightCard({
  model,
  onOpenRound,
  teamAName = "Team A",
  teamBName = "Team B",
}) {
  const pistol = model?.pistol || {};
  const teamA = pistol.teamA || {};
  const teamB = pistol.teamB || {};
  const upsetRounds = Array.isArray(model?.upsetRounds) ? model.upsetRounds : [];
  const forceCountA = upsetRounds.filter((u) => u.isForceUpset && u.winnerTeamKey === "a").length;
  const forceCountB = upsetRounds.filter((u) => u.isForceUpset && u.winnerTeamKey === "b").length;
  const keyRound = model?.keyRound || null;
  const summary = model?.summary || "";
  const hasData = model?.hasData !== false;
  const canOpen = typeof onOpenRound === "function" && keyRound?.roundNumber != null;

  return (
    <article className="flex min-h-[220px] flex-col rounded-xl border border-cs2-border bg-cs2-bg-card p-3.5">
      <header className="mb-2 flex items-center gap-2">
        <div className="flex h-7 w-7 shrink-0 items-center justify-center rounded-lg bg-cs2-accent-soft text-cs2-accent">
          <Coins className="h-3.5 w-3.5" />
        </div>
        <h3 className="text-[13px] font-bold text-cs2-text-primary">经济表现</h3>
      </header>
      {summary ? (
        <p className="mb-2 line-clamp-2 text-[11px] leading-snug text-cs2-text-secondary">{summary}</p>
      ) : null}

      {!hasData ? (
        <p className="mt-4 text-center text-[11px] text-cs2-text-muted">当前 Demo 未提供完整经济快照。</p>
      ) : (
        <div className="mt-auto space-y-2.5">
          <div className="rounded-lg border border-cs2-border/70 bg-cs2-bg-input/30 px-2.5 py-2">
            <div className="mb-1.5 flex items-center gap-1.5 text-[10px] font-semibold text-cs2-text-muted">
              <Target className="h-3 w-3 text-cs2-accent" />
              手枪局转化
            </div>
            <div className="grid grid-cols-2 gap-2 text-[11px]">
              <div>
                <span className="text-sky-400">{teamAName}</span>
                <span className="ml-1.5 font-bold tabular-nums text-cs2-text-primary">
                  {teamA.wins ?? 0} 胜 · {formatRate(teamA)}
                </span>
              </div>
              <div>
                <span className="text-amber-400">{teamBName}</span>
                <span className="ml-1.5 font-bold tabular-nums text-cs2-text-primary">
                  {teamB.wins ?? 0} 胜 · {formatRate(teamB)}
                </span>
              </div>
            </div>
          </div>

          <div className="rounded-lg border border-cs2-border/70 bg-cs2-bg-input/30 px-2.5 py-2">
            <div className="mb-1.5 flex items-center gap-1.5 text-[10px] font-semibold text-cs2-text-muted">
              <Crosshair className="h-3 w-3 text-cs2-accent" />
              强起翻盘回合
            </div>
            <div className="grid grid-cols-2 gap-2 text-[11px]">
              <div>
                <span className="text-sky-400">{teamAName}</span>
                <span className="ml-1.5 font-bold tabular-nums text-cs2-accent">{forceCountA}</span>
              </div>
              <div>
                <span className="text-amber-400">{teamBName}</span>
                <span className="ml-1.5 font-bold tabular-nums text-cs2-accent">{forceCountB}</span>
              </div>
            </div>
          </div>

          {keyRound ? (
            <button
              type="button"
              disabled={!canOpen}
              onClick={() => {
                if (canOpen) onOpenRound(keyRound.roundNumber);
              }}
              className="w-full rounded-lg border border-cs2-accent/30 bg-cs2-accent-soft/40 px-2.5 py-2 text-left transition-colors hover:border-cs2-accent/50 disabled:cursor-default disabled:opacity-70"
            >
              <p className="text-[10px] font-semibold text-cs2-accent">关键经济回合</p>
              <p className="mt-0.5 text-[11px] text-cs2-text-secondary">
                R{keyRound.roundNumber} · {teamLabel(keyRound.winnerTeamKey, teamAName, teamBName)}
                {keyRound.isForceUpset ? " 强起翻盘" : " 经济翻盘"}
              </p>
            </button>
          ) : null}
        </div>
      )}
    </article>
  );
}
