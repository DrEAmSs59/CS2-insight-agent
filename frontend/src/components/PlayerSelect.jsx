import { CheckSquare, Search, SlidersHorizontal, Users } from "lucide-react";
import { useT } from "../i18n/useT.js";

function normalizePlayer(player) {
  if (typeof player === "string") {
    return { name: player, team: 0, kills: 0, deaths: 0, assists: 0 };
  }
  return {
    name: player.name ?? player.player_name ?? "",
    team: Number(player.team ?? player.team_number) || 0,
    kills: Number(player.kills) || 0,
    deaths: Number(player.deaths) || 0,
    assists: Number(player.assists) || 0,
  };
}

function PlayerRow({ player, selected, onSelect }) {
  const active = selected.includes(player.name);
  return (
    <button
      type="button"
      onClick={() => onSelect(player.name)}
      className={[
        "flex w-full items-center gap-3 rounded-md border px-3 py-2 text-left transition-colors",
        active
          ? "border-cs2-accent/40 bg-cs2-accent/10"
          : "border-transparent bg-cs2-bg-sidebar hover:border-cs2-border hover:bg-cs2-bg-elevated",
      ].join(" ")}
    >
      <span className={[
        "flex h-4 w-4 shrink-0 items-center justify-center rounded border",
        active ? "border-cs2-accent bg-cs2-accent" : "border-cs2-border",
      ].join(" ")}>
        {active ? <span className="h-1.5 w-1.5 rounded-sm bg-cs2-text-on-accent" /> : null}
      </span>
      <span className="min-w-0 flex-1 truncate text-[13px] font-semibold text-cs2-text-primary">{player.name}</span>
      <span className="shrink-0 font-mono text-[11px] tabular-nums text-cs2-text-muted">
        {player.kills} / {player.deaths} / {player.assists}
      </span>
    </button>
  );
}

function TeamBlock({ title, players, selected, onSelect, emptyLabel }) {
  return (
    <div className="rounded-lg border border-cs2-border bg-cs2-bg-card p-2">
      <div className="mb-1.5 flex items-center justify-between px-1">
        <h3 className="text-[10px] font-bold uppercase tracking-wider text-cs2-text-secondary">{title}</h3>
        <span className="font-mono text-[10px] text-cs2-text-muted">{players.length}</span>
      </div>
      <div className="space-y-0.5">
        {players.length === 0
          ? <p className="py-2 text-center text-[10px] text-cs2-text-muted">{emptyLabel}</p>
          : players.map((player) => <PlayerRow key={player.name} player={player} selected={selected} onSelect={onSelect} />)}
      </div>
    </div>
  );
}

export default function PlayerSelect({ players, selected, onSelect, onAnalyze, disabled }) {
  const t = useT();
  const list = (players ?? []).map(normalizePlayer).filter((player) => player.name);
  const selectedArr = Array.isArray(selected) ? selected : selected ? [selected] : [];
  const teamA = list.filter((player) => player.team === 3);
  const teamB = list.filter((player) => player.team === 2);
  const unknown = list.filter((player) => player.team !== 2 && player.team !== 3);
  const allSelected = list.length > 0 && list.every((player) => selectedArr.includes(player.name));

  const selectAll = () => {
    list.forEach((player) => {
      if (!selectedArr.includes(player.name)) onSelect(player.name);
    });
  };
  const clearAll = () => {
    selectedArr.forEach((name) => onSelect(name));
  };

  return (
    <div className="rounded-xl border border-cs2-border bg-cs2-bg-card p-4">
      <div className="flex items-start gap-3 rounded-lg border border-cs2-accent/30 bg-cs2-accent/[0.06] p-3">
        <Users className="mt-0.5 h-4 w-4 shrink-0 text-cs2-accent" />
        <div className="min-w-0 flex-1">
          <h2 className="text-sm font-bold text-cs2-text-primary">
            {allSelected
              ? t("player.analysisScopeAll", { n: list.length })
              : t("player.analysisScopeSelected", { selected: selectedArr.length, total: list.length })}
          </h2>
          <p className="mt-1 text-[11px] leading-relaxed text-cs2-text-muted">{t("player.analysisSharedParseHint")}</p>
        </div>
      </div>

      <details className="group mt-3 rounded-lg border border-cs2-border bg-cs2-bg-input/30">
        <summary className="flex cursor-pointer list-none items-center gap-2 px-3 py-2.5 text-[11px] font-semibold text-cs2-text-secondary hover:text-cs2-text-primary">
          <SlidersHorizontal className="h-3.5 w-3.5 text-cs2-text-muted" />
          {t("player.adjustScope")}
          <span className="ml-auto font-mono text-[10px] text-cs2-text-muted">{selectedArr.length}/{list.length}</span>
        </summary>
        <div className="border-t border-cs2-border p-3">
          <div className="mb-2 flex items-center justify-end gap-3 text-[10px] font-semibold">
            <button type="button" onClick={selectAll} className="text-cs2-accent hover:underline">{t("player.selectAll")}</button>
            <button type="button" onClick={clearAll} className="text-cs2-text-muted hover:text-cs2-text-primary">{t("player.clearAll")}</button>
          </div>
          <div className="grid grid-cols-1 gap-3 md:grid-cols-2">
            <TeamBlock title={t("player.selectTeamA")} players={teamA} selected={selectedArr} onSelect={onSelect} emptyLabel={t("player.selectEmpty")} />
            <TeamBlock title={t("player.selectTeamB")} players={teamB} selected={selectedArr} onSelect={onSelect} emptyLabel={t("player.selectEmpty")} />
          </div>
          {unknown.length > 0 ? (
            <div className="mt-3">
              <TeamBlock title={t("player.selectTeamUnknown")} players={unknown} selected={selectedArr} onSelect={onSelect} emptyLabel={t("player.selectEmpty")} />
            </div>
          ) : null}
        </div>
      </details>

      <button
        type="button"
        onClick={onAnalyze}
        disabled={!selectedArr.length || disabled}
        className="mt-3 flex w-full items-center justify-center gap-2 rounded-lg bg-cs2-accent py-2.5 text-sm font-bold text-cs2-text-on-accent shadow-md shadow-cs2-accent/20 transition-colors hover:brightness-110 disabled:cursor-not-allowed disabled:opacity-30"
      >
        {selectedArr.length > 1 ? <CheckSquare className="h-4 w-4" /> : <Search className="h-4 w-4" />}
        {allSelected
          ? t("player.analyzeAll", { n: list.length })
          : t("player.analyzeSelected", { n: selectedArr.length })}
      </button>
    </div>
  );
}
