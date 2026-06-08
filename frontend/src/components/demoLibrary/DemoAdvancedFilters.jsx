import { useT } from "../../i18n/useT.js";

export default function DemoAdvancedFilters({ libraryAdvFilters, setLibraryAdvFilters, idPrefix = "adv" }) {
  const t = useT();
  const pq = libraryAdvFilters.playerQuery?.trim?.() ?? "";

  return (
    <div
      className="max-h-[min(42vh,22rem)] overflow-y-auto rounded-md border border-cs2-border bg-cs2-bg-input/40 px-3 py-2 text-[12px] text-cs2-text-secondary shadow-inner"
      role="region"
      aria-label={t("library.advRegionLabel")}
    >
      <p className="mb-2 leading-snug text-[11px] text-cs2-text-muted">
        {t("library.advPlayerHint")}
      </p>

      <div className="grid gap-2 sm:grid-cols-2">
        <label className="flex flex-col gap-0.5">
          <span className="text-[11px] text-cs2-text-muted">{t("library.advPlayerLabel")}</span>
          <input
            id={`${idPrefix}-player`}
            className="rounded border border-cs2-border bg-cs2-bg-input px-2 py-1.5 font-mono text-[12px] outline-none focus:border-cs2-accent/45"
            value={libraryAdvFilters.playerQuery}
            onChange={(e) => setLibraryAdvFilters((p) => ({ ...p, playerQuery: e.target.value }))}
            placeholder={t("library.advPlayerPlaceholder")}
          />
        </label>
      </div>

      <div className="mt-2 grid grid-cols-2 gap-2 sm:grid-cols-4">
        <label className="flex flex-col gap-0.5">
          <span className="text-[11px] text-cs2-text-muted">{t("library.advKillsLabel")}</span>
          <input
            inputMode="numeric"
            disabled={!pq}
            className="rounded border border-cs2-border bg-cs2-bg-input px-2 py-1.5 font-mono text-[12px] outline-none focus:border-cs2-accent/45 disabled:cursor-not-allowed disabled:opacity-40"
            value={libraryAdvFilters.minKills}
            onChange={(e) => setLibraryAdvFilters((p) => ({ ...p, minKills: e.target.value }))}
          />
        </label>
        <label className="flex flex-col gap-0.5">
          <span className="text-[11px] text-cs2-text-muted">{t("library.advDeathsLabel")}</span>
          <input
            inputMode="numeric"
            disabled={!pq}
            className="rounded border border-cs2-border bg-cs2-bg-input px-2 py-1.5 font-mono text-[12px] outline-none focus:border-cs2-accent/45 disabled:cursor-not-allowed disabled:opacity-40"
            value={libraryAdvFilters.maxDeaths}
            onChange={(e) => setLibraryAdvFilters((p) => ({ ...p, maxDeaths: e.target.value }))}
          />
        </label>
        <label className="flex flex-col gap-0.5">
          <span className="text-[11px] text-cs2-text-muted">{t("library.advAssistsLabel")}</span>
          <input
            inputMode="numeric"
            disabled={!pq}
            className="rounded border border-cs2-border bg-cs2-bg-input px-2 py-1.5 font-mono text-[12px] outline-none focus:border-cs2-accent/45 disabled:cursor-not-allowed disabled:opacity-40"
            value={libraryAdvFilters.minAssists}
            onChange={(e) => setLibraryAdvFilters((p) => ({ ...p, minAssists: e.target.value }))}
          />
        </label>
        <label className="flex flex-col gap-0.5">
          <span className="text-[11px] text-cs2-text-muted">{t("library.advKdLabel")}</span>
          <input
            inputMode="decimal"
            disabled={!pq}
            className="rounded border border-cs2-border bg-cs2-bg-input px-2 py-1.5 font-mono text-[12px] outline-none focus:border-cs2-accent/45 disabled:cursor-not-allowed disabled:opacity-40"
            value={libraryAdvFilters.minKd}
            onChange={(e) => setLibraryAdvFilters((p) => ({ ...p, minKd: e.target.value }))}
          />
        </label>
      </div>

      <div className="mt-2 grid gap-2 sm:grid-cols-2">
        <div className="flex flex-col gap-0.5">
          <span className="text-[11px] text-cs2-text-muted">{t("library.advRoundsLabel")}</span>
          <div className="flex items-center gap-1">
            <input
              inputMode="numeric"
              className="min-w-0 flex-1 rounded border border-cs2-border bg-cs2-bg-input px-2 py-1.5 font-mono text-[12px] outline-none focus:border-cs2-accent/45"
              placeholder={t("library.advRoundsMin")}
              value={libraryAdvFilters.roundsMin}
              onChange={(e) => setLibraryAdvFilters((p) => ({ ...p, roundsMin: e.target.value }))}
            />
            <span className="text-cs2-text-muted">—</span>
            <input
              inputMode="numeric"
              className="min-w-0 flex-1 rounded border border-cs2-border bg-cs2-bg-input px-2 py-1.5 font-mono text-[12px] outline-none focus:border-cs2-accent/45"
              placeholder={t("library.advRoundsMax")}
              value={libraryAdvFilters.roundsMax}
              onChange={(e) => setLibraryAdvFilters((p) => ({ ...p, roundsMax: e.target.value }))}
            />
          </div>
        </div>
        <div className="flex flex-col gap-0.5">
          <span className="text-[11px] text-cs2-text-muted">{t("library.advDurationLabel")}</span>
          <div className="flex items-center gap-1">
            <input
              inputMode="decimal"
              className="min-w-0 flex-1 rounded border border-cs2-border bg-cs2-bg-input px-2 py-1.5 font-mono text-[12px] outline-none focus:border-cs2-accent/45"
              placeholder={t("library.advDurationMin")}
              value={libraryAdvFilters.durationMin}
              onChange={(e) => setLibraryAdvFilters((p) => ({ ...p, durationMin: e.target.value }))}
            />
            <span className="text-cs2-text-muted">—</span>
            <input
              inputMode="decimal"
              className="min-w-0 flex-1 rounded border border-cs2-border bg-cs2-bg-input px-2 py-1.5 font-mono text-[12px] outline-none focus:border-cs2-accent/45"
              placeholder={t("library.advDurationMax")}
              value={libraryAdvFilters.durationMax}
              onChange={(e) => setLibraryAdvFilters((p) => ({ ...p, durationMax: e.target.value }))}
            />
          </div>
        </div>
      </div>
    </div>
  );
}
