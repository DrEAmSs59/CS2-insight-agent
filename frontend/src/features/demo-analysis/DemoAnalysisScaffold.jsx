import { useEffect, useMemo, useRef, useState } from "react";
import {
  Activity,
  Bot,
  Check,
  ChevronDown,
  CircleDollarSign,
  Film,
  Flame,
  Gem,
  ListChecks,
  Loader2,
  MapPin,
  Swords,
  Users,
} from "lucide-react";
import ActionBar from "../../components/ActionBar";
import ClipList from "../../components/ClipList";
import DemoUpload from "../../components/DemoUpload";
import PlayerIdentityAvatar from "./cosmetics/PlayerIdentityAvatar";
import Button from "../../components/ui/Button";
import { useDemoPlaybackDialog } from "../../hooks/useDemoPlaybackDialog.jsx";
import { useSteamPlayerAvatars } from "../../hooks/useSteamPlayerAvatars.js";
import useSessionState from "../../hooks/useSessionState";
import { useT } from "../../i18n/useT.js";
import { labelTag } from "../../utils/tagDescriptions.js";
import { playerAppearance, steamIdForPlayer } from "../../utils/playerAppearance.js";
import { playerDisplayName, playerIdentityKey, playerIdentitySuffix } from "../../utils/playerIdentity.js";

const PAGE_CONTAINER_CLASS = "w-full px-3 sm:px-4";

const TABS = [
  { key: "highlights", labelKey: "analysis.workspace.tabHighlights", icon: Film },
  { key: "overview", labelKey: "analysis.workspace.tabOverview", icon: Activity },
  { key: "replay", labelKey: "analysis.workspace.tabReplay", icon: MapPin },
  { key: "heatmap", labelKey: "analysis.workspace.tabHeatmap", icon: Flame },
  { key: "rounds", labelKey: "analysis.workspace.tabRounds", icon: ListChecks },
  { key: "economy", labelKey: "analysis.workspace.tabEconomy", icon: CircleDollarSign },
  { key: "players", labelKey: "analysis.workspace.tabPlayers", icon: Users },
  { key: "cosmetics", labelKey: "analysis.workspace.tabCosmetics", icon: Gem },
];

const ALL_TAG = "__all__";

function playerName(player) {
  return playerDisplayName(player);
}

function playerTeamNumber(player) {
  const value = Number(player?.team ?? player?.team_number);
  return value === 2 || value === 3 ? value : null;
}

function splitTeams(players) {
  const list = Array.isArray(players) ? players : [];
  const explicitA = list.filter((player) => playerTeamNumber(player) === 2);
  const explicitB = list.filter((player) => playerTeamNumber(player) === 3);
  if (explicitA.length || explicitB.length) return { a: explicitA, b: explicitB };
  const pivot = Math.ceil(list.length / 2);
  return { a: list.slice(0, pivot), b: list.slice(pivot) };
}

function firstTeamName(players, fallback) {
  return players.map((player) => String(player?.team_name || "").trim()).find(Boolean) || fallback;
}

function demoLabel(match, index) {
  return String(match?.demo_filename || match?.filename || `Demo ${index + 1}`).trim();
}

function mapLabel(mapName, t) {
  const raw = String(mapName || "").trim();
  if (!raw) return t("analysis.workspace.unknownMap");
  return raw.replace(/^de_/, "").replace(/^./, (value) => value.toUpperCase());
}

