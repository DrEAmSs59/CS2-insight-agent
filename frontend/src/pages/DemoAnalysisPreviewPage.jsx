import { useEffect, useMemo, useRef, useState } from "react";
import { Link } from "react-router-dom";
import {
  Activity,
  BarChart3,
  Bot,
  Check,
  ChevronDown,
  CircleDollarSign,
  Film,
  Flame,
  Library,
  ListChecks,
  Loader2,
  MapPin,
  PanelsTopLeft,
  Play,
  RefreshCw,
  Swords,
  Users,
} from "lucide-react";
import ActionBar from "../components/ActionBar";
import ClipList from "../components/ClipList";
import DemoUpload from "../components/DemoUpload";
import RoundTimelineView from "../components/analysis/timeline/RoundTimelineView";
import WeaponKillsView from "../components/analysis/WeaponKillsView";
import Demo2DReplayPreview from "../components/analysis/Demo2DReplayPreview";
import DemoHeatmapView from "../components/analysis/DemoHeatmapView";
import PlayerIdentityAvatar from "../components/analysis/PlayerIdentityAvatar";
import DockableRow, { clearDockLayout } from "../components/layout/DockableRow";
import { useReplayStore } from "../stores/replayStore";
import {
  EconomyView,
  OverviewView,
  PlayersView,
  RoundsView,
  useWorkspaceData,
} from "../components/analysis/DemoAnalysisWorkspaceViews";
import Button from "../components/ui/Button";
import { useAppShell } from "../context/AppShellContext";
import { useDemoPlaybackDialog } from "../hooks/useDemoPlaybackDialog.jsx";
import { useSteamPlayerAvatars } from "../hooks/useSteamPlayerAvatars.js";
import useSessionState from "../hooks/useSessionState";
import { useT } from "../i18n/useT.js";
import { useLocaleStore } from "../i18n/localeStore.js";
import { labelTag } from "../utils/tagDescriptions.js";
import { summarizeWeaponKills } from "../utils/weaponKillCompilations.js";
import { playerAppearance, steamIdForPlayer } from "../utils/playerAppearance.js";

const PAGE_CONTAINER_CLASS = "w-full px-3 sm:px-4";

const TABS = [
  { key: "highlights", labelKey: "analysis.workspace.tabHighlights", icon: Film },
  { key: "replay", labelKey: "analysis.workspace.tabReplay", icon: MapPin },
  { key: "heatmap", labelKey: "analysis.workspace.tabHeatmap", icon: Flame },
  { key: "overview", labelKey: "analysis.workspace.tabOverview", icon: Activity },
  { key: "players", labelKey: "analysis.workspace.tabPlayers", icon: Users },
  { key: "rounds", labelKey: "analysis.workspace.tabRounds", icon: ListChecks },
  { key: "economy", labelKey: "analysis.workspace.tabEconomy", icon: CircleDollarSign },
];

const ALL_TAG = "__all__";

