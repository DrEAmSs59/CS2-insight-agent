import { X } from "lucide-react";

/**
 * @param {{
 *   kills: number,
 *   deaths: number,
 *   assists: number,
 *   headshots?: number,
 *   extraTags: string[],
 *   roundQueued: boolean,
 *   killsOnly: unknown[],
 *   deathsOnly: unknown[],
 *   onAddRound?: () => void,
 *   onAddKills?: () => void,
 *   onAddDeaths?: () => void,
 *   onRemoveRound?: () => void,
 * }} props
 */
export default function RoundSummaryPanel({
  kills,
  deaths,
  assists,
  headshots = 0,
  extraTags = [],
  roundQueued,
  killsOnly,
  deathsOnly,
  onAddRound,
  onAddKills,
  onAddDeaths,
  onRemoveRound,
}) {
  const showKillsBtn = Array.isArray(killsOnly) && killsOnly.length > 0;
  const showDeathsBtn = Array.isArray(deathsOnly) && deathsOnly.length > 0;
  const maxTags = 6;
  const shown = extraTags.slice(0, maxTags);
  const overflow = extraTags.length - shown.length;

  return (
    <aside className="flex w-full min-w-0 flex-col gap-3 border-l border-cs2-border pl-4 max-[1279px]:border-l-0 max-[1279px]:pl-0">
      <div>
        <p className="text-[12px] font-semibold uppercase tracking-wide text-cs2-text-muted">本回合</p>
        <p className="mt-1 text-sm font-bold text-cs2-text-primary">
          K <span className="text-emerald-400/95">{kills}</span>
          <span className="mx-1 text-cs2-text-muted">/</span>D{" "}
          <span className="text-rose-400/95">{deaths}</span>
          <span className="mx-1 text-cs2-text-muted">/</span>A{" "}
          <span className="text-violet-300/95">{assists}</span>
        </p>
        {headshots > 0 ? (
          <p className="mt-1 text-[12px] text-cs2-text-muted">
            爆头 <span className="font-semibold text-cs2-text-secondary">{headshots}</span>
          </p>
        ) : null}
      </div>

      {shown.length ? (
        <div>
          <p className="text-[12px] font-semibold text-cs2-text-muted">标签</p>
          <div className="mt-1 flex flex-wrap gap-1">
            {shown.map((t, i) => (
              <span
                key={`${t}-${i}`}
                className="max-w-full truncate rounded border border-cs2-accent/25 bg-cs2-accent/10 px-1.5 py-0.5 text-[10px] font-medium text-cs2-accent/95"
                title={t}
              >
                {t}
              </span>
            ))}
            {overflow > 0 ? (
              <span className="rounded border border-cs2-border bg-cs2-bg-hover px-1.5 py-0.5 text-[10px] font-semibold text-cs2-text-secondary">
                +{overflow}
              </span>
            ) : null}
          </div>
        </div>
      ) : null}

      <div className="mt-auto flex w-full flex-col gap-1.5">
        {roundQueued && onRemoveRound ? (
          <button
            type="button"
            onClick={onRemoveRound}
            className="flex w-full items-center justify-center gap-1 rounded-md border border-rose-500/40 bg-rose-500/10 py-2 text-[12px] font-semibold text-cs2-rose-on-surface transition-colors hover:border-rose-400/70"
          >
            整回合已入队<X className="h-3 w-3" />
          </button>
        ) : (
          <button
            type="button"
            onClick={onAddRound}
            disabled={!onAddRound || roundQueued}
            className="w-full rounded-md border border-cs2-border bg-cs2-bg-input/50 py-2 text-[12px] font-semibold text-cs2-text-primary transition-colors hover:border-cs2-accent/50 hover:text-cs2-text-primary disabled:opacity-35"
          >
            {roundQueued ? "整回合已入队" : "加入本回合"}
          </button>
        )}
        {showKillsBtn ? (
          <button
            type="button"
            onClick={onAddKills}
            disabled={!onAddKills}
            className="w-full rounded-md border border-emerald-500/30 bg-emerald-500/10 py-2 text-[12px] font-semibold text-emerald-300/95 hover:border-emerald-400/55 disabled:opacity-35"
          >
            只录击杀
          </button>
        ) : null}
        {showDeathsBtn ? (
          <button
            type="button"
            onClick={onAddDeaths}
            disabled={!onAddDeaths}
            className="w-full rounded-md border border-rose-500/30 bg-rose-500/10 py-2 text-[12px] font-semibold text-cs2-rose-on-surface/95 hover:border-rose-400/55 disabled:opacity-35"
          >
            只录死亡
          </button>
        ) : null}
      </div>
    </aside>
  );
}