function DemoSelector({ matches, currentIndex, onChange, disabled }) {
  const t = useT();
  const [open, setOpen] = useState(false);
  const rootRef = useRef(null);
  const current = matches[currentIndex];

  useEffect(() => {
    if (!open) return undefined;
    const close = (event) => {
      if (!rootRef.current?.contains(event.target)) setOpen(false);
    };
    const closeOnEscape = (event) => {
      if (event.key === "Escape") setOpen(false);
    };
    document.addEventListener("pointerdown", close);
    document.addEventListener("keydown", closeOnEscape);
    return () => {
      document.removeEventListener("pointerdown", close);
      document.removeEventListener("keydown", closeOnEscape);
    };
  }, [open]);

  useEffect(() => setOpen(false), [currentIndex]);

  return (
    <div ref={rootRef} className="relative z-[80] min-w-[310px] max-w-[520px]">
      <button
        type="button"
        aria-label={t("analysis.workspace.demoSelector")}
        aria-haspopup="listbox"
        aria-expanded={open}
        disabled={disabled || !matches.length}
        onClick={() => setOpen((value) => !value)}
        className="flex h-9 w-full items-center gap-2 rounded-md border border-cs2-border bg-cs2-bg-input px-3 text-left text-[10px] transition-colors hover:border-cs2-accent/45 disabled:opacity-45"
      >
        <ListChecks className="h-3.5 w-3.5 shrink-0 text-cs2-accent" />
        <span className="shrink-0 font-semibold text-cs2-text-muted">Demo {matches.length ? currentIndex + 1 : 0}/{matches.length}</span>
        <span className="min-w-0 flex-1 truncate font-mono font-semibold text-cs2-text-primary" title={current ? demoLabel(current, currentIndex) : ""}>
          {current ? demoLabel(current, currentIndex) : t("analysis.workspace.noDemoLoaded")}
        </span>
        <ChevronDown className={`h-3.5 w-3.5 shrink-0 text-cs2-text-muted transition-transform ${open ? "rotate-180" : ""}`} />
      </button>

      {open && (
        <div className="absolute right-0 top-[calc(100%+6px)] z-[100] w-full min-w-[420px] overflow-hidden rounded-lg border border-cs2-border bg-cs2-bg-card shadow-[var(--cs2-shadow-lg)]">
          <div className="border-b border-cs2-border px-3 py-2 text-[10px] font-bold uppercase tracking-[0.18em] text-cs2-text-muted">
            {t("analysis.workspace.loadedDemos")} · {matches.length}
          </div>
          <div role="listbox" aria-label={t("analysis.workspace.loadedDemos")} className="max-h-72 overflow-y-auto p-1.5 custom-scrollbar">
            {matches.map((match, index) => {
              const active = index === currentIndex;
              const meta = match?.match_meta || {};
              return (
                <button
                  key={`${demoLabel(match, index)}-${index}`}
                  type="button"
                  role="option"
                  aria-selected={active}
                  onClick={() => {
                    onChange(index);
                    setOpen(false);
                  }}
                  className={`flex w-full items-center gap-3 rounded-md px-3 py-2.5 text-left transition-colors ${active ? "bg-cs2-accent-soft text-cs2-text-primary" : "text-cs2-text-secondary hover:bg-cs2-bg-hover hover:text-cs2-text-primary"}`}
                >
                  <span className={`flex h-6 w-6 shrink-0 items-center justify-center rounded-md font-mono text-[10px] font-black ${active ? "bg-cs2-accent text-cs2-text-on-accent" : "bg-cs2-bg-input text-cs2-text-muted"}`}>{index + 1}</span>
                  <span className="min-w-0 flex-1">
                    <span className="block truncate font-mono text-[10px] font-semibold" title={demoLabel(match, index)}>{demoLabel(match, index)}</span>
                    <span className="mt-0.5 block truncate text-[10px] text-cs2-text-muted">{mapLabel(meta.map_name, t)} · {match?.parsed ? t("analysis.badgeParsed") : t("analysis.workspace.pending")}</span>
                  </span>
                  {active && <Check className="h-3.5 w-3.5 shrink-0 text-cs2-accent" />}
                </button>
              );
            })}
          </div>
        </div>
      )}
    </div>
  );
}

