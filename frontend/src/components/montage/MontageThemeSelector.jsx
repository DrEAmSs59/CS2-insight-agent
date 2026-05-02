export default function MontageThemeSelector({ themes, selectedThemeId, onSelectTheme }) {
  return (
    <div className="space-y-2">
      <p className="text-[10px] font-semibold uppercase tracking-wide text-zinc-500">合辑主题</p>
      <div className="flex flex-wrap gap-2">
        {(themes || []).map((t) => {
          const active = t.id === selectedThemeId;
          return (
            <button
              key={t.id}
              type="button"
              onClick={() => onSelectTheme?.(t.id)}
              title={t.description}
              className={`rounded-lg border px-3 py-2 text-left text-[11px] transition-colors ${
                active
                  ? "border-cs2-orange/60 bg-cs2-orange/15 text-white ring-1 ring-cs2-orange/30"
                  : "border-white/10 bg-black/30 text-zinc-300 hover:border-white/20 hover:bg-white/[0.04]"
              }`}
            >
              <span className="block font-semibold">{t.name}</span>
              <span className="mt-0.5 block text-[10px] font-normal text-zinc-500">{t.description}</span>
            </button>
          );
        })}
      </div>
    </div>
  );
}
