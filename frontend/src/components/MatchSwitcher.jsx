import { Layers } from "lucide-react";
import { useT } from "../i18n/useT.js";

function mapLabel(meta, t) {
  if (!meta) return t("match.switcherUnknownMap");
  const m = meta.map_name;
  return m && String(m).trim() ? String(m) : t("match.switcherUnknownMap");
}

/**
 * @param {{ matches: Array<{ match_meta?: object, demo_filename?: string, filename?: string, parsed?: boolean }>, currentIndex: number, onChange: (i: number) => void, disabled?: boolean }} props
 */
export default function MatchSwitcher({ matches, currentIndex, onChange, disabled }) {
  const t = useT();
  if (!matches || matches.length <= 1) return null;

  return (
    <div className="rounded-lg border border-cs2-border bg-cs2-bg-input/30 px-3 py-2.5">
      <div className="mb-2 flex items-center gap-2 text-[10px] font-black uppercase tracking-[0.2em] text-cs2-text-muted">
        <Layers className="h-3.5 w-3.5 text-cs2-accent/80" />
        {t("match.switcherTitle")}
      </div>
      <div className="flex flex-wrap gap-1.5">
        {matches.map((m, i) => {
          const label = mapLabel(m.match_meta, t);
          const fname = m.demo_filename || m.filename || t("match.switcherFallbackName", { n: i + 1 });
          const active = i === currentIndex;
          return (
            <button
              key={`${fname}-${i}`}
              type="button"
              disabled={disabled}
              onClick={() => onChange(i)}
              className={`min-w-0 max-w-full rounded-md border px-2.5 py-1.5 text-left text-[12px] font-semibold transition-colors ${
                active
                  ? "border-cs2-accent/60 bg-cs2-accent/15 text-cs2-text-primary shadow-[0_0_12px_rgba(255,140,0,0.12)]"
                  : "border-cs2-border bg-cs2-bg-input text-cs2-text-secondary hover:border-cs2-accent/35 hover:text-cs2-text-primary"
              } ${disabled ? "opacity-40" : ""}`}
            >
              <span className="block truncate font-mono text-[10px] text-cs2-accent/90">
                {t("match.switcherMatchN", { n: i + 1, label })}
              </span>
              <span className="flex items-center gap-1.5 truncate text-[10px] font-normal text-cs2-text-muted" title={fname}>
                <span className="min-w-0 truncate">{fname}</span>
                {m.parsed ? (
                  <span className="shrink-0 rounded px-1 py-px text-[9px] font-semibold uppercase tracking-wide text-cs2-emerald-on-surface">
                    ✓
                  </span>
                ) : null}
              </span>
            </button>
          );
        })}
      </div>
    </div>
  );
}
