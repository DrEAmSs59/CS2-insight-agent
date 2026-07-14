import React, { useState, useEffect, useCallback, useMemo } from "react";
import API from "../api/api";
import { useLocaleStore } from "../i18n/localeStore";
import { useT } from "../i18n/useT.js";
import {
  X,
  Loader2,
  CheckCircle2,
  User,
} from "lucide-react";
import {
  ensureClientClipUidsOnClips,
} from "../utils/clipClientUid";
import {
  freezeToDeathDraftFromClipFilter,
  isFreezeToDeathCompilation,
  sliceFreezeToDeathClipForEnqueue,
} from "../utils/freezeToDeathRoundFilter";
import MatchScoreboard from "./MatchScoreboard";
import PlayerSelect from "./PlayerSelect";
import ClipList from "./ClipList";
import ActionBar from "./ActionBar";
import RoundTimelineView from "./analysis/timeline/RoundTimelineView";
import WeaponKillsView from "./analysis/WeaponKillsView";
import { buildTimelineEventClipData, buildTimelineRoundClipData } from "../utils/timelineQueue";
import { summarizeWeaponKills } from "../utils/weaponKillCompilations.js";

/**
 * @param {{
 *   open: boolean;
 *   onClose: () => void;
 *   demoId: number | null;
 *   onAddToQueue: (clipData: any[]) => void;
 *   onEnqueueNotice?: (message: string, meta?: { autoDismissMs?: number; queueLink?: boolean }) => void;
 *   expectedPlayers: string[];
 *   aiMode: boolean;
 *   queuedClientClipUids?: Set<string>;
 *   queueLength?: number;
 *   onDequeue?: (clientClipUid: string) => void;
 * }} props
 */