function playerName(player) {
  if (typeof player === "string") return player.trim();
  return String(player?.name || player?.player_name || "").trim();
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

function PlayerPicker({ teams, teamAName, teamBName, activePlayer, parsedPlayers, totalPlayers, parsing, avatars, onSelect }) {
  const t = useT();
  const renderTeam = (players, teamName, tone) => {
    const isBlue = tone === "blue";
    return (
      <div className="border-b border-cs2-border-subtle last:border-b-0">
        <div className="flex items-center gap-2 px-3 pb-1.5 pt-2.5 text-[9px] font-bold uppercase tracking-[0.14em] text-cs2-text-muted">
          <span className="h-2 w-2 rounded-full" style={{ background: isBlue ? "var(--cs2-team-blue)" : "var(--cs2-team-amber)" }} />
          <span className="truncate">{teamName}</span>
        </div>
        <div className="pb-1">
          {players.map((player) => {
            const name = playerName(player);
            const active = name === activePlayer;
            const clipCount = (parsedPlayers?.[name]?.clips || []).filter((clip) => clip.category !== "meme_death").length;
            const appearance = playerAppearance(player, isBlue ? "blue" : "amber");
            const avatarUrl = avatars?.[steamIdForPlayer(player)] || "";
            return (
              <button
                key={`${name}-${player?.steam_id64 || player?.steam_id || ""}`}
                type="button"
                aria-label={t("analysis.workspace.selectPlayerAria", { name })}
                onClick={() => onSelect(name)}
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
                    {Number(player?.kills || 0)} / {Number(player?.deaths || 0)}
                  </span>
                </div>
                <span className={`min-w-6 text-right font-mono text-[9px] font-bold ${active ? "text-cs2-text-primary" : "text-cs2-text-muted"}`}>
                  {clipCount}
                </span>
              </button>
            );
          })}
        </div>
      </div>
    );
  };

  return (
    <section className="analysis-side-section flex min-h-0 flex-1 flex-col overflow-hidden">
      <header className="flex min-h-10 items-center justify-between gap-2 border-b border-cs2-border-subtle px-3">
        <h2 className="text-[11px] font-black uppercase tracking-[0.12em] text-cs2-text-primary">{t("analysis.workspace.selectPlayer")}</h2>
        <span className="inline-flex items-center gap-1.5 font-mono text-[10px] text-cs2-text-muted">
          {parsing ? <Loader2 className="h-3 w-3 animate-spin text-cs2-accent" /> : <Check className="h-3 w-3 text-emerald-400" />}
          {parsing
            ? t("analysis.workspace.parsingFullMatch")
            : t("analysis.workspace.parsedPlayers", { parsed: Object.keys(parsedPlayers || {}).length, total: totalPlayers })}
        </span>
      </header>
      <div className="custom-scrollbar min-h-0 flex-1 overflow-y-auto">
        {renderTeam(teams.a, teamAName, "blue")}
        {renderTeam(teams.b, teamBName, "amber")}
      </div>
    </section>
  );
}

function MatchRailSummary({ teamAName, teamBName, teamAScore, teamBScore, mapName, totalRounds, durationMins }) {
  const t = useT();
  return (
    <section className="analysis-side-section shrink-0 overflow-hidden">
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

function PlayerContextRail({
  activeTab,
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
  currentUpload,
  onPlayDemo,
  onSwitchDemo,
  switchDisabled,
  avatars,
}) {
  const t = useT();
  const isBlue = playerTeamNumber(selectedPlayer) === 2;
  const selectedAppearance = playerAppearance(selectedPlayer, isBlue ? "blue" : "amber");
  const selectedAvatarUrl = selectedPlayer ? avatars?.[steamIdForPlayer(selectedPlayer)] || "" : "";
  return (
    <aside className="analysis-side-rail custom-scrollbar h-full min-h-0 overflow-y-auto">
      <section className="analysis-side-section overflow-hidden">
        <header className="border-b border-cs2-border-subtle px-3 py-2.5">
          <p className="text-[9px] font-black uppercase tracking-[0.18em] text-cs2-text-muted">{t("analysis.workspace.playerContext")}</p>
        </header>
        {selectedPlayer ? (
          <div className="p-3">
            <div className="flex items-center gap-2.5">
              <PlayerIdentityAvatar player={selectedPlayer} avatarUrl={selectedAvatarUrl} fallbackTone={isBlue ? "blue" : "amber"} className="h-9 w-9 text-sm" />
              <div className="min-w-0">
                <h2 className="truncate text-[13px] font-black text-cs2-text-primary">{activePlayer}</h2>
                <p className="mt-0.5 text-[9px] font-bold uppercase tracking-[0.13em]" style={{ color: selectedAppearance.color }}>
                  {t("analysis.workspace.focusedPlayer")}
                </p>
              </div>
            </div>
            <div className="mt-3 grid grid-cols-3 divide-x divide-cs2-border-subtle border-y border-cs2-border-subtle py-2">
              {[
                [t("analysis.workspace.kills"), Number(selectedPlayer.kills || 0)],
                [t("analysis.workspace.deaths"), Number(selectedPlayer.deaths || 0)],
                [t("analysis.workspace.clips"), regularClips.length],
              ].map(([label, value]) => (
                <div key={label} className="px-2 text-center">
                  <strong className="block font-mono text-sm text-cs2-text-primary">{value}</strong>
                  <span className="mt-0.5 block text-[9px] text-cs2-text-muted">{label}</span>
                </div>
              ))}
            </div>
            {aiMode && activeTab === "highlights" && activeHighlightView === "clips" && (playerAiReviewing || playerAiReviewed) ? (
              <div className="mt-3 flex items-start gap-2 border-l-2 border-violet-500/45 bg-violet-500/8 px-2.5 py-2 text-[10px] text-violet-300">
                {playerAiReviewing ? <Loader2 className="mt-0.5 h-3.5 w-3.5 shrink-0 animate-spin" /> : <Bot className="mt-0.5 h-3.5 w-3.5 shrink-0" />}
                <span>{playerAiReviewing ? t("analysis.workspace.aiReviewing", { name: activePlayer }) : playerAiReviewed ? t("analysis.workspace.aiReviewed", { name: activePlayer }) : t("analysis.workspace.aiQueued", { name: activePlayer })}</span>
              </div>
            ) : null}
          </div>
        ) : (
          <div className="px-3 py-6 text-center">
            <Users className="mx-auto h-5 w-5 text-cs2-text-muted" />
            <p className="mt-2 text-[11px] font-bold text-cs2-text-primary">{t("analysis.workspace.noPlayerContext")}</p>
            <p className="mt-1 text-[9px] leading-relaxed text-cs2-text-muted">{t("analysis.workspace.pickPlayerHint")}</p>
          </div>
        )}
      </section>

      {activeTab === "highlights" && selectedPlayer ? (
        <section className="analysis-side-section px-3 pt-2.5">
          <p className="mb-1 text-[9px] font-black uppercase tracking-[0.18em] text-cs2-text-muted">{t("analysis.workspace.highlightMode")}</p>
          <div className="analysis-subnav">
            {[["clips", "analysis.tabClips"], ["rounds", "analysis.tabTimeline"], ["weapons", "analysis.tabWeaponKills"]].map(([key, labelKey]) => (
              <button key={key} type="button" data-active={activeHighlightView === key ? "true" : "false"} onClick={() => setActiveHighlightView(key)}>
                {t(labelKey)}
              </button>
            ))}
          </div>
        </section>
      ) : null}

      {activeTab === "highlights" && selectedPlayer && activeHighlightView === "clips" ? (
        <section className="analysis-side-section p-3">
          <p className="mb-1.5 text-[9px] font-black uppercase tracking-[0.18em] text-cs2-text-muted">{t("analysis.workspace.tags")}</p>
          <div className="flex flex-wrap gap-1">
            {tagCounts.map(([tag, count]) => (
              <button key={tag} type="button" data-active={selectedTag === tag ? "true" : "false"} onClick={() => setSelectedTag(tag)} className="analysis-filter-toggle">
                {tag === ALL_TAG ? t("analysis.workspace.allTags") : labelTag(tag, locale)} <span className="ml-0.5 font-mono opacity-70">{count}</span>
              </button>
            ))}
          </div>
        </section>
      ) : null}

      <section className="analysis-side-section p-3">
        <p className="mb-2 text-[9px] font-black uppercase tracking-[0.18em] text-cs2-text-muted">{t("analysis.workspace.demoActions")}</p>
        <div className="grid gap-1.5">
          <Button variant="secondary" size="sm" className="w-full justify-center" disabled={!currentUpload?.id && !currentUpload?.path} onClick={onPlayDemo}>
            <Play className="h-3 w-3 fill-current" />{t("analysis.workspace.playDemo")}
          </Button>
          <Button variant="secondary" size="sm" className="w-full justify-center" onClick={onSwitchDemo} disabled={switchDisabled}>
            <RefreshCw className="h-3.5 w-3.5" />{t("analysis.workspace.switchDemo")}
          </Button>
        </div>
      </section>
    </aside>
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

export default function DemoAnalysisPreviewPage() {
  const t = useT();
  const locale = useLocaleStore((state) => state.effectiveLocale);
  const s = useAppShell();
  const { requestPlayDemo, DemoPlaybackUi } = useDemoPlaybackDialog();
  const matches = s.matchTabsData || [];
  const currentUpload = s.uploadedDemos?.[s.currentMatchIndex] ?? null;
  const sessionIdentity = encodeURIComponent(String(
    currentUpload?.path
    || currentUpload?.id
    || matches[s.currentMatchIndex]?.demo_filename
    || matches[s.currentMatchIndex]?.filename
    || `demo-${s.currentMatchIndex}`,
  ));
  const sessionPrefix = `demo-analysis:${sessionIdentity}`;
  const [activeTab, setActiveTab] = useSessionState(`${sessionPrefix}:tab`, "highlights");
  const [activeHighlightView, setActiveHighlightView] = useSessionState(`${sessionPrefix}:highlight-view`, "clips");
  const [storedSelectedTag, setSelectedTag] = useSessionState(`${sessionPrefix}:tag`, ALL_TAG);
  const selectedTag = storedSelectedTag === "全部" ? ALL_TAG : storedSelectedTag;
  const [selectedRound, setSelectedRound] = useSessionState(`${sessionPrefix}:round`, null);
  const [replayRound, setReplayRound] = useSessionState(`${sessionPrefix}:replay-round`, null);
  const [statsPlayer, setStatsPlayer] = useSessionState(`${sessionPrefix}:stats-player`, "");
  const [layoutEditing, setLayoutEditing] = useState(false);
  const [layoutResetSignal, setLayoutResetSignal] = useState(0);
  const uploadedDemoCount = s.uploadedDemos?.length || 0;
  const parsedDemoCount = matches.filter((match) => match?.parsed).length;
  const allDemosParsed = uploadedDemoCount > 0
    && matches.length === uploadedDemoCount
    && matches.every((match) => match?.parsed);
  const analysisGateActive = Boolean(
    s.parsing
    || s.anyDemoParsing
    || s.analysisInlineProgress?.active,
  );
  const analysisGateText = s.analysisInlineProgress?.text
    || s.progressText
    || (analysisGateActive
      ? t("analysis.workspace.batchParsing", { parsed: parsedDemoCount, total: uploadedDemoCount })
      : t("analysis.workspace.batchPending", { n: Math.max(0, uploadedDemoCount - parsedDemoCount) }));
  const meta = s.matchMeta || currentUpload?.match_meta || matches[s.currentMatchIndex]?.match_meta || {};
  const teams = useMemo(() => splitTeams(s.players), [s.players]);
  const steamAvatars = useSteamPlayerAvatars(s.players);
  const teamAName = meta.team_a_name || firstTeamName(teams.a, "Team A");
  const teamBName = meta.team_b_name || firstTeamName(teams.b, "Team B");
  const workspaceFallback = useMemo(() => ({
    players: s.players,
    meta,
    teamAName,
    teamBName,
  }), [s.players, meta, teamAName, teamBName]);
  const workspace = useWorkspaceData(s.analysisWorkspace, workspaceFallback);
  const teamAScore = Number(workspace.team_a_score ?? meta.team_a_score ?? 0);
  const teamBScore = Number(workspace.team_b_score ?? meta.team_b_score ?? 0);
  const durationMins = Number(workspace.duration_mins ?? meta.duration_mins ?? 0);
  const totalRounds = Number(workspace.summary?.total_rounds ?? workspace.rounds?.length ?? meta.total_rounds ?? 0);
  const parsingCurrent = Boolean(s.parsing || s.parsingByIndex?.[s.currentMatchIndex]);
  const selectedCount = s.selectedPlayersList?.length || 0;
  const parsedNames = s.parsedPlayerNames || [];
  const parsedPlayers = s.currentParsed?.players || {};
  const activePlayer = s.currentActivePlayer || playerName(s.players?.[0]) || "";
  const selectedPlayer = (s.players || []).find((player) => playerName(player) === activePlayer) || null;
  const activePlayerResult = activePlayer ? parsedPlayers[activePlayer] : null;
  const playerAiReviewed = Boolean(activePlayerResult?.ai_reviewed) || (activePlayerResult?.clips || []).some((clip) => (
    clip?.ai_score != null || String(clip?.ai_commentary || clip?.ai_comment || "").trim()
  ));
  const playerAiReviewing = Boolean(s.aiReviewingPlayers?.[`${s.currentMatchIndex}:${activePlayer}`]);
  const regularClips = (s.clips || []).filter((clip) => clip.category !== "meme_death");
  const tagCounts = useMemo(() => {
    const counts = new Map([[ALL_TAG, regularClips.length]]);
    regularClips.forEach((clip) => (clip.context_tags || []).forEach((tag) => counts.set(tag, (counts.get(tag) || 0) + 1)));
    return [...counts.entries()];
  }, [regularClips]);
  const visibleClips = selectedTag === ALL_TAG
    ? regularClips
    : regularClips.filter((clip) => (clip.context_tags || []).includes(selectedTag));
  const weaponSummary = summarizeWeaponKills(s.roundTimeline);
  const canAnalyze = Boolean(s.hasDemos && selectedCount && !parsingCurrent && !s.batchRecording);

  const selectPlayer = (name) => {
    s.setActivePlayerTabs((previous) => ({ ...previous, [s.currentMatchIndex]: name }));
    setStatsPlayer(name);
    setActiveHighlightView("clips");
    setSelectedTag(ALL_TAG);
    if (s.aiMode) void s.ensurePlayerAiReview?.(name, s.currentMatchIndex);
  };

  const playCurrentDemo = () => {
    if (!currentUpload) return;
    void requestPlayDemo({
      id: currentUpload.id,
      path: currentUpload.path,
      label: currentUpload.filename || s.currentFilename || "Demo",
    });
  };

  const openPlayerStats = (name) => {
    setStatsPlayer(name);
    setActiveTab("players");
  };

  const openRound = (roundNumber) => {
    setSelectedRound(roundNumber);
    setActiveTab("rounds");
  };

  const openReplayRound = (roundNumber) => {
    setReplayRound(roundNumber);
    setActiveTab("replay");
  };

  const resetWorkspaceLayout = () => {
    clearDockLayout("analysis-workspace");
    clearDockLayout("analysis-replay-board");
    setLayoutResetSignal((value) => value + 1);
  };

  if (!s.hasDemos) {
    return (
      <div className="flex h-full min-h-0 flex-col overflow-y-auto bg-cs2-bg-page p-5 sm:p-6">
        <div className="mx-auto w-full max-w-5xl space-y-4">
          <div className="flex items-center justify-between gap-3"><div><h1 className="text-lg font-black text-cs2-text-primary">{t("analysis.workspace.title")}</h1><p className="mt-1 text-[11px] text-cs2-text-muted">{t("analysis.workspace.uploadHint")}</p></div><Link to="/library" className="inline-flex items-center gap-1.5 rounded-md border border-cs2-border bg-cs2-bg-input px-3 py-2 text-[11px] font-semibold text-cs2-text-secondary hover:border-cs2-accent/45 hover:text-cs2-text-primary"><Library className="h-3.5 w-3.5" />{t("analysis.workspace.openLibrary")}</Link></div>
          <DemoUpload onUpload={s.handleUpload} loading={Boolean(s.parsing)} loadingText={s.progressText} aiEnabled={Boolean(s.aiMode)} />
        </div>
      </div>
    );
  }

  if (!allDemosParsed || analysisGateActive) {
    return (
      <div className="flex h-full min-h-0 flex-col overflow-y-auto bg-cs2-bg-page p-5 sm:p-6">
        <div className="mx-auto w-full max-w-5xl space-y-4">
          <div className="flex items-center justify-between gap-3">
            <div>
              <h1 className="text-lg font-black text-cs2-text-primary">{t("analysis.workspace.title")}</h1>
              <p className="mt-1 text-[11px] text-cs2-text-muted">{t("analysis.workspace.waitForAll")}</p>
            </div>
            <Button variant="secondary" size="sm" onClick={s.handleResetDemo} disabled={analysisGateActive}>
              <RefreshCw className="h-3.5 w-3.5" />{t("analysis.workspace.resetDemos")}
            </Button>
          </div>
          <DemoUpload onUpload={s.handleUpload} loading loadingText={analysisGateText} aiEnabled={Boolean(s.aiMode)} />
        </div>
      </div>
    );
  }

  return (
    <div className="flex h-full min-h-0 w-full flex-col overflow-hidden bg-cs2-bg-page text-cs2-text-primary">
      <header className="relative z-[60] shrink-0 overflow-visible border-b border-cs2-border-subtle bg-cs2-bg-card/92 py-2 backdrop-blur-md">
        <div className={`${PAGE_CONTAINER_CLASS} flex flex-wrap items-center justify-between gap-3`} data-testid="demo-analysis-header-container">
          <div className="flex min-w-0 items-center gap-3">
            <div className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg bg-cs2-accent-soft text-cs2-accent"><BarChart3 className="h-4 w-4" /></div>
            <div className="min-w-0"><h1 className="text-[14px] font-black tracking-wide">{t("analysis.workspace.title")}</h1><p className="truncate font-mono text-[9px] text-cs2-text-muted">{s.currentFilename} · {s.currentMatchIndex + 1}/{matches.length}</p></div>
          </div>
          <div className="flex items-center gap-2">
            <Button
              variant={layoutEditing ? "primary" : "secondary"}
              size="sm"
              aria-pressed={layoutEditing}
              onClick={() => setLayoutEditing((value) => !value)}
            >
              <PanelsTopLeft className="h-3.5 w-3.5" />
              {layoutEditing ? t("analysis.layout.done") : t("analysis.layout.edit")}
            </Button>
            {layoutEditing ? (
              <Button variant="secondary" size="sm" onClick={resetWorkspaceLayout}>
                <RefreshCw className="h-3.5 w-3.5" />
                {t("analysis.layout.reset")}
              </Button>
            ) : null}
            <DemoSelector matches={matches} currentIndex={s.currentMatchIndex} onChange={s.setCurrentMatchIndex} disabled={s.batchRecording} />
          </div>
        </div>
      </header>

      <main className={`${PAGE_CONTAINER_CLASS} min-h-0 flex-1 py-3`} data-testid="demo-analysis-content-container">
        <DockableRow
          storageKey="analysis-workspace"
          ariaLabel={t("analysis.layout.outer")}
          editMode={layoutEditing}
          resetSignal={layoutResetSignal}
          className="analysis-workspace-grid h-full"
          panels={[
            {
              id: "left-rail",
              label: t("analysis.layout.leftRail"),
              minSize: 164,
              defaultSize: 228,
              className: "analysis-workspace-left",
              content: (
        <aside className="analysis-side-rail flex h-full min-h-0 flex-col overflow-hidden">
          <MatchRailSummary
            teamAName={teamAName}
            teamBName={teamBName}
            teamAScore={teamAScore}
            teamBScore={teamBScore}
            mapName={meta.map_name}
            totalRounds={totalRounds}
            durationMins={durationMins}
          />
          <PlayerPicker teams={teams} teamAName={teamAName} teamBName={teamBName} activePlayer={activePlayer} parsedPlayers={parsedPlayers} totalPlayers={s.players.length} parsing={parsingCurrent} avatars={steamAvatars} onSelect={selectPlayer} />
        </aside>
              ),
            },
            {
              id: "analysis-view",
              label: t("analysis.layout.center"),
              minSize: 480,
              defaultSize: 900,
              className: "analysis-workspace-center",
              content: (

        <section className="analysis-center-surface flex h-full min-h-0 min-w-0 flex-col overflow-hidden">
          <nav className="flex min-h-10 shrink-0 overflow-x-auto border-b border-cs2-border-subtle px-1 [scrollbar-width:none] [&::-webkit-scrollbar]:hidden" aria-label={t("analysis.workspace.demoViews")}>
            {TABS.map(({ key, labelKey, icon: Icon }) => (
              <button
                key={key}
                type="button"
                onPointerDown={() => {
                  if (activeTab === "replay" && key !== "replay") {
                    useReplayStore.getState().requestSuspendPlayback();
                  }
                }}
                onClick={() => setActiveTab(key)}
                className={`analysis-tab ${activeTab === key ? "analysis-tab--active" : ""}`}
              >
                <Icon className="h-3.5 w-3.5" />
                {t(labelKey)}
              </button>
            ))}
          </nav>

          <div className="custom-scrollbar min-h-0 flex-1 overflow-y-auto p-3">
            {activeTab === "highlights" && (
              <div className="space-y-3">
              {!s.currentParsed ? <EmptyResult parsing={parsingCurrent} onAnalyze={() => void s.handleParse()} disabled={!canAnalyze} /> : !selectedPlayer ? (
                <div className="flex min-h-[360px] items-center justify-center rounded-xl border border-dashed border-cs2-border bg-cs2-bg-page/45 p-8 text-center"><div><Users className="mx-auto h-7 w-7 text-cs2-text-muted" /><h2 className="mt-3 text-[13px] font-bold">{t("analysis.workspace.pickPlayerFirst")}</h2><p className="mt-1 text-[11px] text-cs2-text-muted">{t("analysis.workspace.pickPlayerHint")}</p></div></div>
              ) : (
                <>
                  <div className="analysis-context-strip">
                    <div className="flex min-w-0 items-center gap-2">
                      <span className="h-2 w-2 shrink-0 rounded-full" style={{ background: playerTeamNumber(selectedPlayer) === 2 ? "var(--cs2-team-blue)" : "var(--cs2-team-amber)" }} />
                      <b className="truncate text-[11px] text-cs2-text-primary">{activePlayer}</b>
                    </div>
                    <span className="shrink-0 font-mono text-[9px] text-cs2-text-muted">{t("analysis.workspace.playerClips", { kills: Number(selectedPlayer.kills || 0), deaths: Number(selectedPlayer.deaths || 0), clips: regularClips.length })}</span>
                  </div>

                  {activeHighlightView === "clips" && (
                    <>
                      <ClipList clips={visibleClips} targetPlayer={activePlayer} selectedIds={s.selectedClientClipUids} onToggle={s.handleToggleClip} aiMode={s.aiMode} queuedClientClipUids={s.queuedClientClipUidsForCurrentDemo} onDequeue={s.handleDequeueClip} parsedPlayers={parsedPlayers} matchTotalRounds={s.roundMontageMaxRounds} freezeToDeathDraft={s.freezeToDeathDraft} onFreezeToDeathDraftChange={s.setFreezeToDeathDraft} roundMontagePickerDisabled={parsingCurrent || s.batchRecording} suppressSummaryHeader />
                      {regularClips.length > 0 && <ActionBar selectedCount={s.selectedRegularCount} totalCount={s.regularSelectableTotal} hasSelection={s.selectedClientClipUids.size > 0} onSelectAll={s.handleSelectAll} onDeselectAll={s.handleDeselectAll} onAddSelectedToQueue={s.handleAddSelectedToQueue} onAddCurrentPlayerHighlights={s.handleAddCurrentPlayerHighlights} currentPlayer={activePlayer} queueLength={s.queue.length} batchRecording={s.batchRecording} canAddCurrentPlayerHighlights={s.canAddCurrentPlayerHighlights} sticky />}
                    </>
                  )}
                  {activeHighlightView === "rounds" && <RoundTimelineView roundTimeline={s.roundTimeline} focusedPlayer={activePlayer} demoFilename={s.currentFilename} mapName={s.matchMeta?.map_name || ""} queuedClientClipUids={s.queuedClientClipUidsForCurrentDemo} onAddEvent={s.handleAddTimelineEventToQueue} onAddRound={s.handleAddTimelineRoundToQueue} onAddEventsBatch={s.handleAddTimelineEventsBatchToQueue} onRemoveEvent={s.handleRemoveTimelineEventFromQueue} onRemoveRound={s.handleRemoveTimelineRoundFromQueue} suppressSummaryHeader />}
                  {activeHighlightView === "weapons" && <WeaponKillsView roundTimeline={s.roundTimeline} focusedPlayer={activePlayer} demoFilename={s.currentFilename} mapName={s.matchMeta?.map_name || ""} queuedClientClipUids={s.queuedClientClipUidsForCurrentDemo} onAdd={s.handleAddWeaponKillsToQueue} onRemove={s.handleDequeueClip} onAddEvent={s.handleAddTimelineEventToQueue} onRemoveEvent={s.handleRemoveTimelineEventFromQueue} suppressSummaryHeader />}
                </>
              )}
              </div>
            )}

            {activeTab === "replay" && (
            <Demo2DReplayPreview
              key={currentUpload?.path || currentUpload?.id || s.currentMatchIndex}
              workspace={workspace}
              demoPath={currentUpload?.path}
              players={s.players}
              teamAName={workspace.team_a_name || teamAName}
              teamBName={workspace.team_b_name || teamBName}
              initialRound={replayRound}
              onRoundChange={setReplayRound}
              layoutEditing={layoutEditing}
              layoutResetSignal={layoutResetSignal}
            />
            )}

            {activeTab === "heatmap" && (
            <DemoHeatmapView
              key={currentUpload?.path || currentUpload?.id || s.currentMatchIndex}
              workspace={workspace}
              demoPath={currentUpload?.path}
              players={s.players}
            />
            )}

            {activeTab === "overview" && (
            <OverviewView
              data={workspace}
              onSelectPlayer={openPlayerStats}
              onOpenRound={openRound}
              onOpenReplayRound={openReplayRound}
              onOpenHighlights={() => setActiveTab("highlights")}
            />
            )}

            {activeTab === "rounds" && (
            <RoundsView
              data={workspace}
              selectedRound={selectedRound}
              onSelectRound={setSelectedRound}
              onOpenReplayRound={openReplayRound}
            />
            )}

            {activeTab === "players" && (
            <PlayersView
              data={workspace}
              selectedPlayer={statsPlayer || activePlayer}
              onSelectPlayer={setStatsPlayer}
              onBackToOverview={() => setActiveTab("overview")}
            />
            )}

            {activeTab === "economy" && (
            <EconomyView data={workspace} onOpenRound={openRound} />
            )}
          </div>
        </section>
              ),
            },
            {
              id: "right-rail",
              label: t("analysis.layout.rightRail"),
              minSize: 164,
              defaultSize: 250,
              className: "analysis-workspace-right",
              content: (

        <PlayerContextRail
          activeTab={activeTab}
          activeHighlightView={activeHighlightView}
          setActiveHighlightView={setActiveHighlightView}
          selectedPlayer={selectedPlayer}
          activePlayer={activePlayer}
          regularClips={regularClips}
          playerAiReviewing={playerAiReviewing}
          playerAiReviewed={playerAiReviewed}
          aiMode={s.aiMode}
          tagCounts={tagCounts}
          selectedTag={selectedTag}
          setSelectedTag={setSelectedTag}
          locale={locale}
          currentUpload={currentUpload}
          onPlayDemo={playCurrentDemo}
          onSwitchDemo={s.handleResetDemo}
          switchDisabled={s.anyDemoParsing || s.batchRecording}
          avatars={steamAvatars}
        />
              ),
            },
          ]}
        />
      </main>
      <DemoPlaybackUi />
    </div>
  );
}
