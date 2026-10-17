import { Check } from "lucide-react";
import { normalizeSharpenAmount } from "../utils/framemeldSharpen.js";

export default function SharpenControl({ t, available = false, legacy = false, enabled = false, amount = 0.15, onChange }) {
  const value = normalizeSharpenAmount(amount);
  const active = available && enabled;
  return (
    <div className="mt-3 border-t border-cs2-border-subtle pt-3" data-testid="sharpen-control">
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <p className="text-xs font-bold text-cs2-text-primary">{t("montage.sharpenTitle")}</p>
          <p className="mt-1 text-[11px] leading-relaxed text-cs2-text-muted">{t("montage.sharpenHint")}</p>
        </div>
        <button type="button" aria-label={t("montage.sharpenTitle")} aria-pressed={active}
          disabled={!available} onClick={() => onChange?.({ sharpen_enabled: !active })}
          className={`mt-0.5 inline-flex h-7 w-7 shrink-0 items-center justify-center rounded-md border transition-all focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-cs2-accent/60 disabled:cursor-not-allowed disabled:opacity-40 ${active ? "border-cs2-accent bg-cs2-accent text-white" : "border-cs2-border bg-cs2-bg-input text-transparent hover:border-cs2-accent/70"}`}>
          <Check size={17} strokeWidth={3} aria-hidden="true" />
        </button>
      </div>
      <label className="mt-3 block text-[11px] text-cs2-text-secondary">
        <span className="mb-2 flex items-center justify-between gap-2"><span>{t("montage.sharpenStrength")}</span><span className="tabular-nums">{value.toFixed(2)}</span></span>
        <input type="range" min="0.1" max="0.3" step="0.01" value={value}
          aria-label={t("montage.sharpenStrength")} aria-valuetext={value.toFixed(2)} disabled={!active}
          onChange={(event) => onChange?.({ sharpen_amount: normalizeSharpenAmount(event.target.value) })}
          style={{ "--cs2-range-progress": `${((value - 0.1) / 0.2) * 100}%` }}
          className="cs2-data-slider w-full disabled:cursor-not-allowed disabled:opacity-40" />
        <span className="mt-1 flex justify-between text-[10px] text-cs2-text-muted"><span>0.10</span><span>0.30</span></span>
      </label>
      {!available && <p className="mt-2 rounded-lg border border-amber-500/25 bg-amber-500/10 px-3 py-2 text-[11px] leading-relaxed text-cs2-amber-on-surface">{t(legacy ? "montage.sharpenLegacy" : "montage.sharpenUnavailable")}</p>}
    </div>
  );
}