function PlayerPicker({ teams, teamAName, teamBName, activePlayer, playerStats, parsedPlayers, totalPlayers, parsing, avatars, onSelect }) {
  const t = useT();
  const statsByName = useMemo(
    () => new Map((playerStats || []).map((player) => [playerIdentityKey(player), player])),
    [playerStats],
  );
  const renderTeam = (players, teamName, tone) => {
    const isBlue = tone === "blue";
    return (
      <div className="analysis-player-team-card flex h-full min-h-0 flex-col overflow-hidden" data-testid={`analysis-player-team-${tone}`}>
        <div className="flex shrink-0 items-center gap-2 px-3 pb-1.5 pt-2.5 text-[9px] font-bold uppercase tracking-[0.14em] text-cs2-text-muted">
          <span className="h-2 w-2 rounded-full" style={{ background: isBlue ? "var(--cs2-team-blue)" : "var(--cs2-team-amber)" }} />
          <span className="truncate">{teamName}</span>
        </div>
        <div className="custom-scrollbar min-h-0 flex-1 overflow-x-hidden overflow-y-auto pb-1">
          {players.map((player) => {
            const name = playerName(player);
            const playerKey = playerIdentityKey(player);
            const active = playerKey === activePlayer;
            const stats = statsByName.get(playerKey) || player;
            const identitySuffix = playerIdentitySuffix(player);
            const adr = Number(stats?.adr);
            const appearance = playerAppearance(player, isBlue ? "blue" : "amber");
            const avatarUrl = avatars?.[steamIdForPlayer(player)] || "";
            return (
              <button
                key={playerKey}
                type="button"
                aria-label={t("analysis.workspace.selectPlayerAria", { name })}
                onClick={() => onSelect(playerKey)}
                data-active={active ? "true" : "false"}
                className="analysis-player-row grid w-full grid-cols-[28px_minmax(0,1fr)_auto] items-center gap-2 px-3 py-1.5 text-left transition-colors"
                style={active ? {
                  "--analysis-player-accent": appearance.color,
                  background: appearance.background,
                } : undefined}
              >
                <PlayerIdentityAvatar player={player} avatarUrl={avatarUrl} fallbackTone={isBlue ? "blue" : "amber"} className="h-7 w-7 text-[10px]" />
                <div className="min-w-0">
                  <span className="block truncate text-[11px] font-bold text-cs2-text-primary">{name}</span>
                  <span className="mt-0.5 block font-mono text-[9px] text-cs2-text-muted">
                    {identitySuffix ? `#${identitySuffix} · ` : ""}{Number(player?.kills || 0)} / {Number(player?.deaths || 0)}
                  </span>
                </div>
                <span
                  data-testid={`scoreboard-adr-${name}`}
                  className={`inline-flex min-w-[44px] items-baseline justify-end gap-1 text-right font-mono ${active ? "text-cs2-text-primary" : "text-cs2-text-muted"}`}
                >
                  <span className="text-[7px] font-black tracking-[0.08em]">ADR</span>
                  <strong className="text-[9px] font-black">{Number.isFinite(adr) ? adr.toFixed(0) : "—"}</strong>
                </span>
              </button>
            );
          })}
        </div>
      </div>
    );
  };

  return (
    <section className="flex min-h-0 flex-1 flex-col gap-2 overflow-hidden">
      <header className="flex min-h-8 shrink-0 items-center justify-between gap-2 px-1">
        <h2 className="text-[11px] font-black uppercase tracking-[0.12em] text-cs2-text-primary">{t("analysis.workspace.selectPlayer")}</h2>
        <span className="inline-flex items-center gap-1.5 font-mono text-[10px] text-cs2-text-muted">
          {parsing ? <Loader2 className="h-3 w-3 animate-spin text-cs2-accent" /> : <Check className="h-3 w-3 text-emerald-400" />}
          {parsing
            ? t("analysis.workspace.parsingFullMatch")
            : t("analysis.workspace.parsedPlayers", { parsed: Object.keys(parsedPlayers || {}).length, total: totalPlayers })}
        </span>
      </header>
      <div className="grid min-h-0 flex-1 grid-rows-2 gap-3 overflow-hidden" data-testid="analysis-player-team-list">
        {renderTeam(teams.a, teamAName, "blue")}
        {renderTeam(teams.b, teamBName, "amber")}
      </div>
    </section>
  );
}