export default function DemoInfoModal({
  open,
  onClose,
  demoId,
  onAddToQueue,
  onEnqueueNotice,
  expectedPlayers = [],
  aiMode = false,
  queuedClientClipUids = new Set(),
  queueLength = 0,
  onDequeue,
}) {
  const t = useT();
  const [tab, setTab] = useState("parse"); // "parse" | "clips" | "weapon_kills" | "timeline"
  const [loading, setLoading] = useState(false);
  const [parsing, setParsing] = useState(false);
  const [demoData, setDemoData] = useState(null);
  const [parsedPlayers, setParsedPlayers] = useState({});
  const [selectedPlayers, setSelectedPlayers] = useState([]);
  const [selectedClipUids, setSelectedClipUids] = useState(new Set());
  const [progressText, setProgressText] = useState("");
  const [progressSuccess, setProgressSuccess] = useState(false);
  const [activePlayerTab, setActivePlayerTab] = useState("");
  
  // 针对合集（如 211）的轮数选择草稿
  const [freezeToDeathDraft, setFreezeToDeathDraft] = useState({ picked: [] });

  useEffect(() => {
    if (!open || !demoId) return;
    let cancelled = false;
    setTab("parse");
    setParsedPlayers({});
    setSelectedClipUids(new Set());
    setProgressText("");
    setProgressSuccess(false);
    setSelectedPlayers([]);
    setActivePlayerTab("");
    setFreezeToDeathDraft({ picked: [] });

    (async () => {
      setLoading(true);
      try {
        const { data } = await API.get(`/demos/${demoId}`);
        if (cancelled) return;
        setDemoData(data);
        
        // 映射元数据：后端返回的是扁平结构，转为组件期待的 match_meta
        const matchMeta = {
          map_name: data.map_name,
          total_rounds: data.total_rounds,
          team_a_score: data.team_a_score,
          team_b_score: data.team_b_score,
          team_a_name: data.team_a_name,
          team_b_name: data.team_b_name,
          duration_mins: data.duration_mins,
          match_date: data.match_date,
        };
        data.match_meta = matchMeta;

        // 如果已有解析结果，直接加载并跳转到片段标签页
        let playersOut = null;
        if (data.result) {
          if (data.result.players) {
            playersOut = data.result.players;
          } else if (data.result.clips && data.result.auto_target_player) {
            // 兼容旧版扁平结构：将其转为按玩家索引的结构
            playersOut = {
              [data.result.auto_target_player]: {
                clips: data.result.clips,
                match_meta: data.result.match_meta || matchMeta,
                timeline: data.result.timeline || null,
                round_timeline: data.result.round_timeline || null,
              }
            };
          }
        }

        if (playersOut) {
          Object.values(playersOut).forEach(pd => {
            if (pd && Array.isArray(pd.clips)) {
              pd.clips = ensureClientClipUidsOnClips(pd.clips);
            }
          });
          setParsedPlayers(playersOut);
          const pnames = Object.keys(playersOut);
          if (pnames.length > 0) {
            const firstPlayer = pnames[0];
            setActivePlayerTab(firstPlayer);
            setTab("clips");

            // 初始化回合合集（211）选择
            const firstClips = playersOut[firstPlayer]?.clips || [];
            const ftd = firstClips.find(c => c.category === "compilation" && c.compilation_kind === "freeze_to_death");
            if (ftd) {
              const tr = matchMeta.total_rounds || 24;
              const maxR = Math.max(1, Math.min(64, Number(tr) || 24));
              setFreezeToDeathDraft(freezeToDeathDraftFromClipFilter(ftd.freeze_to_death_round_filter, maxR));
            }
          }
        }

        // 自动勾选关注名单中的玩家
        const roster = data.players || [];
        const names = roster.map((p) => (typeof p === "string" ? p : p.name)).filter(Boolean);
        const autoSelected = expectedPlayers
          .map((ep) => names.find((n) => n.toLowerCase() === ep.toLowerCase() || n.toLowerCase().includes(ep.toLowerCase())))
          .filter(Boolean);
        setSelectedPlayers(autoSelected);
      } catch (e) {
        setProgressText(t("dialog.demoInfoLoadFail", { msg: e.response?.data?.detail || e.message }));
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => { cancelled = true; };
  }, [open, demoId, expectedPlayers]);

  const handleParse = useCallback(async () => {
    if (!demoId || !selectedPlayers.length) return;
    setParsing(true);
    setProgressSuccess(false);
    setProgressText(t("dialog.demoInfoParsingHighlights"));
      try {
        const ftdPicked = [...(freezeToDeathDraft?.picked ?? [])].sort((a, b) => a - b);
        const { data } = await API.post(`/demos/${demoId}/analyze`, {
          target_players: selectedPlayers,
          freeze_to_death_rounds: ftdPicked.length ? ftdPicked : null,
          locale: useLocaleStore.getState().locale,
        });
      const playersOut = data.players || {};
      
      // 处理 UIDs
      Object.values(playersOut).forEach(pd => {
        if (pd && Array.isArray(pd.clips)) {
          pd.clips = ensureClientClipUidsOnClips(pd.clips);
        }
      });

      setParsedPlayers(playersOut);
      
      // 同步更新本地 Demo 数据和元数据，确保 UI 刷新且后续操作使用最新缓存
      setDemoData(prev => {
        if (!prev) return null;
        const firstPlayer = selectedPlayers[0];
        const newMeta = playersOut[firstPlayer]?.match_meta || prev.match_meta;
        return {
          ...prev,
          match_meta: newMeta,
          result: {
            ...(prev.result || {}),
            players: playersOut,
            auto_target_player: firstPlayer
          }
        };
      });

      const firstPlayer = selectedPlayers[0];
      setActivePlayerTab(firstPlayer);
      setTab("clips");
      setProgressText("");

      const metaRounds =
        playersOut[firstPlayer]?.match_meta?.total_rounds ?? demoData?.match_meta?.total_rounds ?? 24;
      const maxR = Math.max(1, Math.min(64, Number(metaRounds) || 24));
      let ftdClip = null;
      for (const pname of selectedPlayers) {
        const pcs = playersOut[pname]?.clips || [];
        const hit = pcs.find(
          (c) => c.category === "compilation" && c.compilation_kind === "freeze_to_death"
        );
        if (hit) {
          ftdClip = hit;
          break;
        }
      }
      setFreezeToDeathDraft(
        ftdClip ? freezeToDeathDraftFromClipFilter(ftdClip.freeze_to_death_round_filter, maxR) : { picked: [] }
      );
    } catch (e) {
      setProgressText(t("dialog.demoInfoParseFail", { msg: e.response?.data?.detail || e.message }));
    } finally {
      setParsing(false);
    }
  }, [demoId, selectedPlayers, freezeToDeathDraft]);

  const handleToggleClip = useCallback((uid) => {
    if (!uid || queuedClientClipUids.has(uid)) return;
    setSelectedClipUids((prev) => {
      const next = new Set(prev);
      if (next.has(uid)) next.delete(uid);
      else next.add(uid);
      return next;
    });
  }, [queuedClientClipUids]);

  const handleAddSelected = useCallback(() => {
    if (selectedClipUids.size === 0) return;

    const ftdPicksSorted = [...(freezeToDeathDraft?.picked ?? [])].sort((a, b) => a - b);

    const allClips = [];
    for (const pname of Object.keys(parsedPlayers)) {
      const pd = parsedPlayers[pname];
      const mm = pd.match_meta ?? null;
      const steamId = mm?.target_steam_id != null && mm.target_steam_id !== ""
        ? String(mm.target_steam_id) : null;
      for (const c of pd.clips || []) {
        if (!c.client_clip_uid || !selectedClipUids.has(c.client_clip_uid)) continue;
        const base = {
          demoPath: demoData?.path || "",
          demoFilename: demoData?.filename || "",
          targetPlayer: mm?.target_player || pname,
          targetPlayerUserId: mm?.target_player_user_id ?? null,
          targetSteamId: steamId,
          clipId: c.clip_id,
          clientClipUid: c.client_clip_uid,
          clipData: { ...c },
          // 将 match_meta 随入队项一起携带，确保录制时 all_players 可用（尤其是从库页加入时）
          matchMeta: mm,
        };
        if (isFreezeToDeathCompilation(c)) {
          const sliced = sliceFreezeToDeathClipForEnqueue(c, ftdPicksSorted);
          if (!sliced.ok) {
            setProgressText(t(sliced.errorKey));
            return;
          }
          allClips.push({
            ...base,
            clientClipUid: sliced.clip.client_clip_uid,
            clipData: sliced.clip,
            freezeToDeathQueueRounds: [...ftdPicksSorted],
          });
        } else {
          allClips.push(base);
        }
      }
    }

    if (!allClips.length) return;

    onAddToQueue(allClips);
    setSelectedClipUids(new Set());
    onEnqueueNotice?.(t("app.enqueueAdded", { n: allClips.length }), {
      autoDismissMs: 2000,
      queueLink: true,
    });
  }, [parsedPlayers, selectedClipUids, demoData, onAddToQueue, onEnqueueNotice, freezeToDeathDraft, t]);

  const canAddAllHighlights = useMemo(
    () =>
      Object.values(parsedPlayers).some((pd) =>
        (pd.clips || []).some(
          (c) =>
            c.category === "highlight" &&
            c.client_clip_uid &&
            !queuedClientClipUids.has(c.client_clip_uid)
        )
      ),
    [parsedPlayers, queuedClientClipUids]
  );

  const handleAddAllHighlights = useCallback(() => {
    const toAdd = [];
    for (const pname of Object.keys(parsedPlayers)) {
      const pd = parsedPlayers[pname];
      const mm = pd.match_meta ?? null;
      const steamId =
        mm?.target_steam_id != null && mm.target_steam_id !== ""
          ? String(mm.target_steam_id)
          : null;
      for (const c of pd.clips || []) {
        if (c.category !== "highlight") continue;
        if (!c.client_clip_uid || queuedClientClipUids.has(c.client_clip_uid)) continue;
        toAdd.push({
          demoPath: demoData?.path || "",
          demoFilename: demoData?.filename || "",
          targetPlayer: mm?.target_player || pname,
          targetPlayerUserId: mm?.target_player_user_id ?? null,
          targetSteamId: steamId,
          clipId: c.clip_id,
          clientClipUid: c.client_clip_uid,
          clipData: { ...c },
          matchMeta: mm,
        });
      }
    }
    if (!toAdd.length) {
      onEnqueueNotice?.(t("app.enqueueAllHighlightsEmpty"));
      return;
    }
    onAddToQueue(toAdd);
    onEnqueueNotice?.(t("app.enqueueAllHighlightsDone", { n: toAdd.length }), {
      autoDismissMs: 2000,
      queueLink: true,
    });
  }, [parsedPlayers, demoData, queuedClientClipUids, onAddToQueue, onEnqueueNotice, t]);

  const handleSelectAll = useCallback(() => {
    setSelectedClipUids((prev) => {
      const next = new Set(prev);
      Object.values(parsedPlayers).forEach(pd => {
        (pd.clips || []).forEach(c => {
          if (c.client_clip_uid && !queuedClientClipUids.has(c.client_clip_uid) && c.category !== "meme_death") {
            next.add(c.client_clip_uid);
          }
        });
      });
      return next;
    });
  }, [parsedPlayers, queuedClientClipUids]);

  const handleDeselectAll = useCallback(() => {
    setSelectedClipUids(new Set());
  }, []);

  const queueMetaForActivePlayer = useCallback(() => {
    const pd = parsedPlayers[activePlayerTab] || {};
    const mm = pd.match_meta || demoData?.match_meta || {};
    return {
      demoPath: demoData?.path || "",
      demoFilename: demoData?.filename || "",
      targetPlayer: mm.target_player || activePlayerTab,
      targetPlayerUserId: mm.target_player_user_id ?? null,
      targetSteamId: mm.target_steam_id != null && mm.target_steam_id !== "" ? String(mm.target_steam_id) : null,
      matchMeta: mm,
    };
  }, [activePlayerTab, demoData, parsedPlayers]);

  const enqueueTimelineClip = useCallback((clipData, successKey) => {
    if (!clipData?.client_clip_uid || queuedClientClipUids.has(clipData.client_clip_uid)) {
      onEnqueueNotice?.(t("app.enqueueTimelineAlreadyIn"), { autoDismissMs: 2000 });
      return;
    }
    const meta = queueMetaForActivePlayer();
    onAddToQueue([{
      ...meta,
      clipId: clipData.clip_id,
      clientClipUid: clipData.client_clip_uid,
      clipData,
    }]);
    onEnqueueNotice?.(t(successKey), { autoDismissMs: 2000, queueLink: true });
  }, [onAddToQueue, onEnqueueNotice, queueMetaForActivePlayer, queuedClientClipUids, t]);

  const handleAddTimelineEvent = useCallback((event, roundRow) => {
    const meta = queueMetaForActivePlayer();
    const clipData = buildTimelineEventClipData({
      event,
      mapName: meta.matchMeta?.map_name || "",
      targetPlayer: meta.targetPlayer,
      round: roundRow?.round_number ?? roundRow?.round ?? event?.round,
      t,
      locale: useLocaleStore.getState().locale,
    });
    enqueueTimelineClip(clipData, "app.enqueueTimelineDone");
  }, [enqueueTimelineClip, queueMetaForActivePlayer, t]);

  const handleAddTimelineRound = useCallback((roundRow) => {
    const meta = queueMetaForActivePlayer();
    const clipData = buildTimelineRoundClipData({
      roundRow,
      mapName: meta.matchMeta?.map_name || "",
      targetPlayer: meta.targetPlayer,
      demoFilename: meta.demoFilename,
      t,
    });
    enqueueTimelineClip(clipData, "app.enqueueRoundDone");
  }, [enqueueTimelineClip, queueMetaForActivePlayer, t]);

  const handleAddTimelineEventsBatch = useCallback((events) => {
    const meta = queueMetaForActivePlayer();
    const rows = (Array.isArray(events) ? events : []).map((event) => {
      const clipData = buildTimelineEventClipData({
        event,
        mapName: meta.matchMeta?.map_name || "",
        targetPlayer: meta.targetPlayer,
        round: event?.round,
        t,
        locale: useLocaleStore.getState().locale,
      });
      return { ...meta, clipId: clipData.clip_id, clientClipUid: clipData.client_clip_uid, clipData };
    }).filter((row) => row.clientClipUid && !queuedClientClipUids.has(row.clientClipUid));
    if (!rows.length) {
      onEnqueueNotice?.(t("app.enqueueTimelineBatchAllIn"), { autoDismissMs: 2000 });
      return;
    }
    onAddToQueue(rows);
    onEnqueueNotice?.(t("app.enqueueTimelineBatchDone", { n: rows.length }), { autoDismissMs: 2000, queueLink: true });
  }, [onAddToQueue, onEnqueueNotice, queueMetaForActivePlayer, queuedClientClipUids, t]);

  const handleAddWeaponKills = useCallback((clipData) => {
    enqueueTimelineClip(clipData, "app.enqueueWeaponKillsDone");
  }, [enqueueTimelineClip]);

  const activePlayerData = parsedPlayers[activePlayerTab] || null;
  const clips = activePlayerData?.clips || [];
  const roundTimeline = activePlayerData?.round_timeline || [];
  const weaponKillSummary = summarizeWeaponKills(roundTimeline);
  const matchMeta = demoData?.match_meta || {};
  const parsedPlayerNames = useMemo(() => Object.keys(parsedPlayers), [parsedPlayers]);
  
  const selectableTotal = useMemo(() => {
    let total = 0;
    Object.values(parsedPlayers).forEach(pd => {
      total += (pd.clips || []).filter(c => c.client_clip_uid && !queuedClientClipUids.has(c.client_clip_uid) && c.category !== "meme_death").length;
    });
    return total;
  }, [parsedPlayers, queuedClientClipUids]);

  if (!open || !demoId) return null;

  return (
    <div
      className="fixed inset-0 z-[90] flex items-center justify-center bg-cs2-bg-overlay px-4 py-6 backdrop-blur-sm"
      role="dialog"
      aria-modal="true"
      onClick={(e) => { if (e.target === e.currentTarget) onClose(); }}
    >
      <div className="flex h-full max-h-[85vh] w-full max-w-6xl flex-col overflow-hidden rounded-xl border border-cs2-border bg-cs2-bg-card shadow-lg">
        {/* Header */}
        <div className="flex items-center justify-between border-b border-cs2-border px-6 py-4">
          <div className="min-w-0 flex-1">
            <div className="flex items-center gap-2 text-xs font-medium text-cs2-text-muted mb-1">
              <span className="truncate max-w-[200px]">{demoData?.filename || t("dialog.demoInfoDemoFallback")}</span>
              {matchMeta.map_name && <span>• {matchMeta.map_name}</span>}
            </div>
            <h2 className="text-lg font-black text-cs2-text-primary uppercase tracking-tight truncate">
              {matchMeta.team_a_name || "Team A"} <span className="text-cs2-accent mx-1">vs</span> {matchMeta.team_b_name || "Team B"}
            </h2>
          </div>
          
          <div className="flex items-center gap-6 ml-4">
            {matchMeta.team_a_score != null && (
              <div className="flex items-center gap-3 bg-cs2-bg-input/50 rounded-lg px-4 py-2 border border-cs2-border">
                <span className="text-2xl font-black text-cs2-accent tabular-nums">{matchMeta.team_a_score}</span>
                <div className="h-4 w-[1px] bg-cs2-border" />
                <span className="text-2xl font-black text-cs2-accent tabular-nums">{matchMeta.team_b_score}</span>
              </div>
            )}
            <button onClick={onClose} className="rounded-full p-2 text-cs2-text-muted hover:bg-cs2-bg-input/50 hover:text-cs2-text-primary transition-colors">
              <X className="h-5 w-5" />
            </button>
          </div>
        </div>

        {/* Content area */}
        <div className="flex-1 overflow-y-auto bg-cs2-bg-page/30 custom-scrollbar">
          {loading ? (
            <div className="flex h-full flex-col items-center justify-center gap-4 py-20">
              <Loader2 className="h-10 w-10 animate-spin text-cs2-accent" />
              <p className="text-sm font-medium text-cs2-text-secondary">{t("dialog.demoInfoLoadingPlayers")}</p>
            </div>
          ) : (
            <div className="p-6 space-y-6">
              {/* Scoreboard and Player selection */}
              <div className="grid grid-cols-1 gap-6">
                {matchMeta.map_name && <MatchScoreboard matchMeta={matchMeta} />}
                
                <div className="flex items-center gap-2 border-b border-cs2-border pb-2">
                   <button
                     onClick={() => setTab("parse")}
                     className={`text-sm font-bold uppercase tracking-wider px-4 py-2 rounded-t-lg transition-all ${tab === "parse" ? "bg-cs2-accent text-cs2-text-on-accent" : "text-cs2-text-muted hover:text-cs2-text-secondary"}`}
                   >
                     {t("dialog.demoInfoTabParse")}
                   </button>
                   <button
                     onClick={() => setTab("clips")}
                     disabled={!parsedPlayerNames.length}
                     className={`text-sm font-bold uppercase tracking-wider px-4 py-2 rounded-t-lg transition-all disabled:opacity-30 ${tab === "clips" ? "bg-cs2-accent text-cs2-text-on-accent" : "text-cs2-text-muted hover:text-cs2-text-secondary"}`}
                   >
                     {parsedPlayerNames.length > 0 ? t("dialog.demoInfoTabClipsCount", { n: selectableTotal }) : t("dialog.demoInfoTabClips")}
                   </button>
                   <button
                     onClick={() => setTab("timeline")}
                     disabled={!parsedPlayerNames.length}
                     className={`text-sm font-bold uppercase tracking-wider px-4 py-2 rounded-t-lg transition-all disabled:opacity-30 ${tab === "timeline" ? "bg-cs2-accent text-cs2-text-on-accent" : "text-cs2-text-muted hover:text-cs2-text-secondary"}`}
                   >
                     {t("dialog.demoInfoTabTimeline")}
                   </button>
                   <button
                     onClick={() => setTab("weapon_kills")}
                     disabled={!parsedPlayerNames.length || weaponKillSummary.killCount === 0}
                     className={`text-sm font-bold uppercase tracking-wider px-4 py-2 rounded-t-lg transition-all disabled:opacity-30 ${tab === "weapon_kills" ? "bg-cs2-accent text-cs2-text-on-accent" : "text-cs2-text-muted hover:text-cs2-text-secondary"}`}
                   >
                     {t("dialog.demoInfoTabWeaponKills")}
                   </button>
                </div>

                {tab === "parse" ? (
                  <div className="animate-in fade-in slide-in-from-bottom-2 duration-300">
                    <PlayerSelect
                      players={demoData?.players || []}
                      selected={selectedPlayers}
                      onSelect={(name) =>
                        setSelectedPlayers((prev) =>
                          prev.includes(name) ? prev.filter((n) => n !== name) : [...prev, name]
                        )
                      }
                      onAnalyze={handleParse}
                      disabled={parsing}
                      parsed={parsedPlayerNames}
                    />
                  </div>
                ) : (
                  <div className="space-y-4 animate-in fade-in slide-in-from-bottom-2 duration-300">
                    <div className="flex flex-wrap items-center gap-2 rounded-lg border border-cs2-border bg-cs2-bg-card p-2">
                      <span className="flex items-center gap-1.5 px-2 text-[11px] font-semibold uppercase tracking-wide text-cs2-text-muted">
                        <User className="h-3.5 w-3.5" />
                        {t("dialog.demoInfoCurrentPlayer")}
                      </span>
                      {parsedPlayerNames.map((name) => (
                        <button
                          key={name}
                          type="button"
                          onClick={() => setActivePlayerTab(name)}
                          className={`rounded-md px-3 py-1.5 text-[12px] font-semibold transition-colors ${name === activePlayerTab ? "bg-cs2-accent text-cs2-text-on-accent" : "bg-cs2-bg-hover text-cs2-text-secondary hover:text-cs2-text-primary"}`}
                        >
                          {name}
                        </button>
                      ))}
                    </div>
                    {tab === "clips" ? (
                      <ClipList
                        clips={clips}
                        targetPlayer={activePlayerTab}
                        selectedIds={selectedClipUids}
                        onToggle={handleToggleClip}
                        aiMode={aiMode}
                        queuedClientClipUids={queuedClientClipUids}
                        playerTabs={[]}
                        activePlayerTab={activePlayerTab}
                        onPlayerTabChange={setActivePlayerTab}
                        parsedPlayers={parsedPlayers}
                        matchTotalRounds={matchMeta.total_rounds || 24}
                        freezeToDeathDraft={freezeToDeathDraft}
                        onFreezeToDeathDraftChange={setFreezeToDeathDraft}
                        roundMontagePickerDisabled={parsing}
                      />
                    ) : tab === "weapon_kills" ? (
                      <WeaponKillsView
                        roundTimeline={roundTimeline}
                        focusedPlayer={activePlayerTab}
                        demoFilename={demoData?.filename || ""}
                        mapName={activePlayerData?.match_meta?.map_name || matchMeta.map_name || ""}
                        queuedClientClipUids={queuedClientClipUids}
                        onAdd={handleAddWeaponKills}
                        onRemove={onDequeue}
                        onAddEvent={handleAddTimelineEvent}
                        onRemoveEvent={onDequeue ? (event, roundRow) => {
                          const meta = queueMetaForActivePlayer();
                          const cd = buildTimelineEventClipData({ event, mapName: meta.matchMeta?.map_name || "", targetPlayer: meta.targetPlayer, round: roundRow?.round_number ?? roundRow?.round, t, locale: useLocaleStore.getState().locale });
                          onDequeue(cd.client_clip_uid);
                        } : undefined}
                      />
                    ) : (
                      <RoundTimelineView
                        roundTimeline={roundTimeline}
                        focusedPlayer={activePlayerTab}
                        demoFilename={demoData?.filename || ""}
                        mapName={activePlayerData?.match_meta?.map_name || matchMeta.map_name || ""}
                        queuedClientClipUids={queuedClientClipUids}
                        onAddEvent={handleAddTimelineEvent}
                        onAddRound={handleAddTimelineRound}
                        onAddEventsBatch={handleAddTimelineEventsBatch}
                        onRemoveEvent={onDequeue ? (event, roundRow) => {
                          const meta = queueMetaForActivePlayer();
                          const cd = buildTimelineEventClipData({ event, mapName: meta.matchMeta?.map_name || "", targetPlayer: meta.targetPlayer, round: roundRow?.round_number ?? roundRow?.round, t, locale: useLocaleStore.getState().locale });
                          onDequeue(cd.client_clip_uid);
                        } : undefined}
                        onRemoveRound={onDequeue ? (roundRow) => {
                          const meta = queueMetaForActivePlayer();
                          const cd = buildTimelineRoundClipData({ roundRow, mapName: meta.matchMeta?.map_name || "", targetPlayer: meta.targetPlayer, demoFilename: meta.demoFilename, t });
                          onDequeue(cd.client_clip_uid);
                        } : undefined}
                      />
                    )}
                  </div>
                )}
              </div>
            </div>
          )}
        </div>

        {/* Footer actions */}
        <div className="border-t border-cs2-border bg-cs2-bg-card p-4">
          <div className="flex flex-col gap-3">
             {tab === "clips" && parsedPlayerNames.length > 0 && (
               <ActionBar
                  selectedCount={selectedClipUids.size}
                  totalCount={selectableTotal}
                  hasSelection={selectedClipUids.size > 0}
                  onSelectAll={handleSelectAll}
                  onDeselectAll={handleDeselectAll}
                  onAddSelectedToQueue={handleAddSelected}
                  onAddAllHighlightsAllMatches={handleAddAllHighlights}
                  queueLength={queueLength}
                  batchRecording={false}
                  canAddAllHighlights={canAddAllHighlights}
               />
             )}
             
             {progressText && (
               <div className={`flex items-center gap-2 rounded-lg bg-cs2-bg-input/70 px-4 py-2 text-[12px] border ${
                 progressSuccess
                   ? "text-cs2-text-success border-cs2-emerald-surface"
                   : "text-cs2-accent border-cs2-accent/20 animate-pulse"
               }`}>
                 {progressSuccess ? (
                   <CheckCircle2 className="h-3.5 w-3.5" />
                 ) : (
                   <Loader2 className="h-3 w-3 animate-spin" />
                 )}
                 {progressText}
               </div>
             )}
          </div>
        </div>
      </div>
    </div>
  );
}
