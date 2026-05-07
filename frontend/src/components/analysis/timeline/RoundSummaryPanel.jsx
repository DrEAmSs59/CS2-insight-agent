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
}) {
  const showKillsBtn = Array.isArray(killsOnly) && killsOnly.length > 0;
  const showDeathsBtn = Array.isArray(deathsOnly) && deathsOnly.length > 0;
  const maxTags = 6;
  const shown = extraTags.slice(0, maxTags);
  const overflow = extraTags.length - shown.length;

  return (
    <aside className="flex w-full min-w-0 flex-col gap-3 border-l border-white/[0.06] pl-4 max-[1279px]:border-l-0 max-[1279px]:pl-0">
      <div>
        <p className="text-[11px] font-semibold uppercase tracking-wide text-zinc-500">本回合</p>
        <p className="mt-1 text-sm font-bold text-zinc-100">
          K <span className="text-emerald-400/95">{kills}</span>
          <span className="mx-1 text-zinc-600">/</span>D{" "}
          <span className="text-rose-400/95">{deaths}</span>
          <span className="mx-1 text-zinc-600">/</span>A{" "}
          <span className="text-violet-300/95">{assists}</span>
        </p>
        {headshots > 0 ? (
          <p className="mt-1 text-[12px] text-zinc-500">
            爆头 <span className="font-semibold text-zinc-300">{headshots}</span>
          </p>
        ) : null}
      </div>

      {shown.length ? (
        <div>
          <p className="text-[11px] font-semibold text-zinc-500">标签</p>
          <div className="mt-1 flex flex-wrap gap-1">
            {shown.map((t, i) => (
              <span
                key={`${t}-${i}`}
                className="max-w-full truncate rounded border border-cs2-orange/25 bg-cs2-orange/10 px-1.5 py-0.5 text-[10px] font-medium text-cs2-orange/95"
                title={t}
              >
                {t}
              </span>
            ))}
            {overflow > 0 ? (
              <span className="rounded border border-white/12 bg-white/5 px-1.5 py-0.5 text-[10px] font-semibold text-zinc-400">
                +{overflow}
              </span>
            ) : null}
          </div>
        </div>
      ) : null}

      <div className="mt-auto flex w-full flex-col gap-1.5">
        <button
          type="button"
          onClick={onAddRound}
          disabled={!onAddRound || roundQueued}
          className="w-full rounded-md border border-white/14 bg-white/[0.06] py-2 text-[12px] font-semibold text-zinc-100 transition-colors hover:border-cs2-orange/50 hover:text-white disabled:opacity-35"
        >
          {roundQueued ? "整回合已入队" : "加入本回合"}
        </button>
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
            className="w-full rounded-md border border-rose-500/30 bg-rose-500/10 py-2 text-[12px] font-semibold text-rose-300/95 hover:border-rose-400/55 disabled:opacity-35"
          >
            只录死亡
          </button>
        ) : null}
      </div>
    </aside>
  );
}
