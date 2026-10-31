import { lazy, Suspense, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Link } from "react-router-dom";
import { ArrowRight, BarChart3, Library, Loader2, Play, RefreshCw, Users } from "lucide-react";
import ActionBar from "../../components/ActionBar";
import ClipList from "../../components/ClipList";
import CompilationPacks from "./CompilationPacks";
import QuickQueueActions from "./QuickQueueActions";
import DemoUpload from "../../components/DemoUpload";
import RoundTimelineView from "./workspaces/timeline/RoundTimelineView";
import WeaponKillsView from "./workspaces/WeaponKillsView";
import Demo2DReplayPreview from "./replay/Demo2DReplayPreview";
import DemoHeatmapView from "./replay/DemoHeatmapView";
import PlayerIdentityAvatar from "./cosmetics/PlayerIdentityAvatar";
import { useReplayStore } from "./replay/replayStore";
import {
  EconomyView,
  OverviewView,
  PlayersView,
  RoundsView,
  useWorkspaceData,
} from "./workspaces/DemoAnalysisWorkspaceViews";
import Button from "../../components/ui/Button";
import LucasWorkshopBackground from "../cosmetics-workshop/LucasWorkshopBackground.jsx";
import "../cosmetics-workshop/lucasWorkshop.css";
import { useAppShell } from "../../context/AppShellContext";
import { useDemoPlaybackDialog } from "../../hooks/useDemoPlaybackDialog.jsx";
import { useSteamPlayerAvatars } from "../../hooks/useSteamPlayerAvatars.js";
import useSessionState from "../../hooks/useSessionState";
import { useT } from "../../i18n/useT.js";
import { useLocaleStore } from "../../i18n/localeStore.js";
import { labelTag } from "../../utils/tagDescriptions.js";
import { summarizeWeaponKills } from "../../utils/weaponKillCompilations.js";
import { playerAppearance, steamIdForPlayer } from "../../utils/playerAppearance.js";
import { playerIdentityKey } from "../../utils/playerIdentity.js";
import { ALL_TAG, AnalysisViewNavigation, DemoSelector, EmptyResult, HighlightWorkspaceToolbar, MatchRailSummary, PAGE_CONTAINER_CLASS, PlayerPicker, firstTeamName, playerName, splitTeams } from "./DemoAnalysisScaffold.jsx";

const CosmeticsView = lazy(() => import("./cosmetics/CosmeticsView"));

