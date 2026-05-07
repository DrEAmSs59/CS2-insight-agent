import { useState } from "react";
import DemoUpload from "../components/DemoUpload";
import PlayerSelect from "../components/PlayerSelect";
import MatchScoreboard from "../components/MatchScoreboard";
import ClipList from "../components/ClipList";
import RoundTimelineView from "../components/analysis/timeline/RoundTimelineView";
import ProgressBar from "../components/ProgressBar";
import ActionBar from "../components/ActionBar";
import MatchSwitcher from "../components/MatchSwitcher";
import { Loader2, RefreshCw, Film, User } from "lucide-react";
import { Link } from "react-router-dom";
import { useAppShell } from "../context/AppShellContext";

export default function AnalysisPage() {
  const s = useAppShell();
  const [analysisViewMode, setAnalysisViewMode] = useState("clips");
  const timelineRounds = s.timeline?.rounds?.length ?? 0;
  const roundTlLen = s.roundTimeline?.length ?? 0;
  const hasTimeline = roundTlLen > 0 || timelineRounds > 0;
  const showResultsBlock =
    s.currentParsed &&
    (s.clips.length > 0 || s.parsedPlayerNames.length > 0 || hasTimeline);
  const showPlayerTabs = s.parsedPlayerNames.length > 1;

  return (
    <div className="flex h-full min-h-0 w-full flex-col overflow-hidden">
      {s.hasDemos && (
        <header className="flex shrink-0 flex-wrap items-center justify-between gap-3 border-b border-white/10 bg-cs2-bg-dark/90 px-4 py-2.5 backdrop-blur-md sm:px-5">
          <p className="min-w-0 truncate text-[11px] text-zinc-500">
            <span className="font-mono text-zinc-400">{s.uploadedDemos.length}</span> 个 Demo 已导入
          </p>
          <div className="flex shrink-0 flex-wrap items-center gap-2">
            <Link
              to="/library"
              className="rounded-md border border-white/10 px-2.5 py-1.5 text-[11px] font-semibold text-zinc-400 hover:border-cs2-orange/45 hover:text-white"
            >
              Demo 库
            </Link>
            <button
              type="button"
              onClick={s.handleResetDemo}
              disabled={s.anyDemoParsing || s.batchRecording}
              className="flex items-center gap-1.5 rounded-md border border-cs2-border bg-cs2-bg-input px-2.5 py-1.5 text-[11px] font-semibold text-zinc-300 transition-colors hover:border-cs2-orange/45 hover:text-white disabled:opacity-40"
            >
              <RefreshCw className="h-3.5 w-3.5" />
              更换 Demo
            </button>
          </div>
        </header>
      )}

      <div className="min-h-0 flex-1 space-y-5 overflow-y-auto px-4 pb-6 pt-3 sm:px-5 sm:pt-4">
        {!s.hasDemos && !s.parsing && <DemoUpload onUpload={s.handleUpload} />}
        {!s.hasDemos && s.parsing && (
          <div className="flex flex-col items-center justify-center rounded-xl border border-white/10 bg-cs2-bg-card py-16 text-center">
            <Loader2 className="h-9 w-9 animate-spin text-cs2-orange" aria-hidden />
            <p className="mt-4 text-sm font-medium text-zinc-300">正在处理 Demo…</p>
          </div>
        )}

        {s.hasDemos && (
          <div className="space-y-3">
            <div className="rounded-lg border border-white/10 bg-cs2-bg-card px-3 py-3">
              <div className="mb-2 flex flex-wrap items-center gap-2 text-[11px] text-cs2-text-secondary">
                <span className="shrink-0 font-semibold text-zinc-400">当前场次</span>
                <span className="truncate font-mono text-zinc-300" title={s.currentFilename}>
                  {s.currentFilename}
                </span>
                {s.currentParsed && (
                  <span className="rounded border border-emerald-500/30 bg-emerald-500/10 px-1.5 py-0 text-[10px] font-semibold text-emerald-400/90">
                    已解析
                  </span>
                )}
                {s.uploadedDemos.length > 1 && (
                  <span className="rounded border border-white/10 px-1.5 py-0 text-[10px] text-zinc-500">
                    共 {s.uploadedDemos.length} 个文件
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
                {s.matchMeta && <MatchScoreboard matchMeta={s.matchMeta} />}
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
            <div className="rounded-lg border border-white/10 bg-cs2-bg-card/90 px-3 py-2">
              <ProgressBar
                text={
                  s.analysisInlineProgress?.text ??
                  (s.parsingByIndex[s.currentMatchIndex] ? "正在解析…" : "")
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
              <Film className="h-4 w-4 text-cs2-orange" />
              <h2 className="text-sm font-bold uppercase tracking-wide text-zinc-200">解析结果</h2>
              <span className="ml-auto text-right text-[11px] font-mono leading-snug text-cs2-text-secondary sm:text-xs">
                {analysisViewMode === "clips" ? (
                  <>
                    共 <span className="text-zinc-300">{s.clips.filter((c) => c.category !== "meme_death").length}</span>{" "}
                    条片段
                  </>
                ) : (
                  <>
                    共{" "}
                    <span className="text-zinc-300">
                      {s.roundTimeline?.length ?? s.timeline?.summary?.round_count ?? timelineRounds}
                    </span>{" "}
                    回合 ·{" "}
                    <span className="text-emerald-400/90">
                      {s.roundTimeline?.reduce((a, r) => a + (Number(r?.summary?.kills) || 0), 0) ||
                        s.timeline?.summary?.kill_count ||
                        0}
                    </span>{" "}
                    击杀 ·{" "}
                    <span className="text-rose-400/90">
                      {s.roundTimeline?.reduce((a, r) => a + (Number(r?.summary?.deaths) || 0), 0) ||
                        s.timeline?.summary?.death_count ||
                        0}
                    </span>{" "}
                    死亡
                  </>
                )}
              </span>
            </div>

            <div className="inline-flex rounded-lg border border-white/10 bg-cs2-bg-card/60 p-0.5">
              <button
                type="button"
                onClick={() => setAnalysisViewMode("clips")}
                className={[
                  "rounded-md px-3 py-1.5 text-[11px] font-semibold transition-colors",
                  analysisViewMode === "clips"
                    ? "bg-cs2-orange text-black shadow-sm"
                    : "text-zinc-500 hover:text-zinc-200",
                ].join(" ")}
              >
                片段卡片
              </button>
              <button
                type="button"
                onClick={() => setAnalysisViewMode("timeline")}
                disabled={!hasTimeline}
                title={!hasTimeline ? "请先完成解析以生成时间线" : undefined}
                className={[
                  "rounded-md px-3 py-1.5 text-[11px] font-semibold transition-colors",
                  analysisViewMode === "timeline"
                    ? "bg-cs2-orange text-black shadow-sm"
                    : "text-zinc-500 hover:text-zinc-200",
                  !hasTimeline ? "cursor-not-allowed opacity-40" : "",
                ].join(" ")}
              >
                回合时间线
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
                  <div className="flex flex-wrap gap-1.5 rounded-lg border border-white/8 bg-cs2-bg-card/60 p-1.5">
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
                              ? "bg-cs2-orange text-black shadow-md shadow-cs2-orange/30"
                              : "bg-white/5 text-zinc-400 hover:bg-white/10 hover:text-zinc-200",
                          ].join(" ")}
                        >
                          <User className="h-3 w-3 shrink-0" />
                          <span className="max-w-[120px] truncate">{name}</span>
                          <span
                            className={[
                              "rounded px-1 font-mono text-[10px] tabular-nums",
                              isActive ? "bg-black/20 text-black/80" : "bg-white/8 text-zinc-500",
                            ].join(" ")}
                          >
                            {cnt}
                          </span>
                        </button>
                      );
                    })}
                  </div>
                )}
                <RoundTimelineView
                  roundTimeline={s.roundTimeline}
                  focusedPlayer={s.currentActivePlayer || s.matchMeta?.target_player || ""}
                  demoFilename={s.currentFilename}
                  mapName={s.matchMeta?.map_name ?? ""}
                  queuedClientClipUids={s.queuedClientClipUidsForCurrentDemo}
                  onAddEvent={s.handleAddTimelineEventToQueue}
                  onAddRound={s.handleAddTimelineRoundToQueue}
                  onAddEventsBatch={s.handleAddTimelineEventsBatchToQueue}
                  suppressSummaryHeader
                />
              </div>
            )}
          </div>
        )}
      </div>

      {s.clips.length > 0 && (
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
    </div>
  );
}
