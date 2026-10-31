import { useT } from "../i18n/useT.js";

/**
 * 「回合合集」回合勾选：全选 / 清空 + 回合编号按钮。
 * @param {{ maxRounds: number, picked: number[], disabled?: boolean, onChange: (next: { picked: number[] }) => void }} props
 */
export default function RoundMontageRoundPicker({ maxRounds, picked, disabled = false, onChange }) {
  const t = useT();
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
    <div className="space-y-2">
      <div className="flex flex-wrap items-center gap-1.5">
        <button
          type="button"
          disabled={disabled}
          onClick={() => onChange({ picked: Array.from({ length: n }, (_, i) => i + 1) })}
          className="inline-flex h-7 items-center rounded-md border border-cs2-border bg-cs2-bg-input px-2.5 text-xs font-medium text-cs2-text-secondary transition-colors hover:text-cs2-text-primary disabled:opacity-40"
        >
          {t("montage.pickerSelectAll")}
        </button>
        <button
          type="button"
          disabled={disabled}
          onClick={() => onChange({ picked: [] })}
          className="inline-flex h-7 items-center rounded-md border border-cs2-border bg-cs2-bg-input px-2.5 text-xs font-medium text-cs2-text-secondary transition-colors hover:text-cs2-text-primary disabled:opacity-40"
        >
          {t("montage.pickerClear")}
        </button>
        {set.size === 0 ? (
          <span className="text-xs text-cs2-amber-on-surface" title={t("montage.pickerNoSelectionHint")}>
            {t("montage.pickerNoSelectionShort")}
          </span>
        ) : null}
      </div>
      <div className="flex max-h-32 flex-wrap gap-1.5 overflow-y-auto">
        {Array.from({ length: n }, (_, i) => i + 1).map((r) => {
          const on = set.has(r);
          return (
            <button
              key={r}
              type="button"
              disabled={disabled}
              aria-pressed={on}
              data-active={on ? "true" : "false"}
              title={t("montage.pickerRoundTitle", { n: r })}
              onClick={() => toggle(r)}
              className="analysis-tag-chip analysis-tag-chip--mini min-w-[2.25rem] justify-center font-mono tabular-nums disabled:opacity-40"
            >
              {r}
            </button>
          );
        })}
      </div>
    </div>
  );
}
