export default function DemoAdvancedFilters({ libraryAdvFilters, setLibraryAdvFilters, idPrefix = "adv" }) {
  const pq = libraryAdvFilters.playerQuery?.trim?.() ?? "";

  return (
    <div
      className="max-h-[min(42vh,22rem)] overflow-y-auto rounded-md border border-white/[0.07] bg-black/25 px-3 py-2 text-[11px] text-zinc-300 shadow-inner"
      role="region"
      aria-label="高级筛选"
    >
      <p className="mb-2 leading-snug text-[10px] text-zinc-500">
        击杀 / 死亡 / 助攻 / KD 须先填写昵称关键词。
      </p>

      <div className="grid gap-2 sm:grid-cols-2">
        <label className="flex flex-col gap-0.5">
          <span className="text-[10px] text-zinc-500">玩家昵称关键词</span>
          <input
            id={`${idPrefix}-player`}
            className="rounded border border-white/10 bg-cs2-bg-input px-2 py-1.5 font-mono text-[11px] outline-none focus:border-cs2-orange/45"
            value={libraryAdvFilters.playerQuery}
            onChange={(e) => setLibraryAdvFilters((p) => ({ ...p, playerQuery: e.target.value }))}
            placeholder="填写后才按玩家统计筛选"
          />
        </label>
      </div>

      <div className="mt-2 grid grid-cols-2 gap-2 sm:grid-cols-4">
        <label className="flex flex-col gap-0.5">
          <span className="text-[10px] text-zinc-500">击杀 ≥</span>
          <input
            inputMode="numeric"
            disabled={!pq}
            className="rounded border border-white/10 bg-cs2-bg-input px-2 py-1.5 font-mono text-[11px] outline-none focus:border-cs2-orange/45 disabled:cursor-not-allowed disabled:opacity-40"
            value={libraryAdvFilters.minKills}
            onChange={(e) => setLibraryAdvFilters((p) => ({ ...p, minKills: e.target.value }))}
          />
        </label>
        <label className="flex flex-col gap-0.5">
          <span className="text-[10px] text-zinc-500">死亡 ≤</span>
          <input
            inputMode="numeric"
            disabled={!pq}
            className="rounded border border-white/10 bg-cs2-bg-input px-2 py-1.5 font-mono text-[11px] outline-none focus:border-cs2-orange/45 disabled:cursor-not-allowed disabled:opacity-40"
            value={libraryAdvFilters.maxDeaths}
            onChange={(e) => setLibraryAdvFilters((p) => ({ ...p, maxDeaths: e.target.value }))}
          />
        </label>
        <label className="flex flex-col gap-0.5">
          <span className="text-[10px] text-zinc-500">助攻 ≥</span>
          <input
            inputMode="numeric"
            disabled={!pq}
            className="rounded border border-white/10 bg-cs2-bg-input px-2 py-1.5 font-mono text-[11px] outline-none focus:border-cs2-orange/45 disabled:cursor-not-allowed disabled:opacity-40"
            value={libraryAdvFilters.minAssists}
            onChange={(e) => setLibraryAdvFilters((p) => ({ ...p, minAssists: e.target.value }))}
          />
        </label>
        <label className="flex flex-col gap-0.5">
          <span className="text-[10px] text-zinc-500">KD ≥</span>
          <input
            inputMode="decimal"
            disabled={!pq}
            className="rounded border border-white/10 bg-cs2-bg-input px-2 py-1.5 font-mono text-[11px] outline-none focus:border-cs2-orange/45 disabled:cursor-not-allowed disabled:opacity-40"
            value={libraryAdvFilters.minKd}
            onChange={(e) => setLibraryAdvFilters((p) => ({ ...p, minKd: e.target.value }))}
          />
        </label>
      </div>

      <div className="mt-2 grid gap-2 sm:grid-cols-2">
        <div className="flex flex-col gap-0.5">
          <span className="text-[10px] text-zinc-500">回合数范围</span>
          <div className="flex items-center gap-1">
            <input
              inputMode="numeric"
              className="min-w-0 flex-1 rounded border border-white/10 bg-cs2-bg-input px-2 py-1.5 font-mono text-[11px] outline-none focus:border-cs2-orange/45"
              placeholder="最小"
              value={libraryAdvFilters.roundsMin}
              onChange={(e) => setLibraryAdvFilters((p) => ({ ...p, roundsMin: e.target.value }))}
            />
            <span className="text-zinc-600">—</span>
            <input
              inputMode="numeric"
              className="min-w-0 flex-1 rounded border border-white/10 bg-cs2-bg-input px-2 py-1.5 font-mono text-[11px] outline-none focus:border-cs2-orange/45"
              placeholder="最大"
              value={libraryAdvFilters.roundsMax}
              onChange={(e) => setLibraryAdvFilters((p) => ({ ...p, roundsMax: e.target.value }))}
            />
          </div>
        </div>
        <div className="flex flex-col gap-0.5">
          <span className="text-[10px] text-zinc-500">时长范围（分钟）</span>
          <div className="flex items-center gap-1">
            <input
              inputMode="decimal"
              className="min-w-0 flex-1 rounded border border-white/10 bg-cs2-bg-input px-2 py-1.5 font-mono text-[11px] outline-none focus:border-cs2-orange/45"
              placeholder="最短"
              value={libraryAdvFilters.durationMin}
              onChange={(e) => setLibraryAdvFilters((p) => ({ ...p, durationMin: e.target.value }))}
            />
            <span className="text-zinc-600">—</span>
            <input
              inputMode="decimal"
              className="min-w-0 flex-1 rounded border border-white/10 bg-cs2-bg-input px-2 py-1.5 font-mono text-[11px] outline-none focus:border-cs2-orange/45"
              placeholder="最长"
              value={libraryAdvFilters.durationMax}
              onChange={(e) => setLibraryAdvFilters((p) => ({ ...p, durationMax: e.target.value }))}
            />
          </div>
        </div>
      </div>
    </div>
  );
}