export default function DemoAnalysisPage() {
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
  const {
    avatars: steamAvatars,
    onlineAssetsEnabled,
  } = useSteamPlayerAvatars(s.players);
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
  const activePlayer = s.currentActivePlayer || playerIdentityKey(s.players?.[0]) || "";
  const selectedPlayer = (s.players || []).find((player) => playerIdentityKey(player) === activePlayer) || null;
  const activePlayerLabel = playerName(selectedPlayer) || activePlayer;
  const selectedAvatarUrl = selectedPlayer ? steamAvatars?.[steamIdForPlayer(selectedPlayer)] || "" : "";
  const activeAnalysisPlayer = (workspace.players || []).find((player) => (
    playerIdentityKey(player) === activePlayer
  ))?.name || activePlayerLabel;
  const activePlayerResult = activePlayer ? parsedPlayers[activePlayer] : null;
  const playerAiReviewed = Boolean(activePlayerResult?.ai_reviewed) || (activePlayerResult?.clips || []).some((clip) => (
    clip?.ai_score != null || String(clip?.ai_commentary || clip?.ai_comment || "").trim()
  ));
  const playerAiReviewing = Boolean(s.aiReviewingPlayers?.[`${s.currentMatchIndex}:${activePlayer}`]);
  const regularClips = (s.clips || []).filter((clip) => clip.category !== "meme_death");
  const compilationClips = regularClips.filter((clip) => clip.category === "compilation");
  const singleClips = regularClips.filter((clip) => clip.category !== "compilation");
  const tagCounts = useMemo(() => {
    const counts = new Map([[ALL_TAG, singleClips.length]]);
    singleClips.forEach((clip) => (clip.context_tags || []).forEach((tag) => counts.set(tag, (counts.get(tag) || 0) + 1)));
    return [...counts.entries()];
  }, [singleClips]);
  const activeTag = selectedTag !== ALL_TAG && tagCounts.some(([tag]) => tag === selectedTag) ? selectedTag : ALL_TAG;
  const visibleClips = activeTag === ALL_TAG
    ? singleClips
    : singleClips.filter((clip) => (clip.context_tags || []).includes(activeTag));
  const weaponSummary = summarizeWeaponKills(s.roundTimeline);
  const modeCounts = {
    clips: singleClips.length,
    rounds: Array.isArray(s.roundTimeline) ? s.roundTimeline.length : 0,
    weapons: weaponSummary.groupCount,
  };
  const canAnalyze = Boolean(s.hasDemos && selectedCount && !parsingCurrent && !s.batchRecording);
  const showDockedActionBar = activeTab === "highlights"
    && activeHighlightView === "clips"
    && Boolean(selectedPlayer)
    && regularClips.length > 0;

  const selectPlayer = (value) => {
    const matched = [...(s.players || []), ...(workspace.players || [])].find((player) => (
      playerIdentityKey(player) === value
      || String(player?.name || "") === value
    ));
    const playerKey = matched ? playerIdentityKey(matched) : value;
    s.setActivePlayerTabs((previous) => ({ ...previous, [s.currentMatchIndex]: playerKey }));
    setActiveHighlightView("clips");
    setSelectedTag(ALL_TAG);
    if (s.aiMode) void s.ensurePlayerAiReview?.(playerKey, s.currentMatchIndex);
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
    selectPlayer(name);
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

  const selectAnalysisTab = (key) => {
    if (activeTab === "replay" && key !== "replay") {
      useReplayStore.getState().requestSuspendPlayback();
    }
    setActiveTab(key);
  };

  if (!s.hasDemos) {
    return (
      <div className="relative isolate flex h-full min-h-0 flex-col overflow-y-auto bg-cs2-bg-page p-5 sm:p-6">
        <LucasWorkshopBackground locale={locale} />
        <div className="mx-auto w-full max-w-5xl space-y-4">
          <div className="flex items-center justify-between gap-3 rounded-xl border border-cs2-border-subtle bg-cs2-bg-card/90 px-4 py-3 backdrop-blur-md"><div><h1 className="text-lg font-black text-cs2-text-primary">{t("analysis.workspace.title")}</h1><p className="mt-1 text-[11px] text-cs2-text-muted">{t("analysis.workspace.uploadHint")}</p></div><Link to="/library" className="inline-flex items-center gap-1.5 rounded-md border border-cs2-border bg-cs2-bg-input px-3 py-2 text-[11px] font-semibold text-cs2-text-secondary hover:border-cs2-accent/45 hover:text-cs2-text-primary"><Library className="h-3.5 w-3.5" />{t("analysis.workspace.openLibrary")}</Link></div>
          <DemoUpload onUpload={s.handleUpload} loading={Boolean(s.parsing)} loadingText={s.progressText} aiEnabled={Boolean(s.aiMode)} />
        </div>
      </div>
    );
  }

  if (!allDemosParsed || analysisGateActive) {
    return (
      <div className="relative isolate flex h-full min-h-0 flex-col overflow-y-auto bg-cs2-bg-page p-5 sm:p-6">
        <LucasWorkshopBackground locale={locale} />
        <div className="mx-auto w-full max-w-5xl space-y-4">
          <div className="flex items-center justify-between gap-3 rounded-xl border border-cs2-border-subtle bg-cs2-bg-card/90 px-4 py-3 backdrop-blur-md">
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
    <div className="relative isolate flex h-full min-h-0 w-full flex-col overflow-hidden bg-cs2-bg-page text-cs2-text-primary">
      <LucasWorkshopBackground locale={locale} />
      <header className="relative z-[60] shrink-0 overflow-visible border-b border-cs2-border-subtle bg-cs2-bg-card/92 py-2 backdrop-blur-md">
        <div className={`${PAGE_CONTAINER_CLASS} flex flex-wrap items-center justify-between gap-3`} data-testid="demo-analysis-header-container">
          <div className="flex min-w-0 items-center gap-3">
            <div className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg bg-cs2-accent-soft text-cs2-accent"><BarChart3 className="h-4 w-4" /></div>
            <div className="min-w-0"><h1 className="text-[14px] font-black tracking-wide">{t("analysis.workspace.title")}</h1><p className="truncate font-mono text-[9px] text-cs2-text-muted">{s.currentFilename} · {s.currentMatchIndex + 1}/{matches.length}</p></div>
          </div>
          <div className="flex flex-wrap items-center gap-2">
            <Link
              to="/queue"
              data-testid="analysis-queue-link"
              className="inline-flex h-7 items-center gap-1.5 rounded-full bg-cs2-accent-soft px-3 text-[11px] font-semibold text-cs2-accent transition-colors hover:brightness-110"
            >
              {t("analysis.workspace.queueLink", { n: s.queue?.length ?? 0 })}
              <ArrowRight className="h-3 w-3" aria-hidden />
            </Link>
            <Button variant="secondary" size="sm" disabled={!currentUpload?.id && !currentUpload?.path} onClick={playCurrentDemo}>
              <Play className="h-3.5 w-3.5 fill-current" />
              {t("analysis.workspace.playDemo")}
            </Button>
            <Button variant="secondary" size="sm" onClick={s.handleResetDemo} disabled={s.anyDemoParsing || s.batchRecording}>
              <RefreshCw className="h-3.5 w-3.5" />
              {t("analysis.workspace.switchDemo")}
            </Button>
            <DemoSelector matches={matches} currentIndex={s.currentMatchIndex} onChange={s.setCurrentMatchIndex} disabled={s.batchRecording} />
          </div>
        </div>
      </header>

      <main className={`${PAGE_CONTAINER_CLASS} min-h-0 flex-1 py-3`} data-testid="demo-analysis-content-container">
        <div className="analysis-workspace-grid h-full" data-testid="analysis-fixed-workspace">
          <aside className="flex h-full min-h-0 flex-col gap-2 overflow-hidden" data-testid="analysis-scoreboard-panel">
            <MatchRailSummary
              teamAName={teamAName}
              teamBName={teamBName}
              teamAScore={teamAScore}
              teamBScore={teamBScore}
              mapName={meta.map_name}
              totalRounds={totalRounds}
              durationMins={durationMins}
            />
            <PlayerPicker teams={teams} teamAName={teamAName} teamBName={teamBName} activePlayer={activePlayer} playerStats={workspace.players} parsedPlayers={parsedPlayers} totalPlayers={s.players.length} parsing={parsingCurrent} avatars={steamAvatars} onSelect={selectPlayer} />
          </aside>

          <section className="flex h-full min-h-0 min-w-0 flex-col gap-2" data-testid="analysis-main-panel">
            <AnalysisViewNavigation activeTab={activeTab} onSelectTab={selectAnalysisTab} />
            <div className="analysis-center-surface flex min-h-0 flex-1 flex-col overflow-hidden" data-testid="analysis-view-content-card">
              <div className="custom-scrollbar min-h-0 flex-1 overflow-y-auto p-3">
              {activeTab === "highlights" && (
                <div className="space-y-3">
                  {!s.currentParsed ? <EmptyResult parsing={parsingCurrent} onAnalyze={() => void s.handleParse()} disabled={!canAnalyze} /> : !selectedPlayer ? (
                    <div className="flex min-h-[360px] items-center justify-center rounded-xl border border-dashed border-cs2-border bg-cs2-bg-page/45 p-8 text-center"><div><Users className="mx-auto h-7 w-7 text-cs2-text-muted" /><h2 className="mt-3 text-[13px] font-bold">{t("analysis.workspace.pickPlayerFirst")}</h2><p className="mt-1 text-[11px] text-cs2-text-muted">{t("analysis.workspace.pickPlayerHint")}</p></div></div>
                  ) : (
                    <>
                      <HighlightWorkspaceToolbar
                        activeHighlightView={activeHighlightView}
                        setActiveHighlightView={setActiveHighlightView}
                        selectedPlayer={selectedPlayer}
                        activePlayer={activePlayerLabel}
                        regularClips={regularClips}
                        playerAiReviewing={playerAiReviewing}
                        playerAiReviewed={playerAiReviewed}
                        aiMode={s.aiMode}
                        tagCounts={tagCounts}
                        selectedTag={activeTag}
                        setSelectedTag={setSelectedTag}
                        locale={locale}
                        avatars={steamAvatars}
                        modeCounts={modeCounts}
                      />
                      {activeHighlightView === "clips" && (
                        <>
                          <div className="grid gap-4 lg:grid-cols-[minmax(0,2fr)_minmax(0,3fr)]">
                            <QuickQueueActions
                              currentPlayer={activePlayerLabel}
                              onAddHighlights={s.handleAddCurrentPlayerHighlights}
                              onAddFails={s.handleAddCurrentPlayerFails}
                              canAddHighlights={s.canAddCurrentPlayerHighlights}
                              canAddFails={s.canAddCurrentPlayerFails}
                              disabled={parsingCurrent || s.batchRecording}
                            />
                            <div className="min-w-0 flex-1">
                              <CompilationPacks
                                clips={compilationClips}
                                locale={locale}
                                queuedClientClipUids={s.queuedClientClipUidsForCurrentDemo}
                                onAdd={s.handleAddClipToQueue}
                                onRemove={s.handleDequeueClip}
                                freezeToDeathDraft={s.freezeToDeathDraft}
                                onFreezeToDeathDraftChange={s.setFreezeToDeathDraft}
                                matchTotalRounds={s.roundMontageMaxRounds}
                                disabled={parsingCurrent || s.batchRecording}
                              />
                            </div>
                          </div>
                          {singleClips.length ? (
                            <div className="flex flex-wrap items-baseline justify-between gap-2 pt-1">
                              <h3 className="text-[13px] font-semibold text-cs2-text-primary">{t("analysis.clipsTitle")}</h3>
                              <span className="text-xs text-cs2-text-muted">
                                {activeTag === ALL_TAG
                                  ? t("analysis.clipsCount", { n: visibleClips.length })
                                  : t("analysis.clipsFilteredCount", { tag: labelTag(activeTag, locale), n: visibleClips.length })}
                              </span>
                            </div>
                          ) : null}
                          <ClipList clips={visibleClips} targetPlayer={activePlayer} selectedIds={s.selectedClientClipUids} onToggle={s.handleToggleClip} aiMode={s.aiMode} queuedClientClipUids={s.queuedClientClipUidsForCurrentDemo} onDequeue={s.handleDequeueClip} onEnqueue={s.handleAddClipToQueue} onTagClick={(tag) => setSelectedTag(activeTag === tag ? ALL_TAG : tag)} activeTag={activeTag} parsedPlayers={parsedPlayers} matchTotalRounds={s.roundMontageMaxRounds} freezeToDeathDraft={s.freezeToDeathDraft} onFreezeToDeathDraftChange={s.setFreezeToDeathDraft} roundMontagePickerDisabled={parsingCurrent || s.batchRecording} suppressSummaryHeader />
                        </>
                      )}
                      {activeHighlightView === "rounds" && <RoundTimelineView demoPath={currentUpload?.path} targetSteamId={s.matchMeta?.target_steam_id} roundTimeline={s.roundTimeline} focusedPlayer={activeAnalysisPlayer} demoFilename={s.currentFilename} mapName={s.matchMeta?.map_name || ""} queuedClientClipUids={s.queuedClientClipUidsForCurrentDemo} onAddEvent={s.handleAddTimelineEventToQueue} onAddRound={s.handleAddTimelineRoundToQueue} onAddEventsBatch={s.handleAddTimelineEventsBatchToQueue} onRemoveEvent={s.handleRemoveTimelineEventFromQueue} onRemoveRound={s.handleRemoveTimelineRoundFromQueue} suppressSummaryHeader />}
                      {activeHighlightView === "weapons" && <WeaponKillsView roundTimeline={s.roundTimeline} focusedPlayer={activeAnalysisPlayer} demoFilename={s.currentFilename} mapName={s.matchMeta?.map_name || ""} queuedClientClipUids={s.queuedClientClipUidsForCurrentDemo} onAdd={s.handleAddWeaponKillsToQueue} onRemove={s.handleDequeueClip} onAddEvent={s.handleAddTimelineEventToQueue} onRemoveEvent={s.handleRemoveTimelineEventFromQueue} suppressSummaryHeader />}
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
                />
              )}

              {activeTab === "heatmap" && (
                <DemoHeatmapView
                  key={currentUpload?.path || currentUpload?.id || s.currentMatchIndex}
                  workspace={workspace}
                  demoPath={currentUpload?.path}
                  players={s.players}
                  selectedPlayer={activePlayer}
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
                  selectedPlayer={activePlayer}
                  rosterPlayer={selectedPlayer}
                  avatarUrl={selectedAvatarUrl}
                  onBackToOverview={() => setActiveTab("overview")}
                />
              )}

              {activeTab === "cosmetics" && (
                <Suspense fallback={<div className="flex min-h-full items-center justify-center" aria-label={t("app.loadingPage")}><Loader2 className="h-7 w-7 animate-spin text-cs2-orange" /></div>}>
                  <CosmeticsView
                    key={`${currentUpload?.id ?? "no-id"}:${currentUpload?.path || s.currentMatchIndex}`}
                    workspace={workspace}
                    selectedPlayer={selectedPlayer || workspace.players?.find((player) => playerIdentityKey(player) === activePlayer)}
                    locale={locale}
                    onlineAssetsEnabled={onlineAssetsEnabled}
                    demoId={currentUpload?.id}
                    avatarUrl={selectedAvatarUrl}
                  />
                </Suspense>
              )}

              {activeTab === "economy" && <EconomyView data={workspace} onOpenRound={openRound} />}
              </div>
              {showDockedActionBar ? (
                <ActionBar
                  selectedCount={s.selectedRegularCount}
                  totalCount={s.regularSelectableTotal}
                  hasSelection={s.selectedClientClipUids.size > 0}
                  onSelectAll={s.handleSelectAll}
                  onDeselectAll={s.handleDeselectAll}
                  onAddSelectedToQueue={s.handleAddSelectedToQueue}
                  batchRecording={s.batchRecording}
                />
              ) : null}
            </div>
          </section>
        </div>
      </main>
      <DemoPlaybackUi />
    </div>
  );
}
