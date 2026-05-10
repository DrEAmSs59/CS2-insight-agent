/**
 * 「回合合集」卡片内：勾选回合（仅「全选」「清空」快捷操作 + 数字格）。
 * @param {{ maxRounds: number, picked: number[], disabled?: boolean, onChange: (next: { picked: number[] }) => void }} props
 */
export default function RoundMontageRoundPicker({ maxRounds, picked, disabled = false, onChange }) {
  const n = Math.max(1, Math.min(64, Number(maxRounds) || 1));
  const set = new Set((picked || []).filter((r) => r >= 1 && r <= n));

  const toggle = (r) => {
    const next = new Set(set);
    if (next.has(r)) next.delete(r);
    else next.add(r);
    const arr = Array.from(next).sort((a, b) => a - b);
    onChange({ picked: arr });
  };

  return (
    <div className="mt-2 rounded border border-white/[0.08] bg-black/25 px-2 py-2">
      <div className="mb-1.5 flex flex-wrap gap-1.5">
        <button
          type="button"
          disabled={disabled}
          onClick={() => onChange({ picked: Array.from({ length: n }, (_, i) => i + 1) })}
          className="rounded border border-white/10 px-2 py-0.5 text-[10px] font-semibold text-zinc-400 transition-colors hover:border-cs2-orange/35 hover:text-cs2-orange disabled:opacity-40"
        >
          全选
        </button>
        <button
          type="button"
          disabled={disabled}
          onClick={() => onChange({ picked: [] })}
          className="rounded border border-white/10 px-2 py-0.5 text-[10px] font-semibold text-zinc-400 transition-colors hover:border-rose-500/30 hover:text-rose-300 disabled:opacity-40"
        >
          清空
        </button>
      </div>
      {picked.length === 0 ? (
        <p className="mb-1 text-[10px] leading-snug text-amber-400/90">
          未勾选时不可加入录制队列。解析在未勾选时仍按整局合规非赛后回合生成合辑；勾选后再解析可只生成所选回合；整局合辑也可在格内保留默认全选后取消勾选，入队时按勾选子集切片。
        </p>
      ) : null}
      <div className="max-h-24 overflow-y-auto rounded border border-white/[0.06] bg-black/35 p-1.5">
        <div className="flex flex-wrap gap-1">
          {Array.from({ length: n }, (_, i) => i + 1).map((r) => {
            const on = set.has(r);
            return (
              <button
                key={r}
                type="button"
                disabled={disabled}
                title={`第 ${r} 回合`}
                onClick={() => toggle(r)}
                className={`min-w-[1.75rem] rounded border px-1 py-0.5 font-mono text-[9px] font-semibold tabular-nums transition-colors ${
                  on
                    ? "border-cs2-orange/45 bg-cs2-orange/15 text-cs2-orange"
                    : "border-white/10 bg-white/[0.03] text-zinc-500 hover:border-white/18"
                }`}
              >
                {r}
              </button>
            );
          })}
        </div>
      </div>
    </div>
  );
}