function MatchRailSummary({ teamAName, teamBName, teamAScore, teamBScore, mapName, totalRounds, durationMins }) {
  const t = useT();
  return (
    <section className="analysis-rail-card shrink-0 overflow-hidden" data-testid="analysis-match-summary-card">
      <div className="h-0.5 bg-gradient-to-r from-sky-500 via-cs2-accent to-amber-500" />
      <div className="px-3 py-2.5">
        <div className="flex items-center justify-between gap-2">
          <p className="text-[9px] font-black uppercase tracking-[0.16em] text-cs2-text-muted">{t("analysis.workspace.matchSummary")}</p>
          <p className="font-mono text-[8px] uppercase tracking-wide text-cs2-text-muted">
            {mapLabel(mapName, t)} · {t("analysis.workspace.rounds", { n: totalRounds })}
          </p>
        </div>
        <div className="mt-2 grid grid-cols-[minmax(0,1fr)_auto] items-center gap-3">
          <div className="min-w-0 space-y-1">
            <div className="flex items-center gap-2 text-[10px] font-bold">
              <span className="h-1.5 w-1.5 shrink-0 rounded-full" style={{ background: "var(--cs2-team-blue)" }} />
              <span className="min-w-0 truncate" style={{ color: "var(--cs2-team-blue)" }}>{teamAName}</span>
            </div>
            <div className="flex items-center gap-2 text-[10px] font-bold">
              <span className="h-1.5 w-1.5 shrink-0 rounded-full" style={{ background: "var(--cs2-team-amber)" }} />
              <span className="min-w-0 truncate" style={{ color: "var(--cs2-team-amber)" }}>{teamBName}</span>
            </div>
          </div>
          <div className="flex items-baseline gap-1.5 font-mono">
            <span className="text-2xl font-black" style={{ color: "var(--cs2-team-blue)" }}>{teamAScore}</span>
            <span className="text-sm font-black text-cs2-text-muted">:</span>
            <span className="text-2xl font-black" style={{ color: "var(--cs2-team-amber)" }}>{teamBScore}</span>
          </div>
        </div>
        {durationMins > 0 ? <p className="mt-1.5 text-right font-mono text-[8px] text-cs2-text-muted">{t("analysis.workspace.minutes", { n: durationMins })}</p> : null}
      </div>
    </section>
  );
}

function AnalysisViewNavigation({ activeTab, onSelectTab }) {
  const t = useT();
  return (
    <section className="analysis-view-switcher shrink-0" data-testid="analysis-view-navigation-card">
      <nav className="analysis-view-nav" aria-label={t("analysis.workspace.demoViews")}>
        {TABS.map(({ key, labelKey, icon: Icon }) => (
          <button key={key} type="button" data-active={activeTab === key ? "true" : "false"} aria-current={activeTab === key ? "page" : undefined} onClick={() => onSelectTab(key)}>
            <Icon className="h-3.5 w-3.5 shrink-0" />
            <span className="truncate">{t(labelKey)}</span>
          </button>
        ))}
      </nav>
    </section>
  );
}

