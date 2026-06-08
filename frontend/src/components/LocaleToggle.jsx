import { useLocaleStore, SUPPORTED_LOCALES } from "../i18n/localeStore";

const LABELS = { zh: "中文", en: "English" };

export default function LocaleToggle() {
  const locale = useLocaleStore((s) => s.locale);
  const setLocale = useLocaleStore((s) => s.setLocale);

  return (
    <div className="flex w-full items-center gap-0.5 rounded-lg border border-cs2-border bg-cs2-bg-input/30 p-0.5">
      {SUPPORTED_LOCALES.map((loc) => {
        const isActive = locale === loc;
        return (
          <button
            key={loc}
            type="button"
            aria-pressed={isActive}
            onClick={() => setLocale(loc)}
            className={`flex-1 rounded-md px-1.5 py-1 text-[11px] font-semibold transition-colors ${
              isActive
                ? "bg-cs2-accent-soft text-cs2-accent"
                : "text-cs2-text-secondary hover:bg-cs2-bg-input/50 hover:text-cs2-text-primary"
            }`}
          >
            {LABELS[loc]}
          </button>
        );
      })}
    </div>
  );
}
