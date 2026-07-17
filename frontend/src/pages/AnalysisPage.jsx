import { useCallback, useState } from "react";
import DemoUpload from "../components/DemoUpload";
import PlayerSelect from "../components/PlayerSelect";
import MatchScoreboard from "../components/MatchScoreboard";
import ClipList from "../components/ClipList";
import RoundTimelineView from "../components/analysis/timeline/RoundTimelineView";
import WeaponKillsView from "../components/analysis/WeaponKillsView";
import ProgressBar from "../components/ProgressBar";
import ActionBar from "../components/ActionBar";
import MatchSwitcher from "../components/MatchSwitcher";
import { Loader2, RefreshCw, Film, User } from "lucide-react";
import { Link } from "react-router-dom";
import { useAppShell } from "../context/AppShellContext";
import { useT } from "../i18n/useT.js";
import { usePlayDemoToast } from "../hooks/usePlayDemoToast.jsx";
import { playDemoErrorLabel, playDemoInCs2 } from "../utils/playDemoInCs2.js";
import { summarizeWeaponKills } from "../utils/weaponKillCompilations.js";

export default function AnalysisPage() {
  const s = useAppShell();
  const t = useT();
  const { showPlayToast, PlayDemoToast } = usePlayDemoToast();
  const [analysisViewMode, setAnalysisViewMode] = useState("clips");
  const timelineRounds = s.timeline?.rounds?.length ?? 0;
  const roundTlLen = s.roundTimeline?.length ?? 0;
  const hasTimeline = roundTlLen > 0 || timelineRounds > 0;
  const weaponKillSummary = summarizeWeaponKills(s.roundTimeline);
  const hasWeaponKills = weaponKillSummary.killCount > 0;
  const showResultsBlock =
    s.currentParsed &&
    (s.clips.length > 0 || s.parsedPlayerNames.length > 0 || hasTimeline);
  const showPlayerTabs = s.parsedPlayerNames.length > 1;
  const currentUpload = s.uploadedDemos?.[s.currentMatchIndex] ?? null;

  const handlePlayCurrentDemo = useCallback(async () => {
    const label =
      (currentUpload?.filename && String(currentUpload.filename).trim()) ||
      s.currentFilename ||
      "Demo";
    try {
      await playDemoInCs2({ id: currentUpload?.id, path: currentUpload?.path });
      showPlayToast(true, label);
    } catch (e) {
      showPlayToast(false, playDemoErrorLabel(e));
    }
  }, [currentUpload, s.currentFilename, showPlayToast]);

  return (
    <div className="flex h-full min-h-0 w-full flex-col overflow-hidden">
      {s.hasDemos && (
        <header className="flex shrink-0 flex-wrap items-center justify-between gap-3 border-b border-cs2-border bg-cs2-bg-page/90 px-5 py-3 backdrop-blur-md sm:px-6">
          <p className="min-w-0 truncate text-[11px] text-cs2-text-muted">
            <span className="font-mono text-cs2-text-secondary">{s.uploadedDemos.length}</span>{" "}
            {t("analysis.demosImportedSuffix")}
          </p>
          <div className="flex shrink-0 flex-wrap items-center gap-2">
            <Link
              to="/library"
              className="rounded-md border border-cs2-border px-2.5 py-1.5 text-[11px] font-semibold text-cs2-text-secondary hover:border-cs2-accent/45 hover:text-cs2-text-primary"
            >
              {t("analysis.linkDemoLibrary")}
            </Link>
            <button
              type="button"
              onClick={s.handleResetDemo}
              disabled={s.anyDemoParsing || s.batchRecording}
              className="flex items-center gap-1.5 rounded-md border border-cs2-border bg-cs2-bg-input px-2.5 py-1.5 text-[11px] font-semibold text-cs2-text-secondary transition-colors hover:border-cs2-accent/45 hover:text-cs2-text-primary disabled:opacity-40"
            >
              <RefreshCw className="h-3.5 w-3.5" />
              {t("analysis.btnSwapDemo")}
            </button>
          </div>
        </header>
      )}

      <div className="min-h-0 flex-1 space-y-5 overflow-y-auto px-5 pb-6 pt-3 sm:px-6 sm:pt-4">
        <div className="mx-auto w-full max-w-[1200px] space-y-5">
        {!s.hasDemos && !s.parsing && <DemoUpload onUpload={s.handleUpload} />}
        {!s.hasDemos && s.parsing && (
          <div className="flex flex-col items-center justify-center rounded-xl border border-cs2-border bg-cs2-bg-card py-16 text-center">
            <Loader2 className="h-9 w-9 animate-spin text-cs2-accent" aria-hidden />
            <p className="mt-4 text-sm font-medium text-cs2-text-secondary">{t("analysis.parsing")}</p>
          </div>
        )}

        {s.hasDemos && (
          <div className="space-y-3">
            <div className="rounded-lg border border-cs2-border bg-cs2-bg-card px-3 py-3">
              <div className="mb-2 flex flex-wrap items-center gap-2 text-[11px] text-cs2-text-secondary">
                <span className="shrink-0 font-semibold text-cs2-text-secondary">{t("analysis.currentMatch")}</span>
                <span className="truncate font-mono text-cs2-text-secondary" title={s.currentFilename}>
                  {s.currentFilename}
                </span>
                {s.currentParsed && (
                  <span className="rounded border border-emerald-500/30 bg-emerald-500/10 px-1.5 py-0 text-[10px] font-semibold text-cs2-emerald-on-surface">
                    {t("analysis.badgeParsed")}
                  </span>
                )}
                {s.uploadedDemos.length > 1 && (
                  <span className="rounded border border-cs2-border px-1.5 py-0 text-[10px] text-cs2-text-muted">
                    {t("analysis.fileCount", { n: s.uploadedDemos.length })}
                  </span>
                )}
              </div>
              <MatchSwitcher
                matches={s.matchTabsData}
                currentIndex={s.currentMatchIndex}
                onChange={s.setCurrentMatchIndex}
                disabled={s.batchRecording}
              />
            </div>

            {s.players.length > 0 && (
              <div className="space-y-4">
                {s.matchMeta && (
                  <MatchScoreboard
                    matchMeta={s.matchMeta}
                    onPlay={currentUpload?.id || currentUpload?.path ? handlePlayCurrentDemo : undefined}
                  />
                )}
                <PlayerSelect
                  players={s.players}
                  selected={s.selectedPlayersList}
                  onSelect={(name) =>
                    s.setSelectedPlayers((prev) => {
                      const cur = prev[s.currentMatchIndex] ?? [];
                      const next = cur.includes(name) ? cur.filter((n) => n !== name) : [...cur, name];
                      return { ...prev, [s.currentMatchIndex]: next };
                    })
                  }
                  onAnalyze={s.handleParse}
                  disabled={
                    s.batchRecording || s.parsing || Boolean(s.parsingByIndex[s.currentMatchIndex])
                  }
                />
              </div>
            )}
          </div>
        )}

        {s.hasDemos &&
          (s.analysisInlineProgress != null || s.parsingByIndex[s.currentMatchIndex]) && (
            <div className="rounded-lg border border-cs2-border bg-cs2-bg-card px-3 py-2">
              <ProgressBar
                text={
                  s.analysisInlineProgress?.text ??
                  (s.parsingByIndex[s.currentMatchIndex] ? t("analysis.parsing") : "")
                }
                active={
                  Boolean(s.parsingByIndex[s.currentMatchIndex]) ||
                  Boolean(s.analysisInlineProgress?.active)
                }
                batchRecording={false}
              />
            </div>
          )}

        {showResultsBlock && (
          <div className="space-y-3">
            <div className="flex flex-wrap items-center gap-2">
              <Film className="h-4 w-4 text-cs2-accent" />
              <h2 className="text-sm font-bold uppercase tracking-wide text-cs2-text-primary">{t("analysis.resultsTitle")}</h2>
              <span className="ml-auto text-right text-[11px] font-mono leading-snug text-cs2-text-secondary sm:text-xs">
                {analysisViewMode === "clips" ? (
                  <>
                    {t("analysis.clipCount", { n: s.clips.filter((c) => c.category !== "meme_death").length })}
                  </>
                ) : analysisViewMode === "weapon_kills" ? (
                  <>
                    {t("analysis.weaponGroupCount", { n: weaponKillSummary.groupCount })} ·{" "}
                    <span className="text-cs2-emerald-on-surface">
                      {t("analysis.killCount", { n: weaponKillSummary.killCount })}
                    </span>
                  </>
                ) : (
                  <>
                    {t("analysis.roundCount", {
                      n: s.roundTimeline?.length ?? s.timeline?.summary?.round_count ?? timelineRounds,
                    })}{" "}
                    ·{" "}
                    <span className="text-cs2-emerald-on-surface">
                      {t("analysis.killCount", {
                        n:
                          s.roundTimeline?.reduce((a, r) => a + (Number(r?.summary?.kills) || 0), 0) ||
                          s.timeline?.summary?.kill_count ||
                          0,
                      })}
                    </span>{" "}
                    ·{" "}
                    <span className="text-rose-400/90">
                      {t("analysis.deathCount", {
                        n:
                          s.roundTimeline?.reduce((a, r) => a + (Number(r?.summary?.deaths) || 0), 0) ||
                          s.timeline?.summary?.death_count ||
                          0,
                      })}
                    </span>
                  </>
                )}
              </span>
            </div>

            <div className="inline-flex rounded-lg border border-cs2-border bg-cs2-bg-card p-0.5">
              <button
                type="button"
                onClick={() => setAnalysisViewMode("clips")}
                className={[
                  "rounded-md px-3 py-1.5 text-[11px] font-semibold transition-colors",
                  analysisViewMode === "clips"
                    ? "bg-cs2-accent text-cs2-text-on-accent shadow-sm"
                    : "text-cs2-text-muted hover:text-cs2-text-primary",
                ].join(" ")}
              >
                {t("analysis.tabClips")}
              </button>
              <button
                type="button"
                onClick={() => setAnalysisViewMode("timeline")}
                disabled={!hasTimeline}
                title={!hasTimeline ? t("analysis.tabTimelineDisabledTitle") : undefined}
                className={[
                  "rounded-md px-3 py-1.5 text-[11px] font-semibold transition-colors",
                  analysisViewMode === "timeline"
                    ? "bg-cs2-accent text-cs2-text-on-accent shadow-sm"
                    : "text-cs2-text-muted hover:text-cs2-text-primary",
                  !hasTimeline ? "cursor-not-allowed opacity-40" : "",
                ].join(" ")}
              >
                {t("analysis.tabTimeline")}
              </button>
              <button
                type="button"
                onClick={() => setAnalysisViewMode("weapon_kills")}
                disabled={!hasWeaponKills}
                title={!hasWeaponKills ? t("analysis.tabWeaponKillsDisabledTitle") : undefined}
                className={[
                  "rounded-md px-3 py-1.5 text-[11px] font-semibold transition-colors",
                  analysisViewMode === "weapon_kills"
                    ? "bg-cs2-accent text-cs2-text-on-accent shadow-sm"
                    : "text-cs2-text-muted hover:text-cs2-text-primary",
                  !hasWeaponKills ? "cursor-not-allowed opacity-40" : "",
                ].join(" ")}
              >
                {t("analysis.tabWeaponKills")}
              </button>
            </div>

            {analysisViewMode === "clips" ? (
              <ClipList
                clips={s.clips}
                targetPlayer={s.matchMeta?.target_player ?? ""}
                selectedIds={s.selectedClientClipUids}
                onToggle={s.handleToggleClip}
                aiMode={s.aiMode}
                queuedClientClipUids={s.queuedClientClipUidsForCurrentDemo}
                onDequeue={s.handleDequeueClip}
                playerTabs={s.parsedPlayerNames}
                activePlayerTab={s.currentActivePlayer}
                onPlayerTabChange={(name) =>
                  s.setActivePlayerTabs((prev) => ({ ...prev, [s.currentMatchIndex]: name }))
                }
                parsedPlayers={s.currentParsed?.players ?? {}}
                matchTotalRounds={s.roundMontageMaxRounds}
                freezeToDeathDraft={s.freezeToDeathDraft}
                onFreezeToDeathDraftChange={s.setFreezeToDeathDraft}
                roundMontagePickerDisabled={Boolean(
                  s.parsing || s.parsingByIndex[s.currentMatchIndex] || s.batchRecording
                )}
                suppressSummaryHeader
              />
            ) : (
              <div className="space-y-4">
                {showPlayerTabs && (
                  <div className="flex flex-wrap gap-1.5 rounded-lg border border-cs2-border bg-cs2-bg-card p-1.5">
                    {s.parsedPlayerNames.map((name) => {
                      const pd = s.currentParsed?.players?.[name];
                      const cnt = (pd?.clips ?? []).filter((c) => c.category !== "meme_death").length;
                      const isActive = name === s.currentActivePlayer;
                      return (
                        <button
                          key={name}
                          type="button"
                          onClick={() =>
                            s.setActivePlayerTabs((prev) => ({ ...prev, [s.currentMatchIndex]: name }))
                          }
                          className={[
                            "flex items-center gap-1.5 rounded-md px-3 py-1.5 text-[12px] font-semibold transition-all duration-150",
                            isActive
                              ? "bg-cs2-accent text-cs2-text-on-accent shadow-md shadow-cs2-accent/30"
                              : "bg-cs2-bg-hover text-cs2-text-secondary hover:bg-cs2-bg-input/50 hover:text-cs2-text-primary",
                          ].join(" ")}
                        >
                          <User className="h-3 w-3 shrink-0" />
                          <span className="max-w-[120px] truncate">{name}</span>
                          <span
                            className={[
                              "rounded px-1 font-mono text-[10px] tabular-nums",
                              isActive ? "bg-cs2-bg-card text-cs2-text-on-accent/80" : "bg-cs2-bg-active text-cs2-text-muted",
                            ].join(" ")}
                          >
                            {cnt}
                          </span>
                        </button>
                      );
                    })}
                  </div>
                )}
                {analysisViewMode === "weapon_kills" ? (
                  <WeaponKillsView
                    roundTimeline={s.roundTimeline}
                    focusedPlayer={s.currentActivePlayer || s.matchMeta?.target_player || ""}
                    demoFilename={s.currentFilename}
                    mapName={s.matchMeta?.map_name ?? ""}
                    queuedClientClipUids={s.queuedClientClipUidsForCurrentDemo}
                    onAdd={s.handleAddWeaponKillsToQueue}
                    onRemove={s.handleDequeueClip}
                    onAddEvent={s.handleAddTimelineEventToQueue}
                    onRemoveEvent={s.handleRemoveTimelineEventFromQueue}
                    suppressSummaryHeader
                  />
                ) : (
                  <RoundTimelineView
                    roundTimeline={s.roundTimeline}
                    focusedPlayer={s.currentActivePlayer || s.matchMeta?.target_player || ""}
                    demoFilename={s.currentFilename}
                    mapName={s.matchMeta?.map_name ?? ""}
                    queuedClientClipUids={s.queuedClientClipUidsForCurrentDemo}
                    onAddEvent={s.handleAddTimelineEventToQueue}
                    onAddRound={s.handleAddTimelineRoundToQueue}
                    onAddEventsBatch={s.handleAddTimelineEventsBatchToQueue}
                    onRemoveEvent={s.handleRemoveTimelineEventFromQueue}
                    onRemoveRound={s.handleRemoveTimelineRoundFromQueue}
                    suppressSummaryHeader
                  />
                )}
              </div>
            )}
          </div>
        )}
        </div>
      </div>

      {s.clips.length > 0 && analysisViewMode === "clips" && (
        <ActionBar
          selectedCount={s.selectedRegularCount}
          totalCount={s.regularSelectableTotal}
          hasSelection={s.selectedClientClipUids.size > 0}
          onSelectAll={s.handleSelectAll}
          onDeselectAll={s.handleDeselectAll}
          onAddSelectedToQueue={s.handleAddSelectedToQueue}
          onAddAllHighlightsAllMatches={s.handleAddAllHighlightsAllMatches}
          queueLength={s.queue.length}
          batchRecording={s.batchRecording}
          canAddAllHighlights={s.canAddAllHighlights}
        />
      )}
      <PlayDemoToast />
    </div>
  );
}