function HighlightWorkspaceToolbar({
  activeHighlightView,
  setActiveHighlightView,
  selectedPlayer,
  activePlayer,
  regularClips,
  playerAiReviewing,
  playerAiReviewed,
  aiMode,
  tagCounts,
  selectedTag,
  setSelectedTag,
  locale,
  avatars,
}) {
  const t = useT();
  const isBlue = playerTeamNumber(selectedPlayer) === 2;
  const selectedAppearance = playerAppearance(selectedPlayer, isBlue ? "blue" : "amber");
  const selectedAvatarUrl = selectedPlayer ? avatars?.[steamIdForPlayer(selectedPlayer)] || "" : "";
  const [tagsExpanded, setTagsExpanded] = useState(false);

  useEffect(() => {
    setTagsExpanded(false);
  }, [activePlayer, activeHighlightView]);

  if (!selectedPlayer) return null;

  return (
    <section className="analysis-highlight-toolbar overflow-hidden rounded-lg border border-cs2-border-subtle bg-cs2-bg-input/20">
      <div className="flex flex-wrap items-center justify-between gap-3 px-3 py-2.5">
        <div className="flex min-w-0 items-center gap-2.5">
          <PlayerIdentityAvatar player={selectedPlayer} avatarUrl={selectedAvatarUrl} fallbackTone={isBlue ? "blue" : "amber"} className="h-8 w-8 text-xs" />
          <div className="min-w-0">
            <div className="flex flex-wrap items-baseline gap-x-2 gap-y-0.5">
              <h2 className="truncate text-[12px] font-black text-cs2-text-primary">{activePlayer}</h2>
              <p className="text-[8px] font-bold uppercase tracking-[0.12em]" style={{ color: selectedAppearance.color }}>
                {t("analysis.workspace.focusedPlayer")}
              </p>
            </div>
            <div className="mt-0.5 flex items-center gap-3 text-[9px] text-cs2-text-muted">
              {[
                [t("analysis.workspace.kills"), Number(selectedPlayer.kills || 0)],
                [t("analysis.workspace.deaths"), Number(selectedPlayer.deaths || 0)],
                [t("analysis.workspace.clips"), regularClips.length],
              ].map(([label, value]) => (
                <span key={label}><strong className="mr-1 font-mono text-[10px] text-cs2-text-primary">{value}</strong>{label}</span>
              ))}
            </div>
          </div>
        </div>
        <div className="min-w-[360px] sm:min-w-[420px]">
          <div className="analysis-subnav">
            {[["clips", "analysis.tabClips"], ["rounds", "analysis.tabTimeline"], ["weapons", "analysis.tabWeaponKills"]].map(([key, labelKey]) => (
              <button key={key} type="button" data-active={activeHighlightView === key ? "true" : "false"} onClick={() => setActiveHighlightView(key)}>
                {t(labelKey)}
              </button>
            ))}
          </div>
        </div>
      </div>
      {aiMode && activeHighlightView === "clips" && (playerAiReviewing || playerAiReviewed) ? (
        <div className="flex items-start gap-2 border-t border-violet-500/20 bg-violet-500/8 px-3 py-2 text-[9px] text-violet-300">
          {playerAiReviewing ? <Loader2 className="mt-0.5 h-3 w-3 shrink-0 animate-spin" /> : <Bot className="mt-0.5 h-3 w-3 shrink-0" />}
          <span>{playerAiReviewing ? t("analysis.workspace.aiReviewing", { name: activePlayer }) : playerAiReviewed ? t("analysis.workspace.aiReviewed", { name: activePlayer }) : t("analysis.workspace.aiQueued", { name: activePlayer })}</span>
        </div>
      ) : null}
      {activeHighlightView === "clips" ? (
        <div className="border-t border-cs2-border-subtle">
          <button
            type="button"
            aria-expanded={tagsExpanded}
            aria-label={t(tagsExpanded ? "dock.collapse" : "dock.expand", { panel: t("analysis.workspace.tags") })}
            onClick={() => setTagsExpanded((expanded) => !expanded)}
            className="flex min-h-9 w-full items-center gap-2 px-3 text-left text-[10px] font-bold text-cs2-text-secondary transition-colors hover:bg-cs2-bg-hover hover:text-cs2-text-primary"
          >
            <span className="uppercase tracking-[0.14em]">{t("analysis.workspace.tags")}</span>
            <span className="rounded bg-cs2-bg-input px-1.5 py-0.5 font-mono text-[9px] text-cs2-text-muted">
              {selectedTag === ALL_TAG ? t("analysis.workspace.allTags") : labelTag(selectedTag, locale)}
            </span>
            <ChevronDown className={`ml-auto h-3.5 w-3.5 text-cs2-text-muted transition-transform ${tagsExpanded ? "rotate-180" : ""}`} />
          </button>
          {tagsExpanded ? (
            <div data-testid="highlight-tag-options" className="flex flex-wrap gap-1 border-t border-cs2-border-subtle px-3 py-2">
              {tagCounts.map(([tag, count]) => (
                <button key={tag} type="button" data-active={selectedTag === tag ? "true" : "false"} onClick={() => setSelectedTag(tag)} className="analysis-filter-toggle">
                  {tag === ALL_TAG ? t("analysis.workspace.allTags") : labelTag(tag, locale)} <span className="ml-0.5 font-mono opacity-70">{count}</span>
                </button>
              ))}
            </div>
          ) : null}
        </div>
      ) : null}
    </section>
  );
}

function EmptyResult({ onAnalyze, disabled, parsing }) {
  const t = useT();
  return (
    <div className="flex min-h-[260px] items-center justify-center rounded-xl border border-dashed border-cs2-border bg-cs2-bg-card/45 p-8 text-center">
      <div><Swords className="mx-auto h-7 w-7 text-cs2-text-muted" /><h2 className="mt-3 text-[13px] font-bold text-cs2-text-primary">{parsing ? t("analysis.workspace.parsingCurrent") : t("analysis.workspace.noResult")}</h2><p className="mt-1 text-[11px] text-cs2-text-muted">{t("analysis.workspace.autoAnalysisHint")}</p>{!parsing && <Button className="mt-4" disabled={disabled} onClick={onAnalyze}>{t("analysis.workspace.reparseCurrent")}</Button>}</div>
    </div>
  );
}

export { ALL_TAG, AnalysisViewNavigation, DemoSelector, EmptyResult, HighlightWorkspaceToolbar, MatchRailSummary, PAGE_CONTAINER_CLASS, PlayerPicker, TABS, demoLabel, firstTeamName, mapLabel, playerName, playerTeamNumber, splitTeams };
