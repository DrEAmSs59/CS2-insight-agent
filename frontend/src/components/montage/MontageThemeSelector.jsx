import { useT } from "../../i18n/useT.js";

export default function MontageThemeSelector({ themes, selectedThemeId, onSelectTheme }) {
  const t = useT();

  return (
    <div className="space-y-2">
      <p className="text-[10px] font-semibold uppercase tracking-wide text-cs2-text-muted">{t("montage.themeSectionLabel")}</p>
      <div className="flex flex-wrap gap-2">
        {(themes || []).map((theme) => {
          const active = theme.id === selectedThemeId;
          return (
            <button
              key={theme.id}
              type="button"
              onClick={() => onSelectTheme?.(theme.id)}
              title={theme.description}
              className={`rounded-lg border px-3 py-2 text-left text-[12px] transition-colors ${
                active
                  ? "border-cs2-accent/60 bg-cs2-accent/15 text-cs2-text-primary ring-1 ring-cs2-accent/30"
                  : "border-cs2-border bg-cs2-bg-input/50 text-cs2-text-secondary hover:border-cs2-border hover:bg-cs2-bg-input/50"
              }`}
            >
              <span className="block font-semibold">{theme.name}</span>
              <span className="mt-0.5 block text-[11px] font-normal text-cs2-text-muted">{theme.description}</span>
            </button>
          );
        })}
      </div>
    </div>
  );
}
