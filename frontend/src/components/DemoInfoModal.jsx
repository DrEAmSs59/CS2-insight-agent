import React, { useState, useEffect, useCallback, useMemo } from "react";
import axios from "axios";
import {
  X,
  Loader2,
  CheckCircle2,
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

const API = axios.create({ baseURL: "/api" });

/**
 * @param {{
 *   open: boolean;
 *   onClose: () => void;
 *   demoId: number | null;
 *   onAddToQueue: (clipData: any[]) => void;
 *   expectedPlayers: string[];
 *   aiMode: boolean;
 *   queuedClientClipUids?: Set<string>;
 * }} props
 */
export default function DemoInfoModal({
  open,
  onClose,
  demoId,
  onAddToQueue,
  expectedPlayers = [],
  aiMode = false,
  queuedClientClipUids = new Set(),
}) {
  const [tab, setTab] = useState("parse"); // "parse" | "clips"
  const [loading, setLoading] = useState(false);
  const [parsing, setParsing] = useState(false);
  const [demoData, setDemoData] = useState(null);
  const [parsedPlayers, setParsedPlayers] = useState({});
  const [selectedPlayers, setSelectedPlayers] = useState([]);
  const [selectedClipUids, setSelectedClipUids] = useState(new Set());
  const [progressText, setProgressText] = useState("");
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
                match_meta: data.result.match_meta || matchMeta
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
        setProgressText(`加载 Demo 信息失败: ${e.response?.data?.detail || e.message}`);
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => { cancelled = true; };
  }, [open, demoId, expectedPlayers]);

  const handleParse = useCallback(async () => {
    if (!demoId || !selectedPlayers.length) return;
    setParsing(true);
    setProgressText("正在解析高光时刻…");
      try {
        const ftdPicked = [...(freezeToDeathDraft?.picked ?? [])].sort((a, b) => a - b);
        const { data } = await API.post(`/demos/${demoId}/analyze`, {
          target_players: selectedPlayers,
          freeze_to_death_rounds: ftdPicked.length ? ftdPicked : null,
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
      setProgressText(`解析失败: ${e.response?.data?.detail || e.message}`);
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
      for (const c of pd.clips || []) {
        if (!c.client_clip_uid || !selectedClipUids.has(c.client_clip_uid)) continue;
        const base = {
          demoPath: demoData?.path || "",
          demoFilename: demoData?.filename || "",
          targetPlayer: pname,
          clipId: c.clip_id,
          clientClipUid: c.client_clip_uid,
          clipData: { ...c },
        };
        if (isFreezeToDeathCompilation(c)) {
          const sliced = sliceFreezeToDeathClipForEnqueue(c, ftdPicksSorted);
          if (!sliced.ok) {
            setProgressText(sliced.error);
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
    setProgressText(`已将 ${allClips.length} 条片段加入录制队列`);
  }, [parsedPlayers, selectedClipUids, demoData, onAddToQueue, freezeToDeathDraft]);

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

  const activePlayerData = parsedPlayers[activePlayerTab] || null;
  const clips = activePlayerData?.clips || [];
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
      className="fixed inset-0 z-[90] flex items-center justify-center bg-black/70 px-4 py-6 backdrop-blur-md"
      role="dialog"
      aria-modal="true"
      onClick={(e) => { if (e.target === e.currentTarget) onClose(); }}
    >
      <div className="flex h-full max-h-[85vh] w-full max-w-6xl flex-col overflow-hidden rounded-2xl border border-white/10 bg-cs2-bg-card shadow-2xl">
        {/* Header */}
        <div className="flex items-center justify-between border-b border-white/10 px-6 py-4">
          <div className="min-w-0 flex-1">
            <div className="flex items-center gap-2 text-xs font-medium text-zinc-500 mb-1">
              <span className="truncate max-w-[200px]">{demoData?.filename || "Demo 解析"}</span>
              {matchMeta.map_name && <span>• {matchMeta.map_name}</span>}
            </div>
            <h2 className="text-lg font-black text-white uppercase tracking-tight truncate">
              {matchMeta.team_a_name || "Team A"} <span className="text-cs2-orange mx-1">vs</span> {matchMeta.team_b_name || "Team B"}
            </h2>
          </div>
          
          <div className="flex items-center gap-6 ml-4">
            {matchMeta.team_a_score != null && (
              <div className="flex items-center gap-3 bg-black/30 rounded-lg px-4 py-2 border border-white/5">
                <span className="text-2xl font-black text-cs2-orange tabular-nums">{matchMeta.team_a_score}</span>
                <div className="h-4 w-[1px] bg-white/10" />
                <span className="text-2xl font-black text-cs2-orange tabular-nums">{matchMeta.team_b_score}</span>
              </div>
            )}
            <button onClick={onClose} className="rounded-full p-2 text-zinc-500 hover:bg-white/10 hover:text-white transition-colors">
              <X className="h-5 w-5" />
            </button>
          </div>
        </div>

        {/* Content area */}
        <div className="flex-1 overflow-y-auto bg-cs2-bg-dark/30 custom-scrollbar">
          {loading ? (
            <div className="flex h-full flex-col items-center justify-center gap-4 py-20">
              <Loader2 className="h-10 w-10 animate-spin text-cs2-orange" />
              <p className="text-sm font-medium text-zinc-400">正在读取 Demo 玩家信息...</p>
            </div>
          ) : (
            <div className="p-6 space-y-6">
              {/* Scoreboard and Player selection */}
              <div className="grid grid-cols-1 gap-6">
                {matchMeta.map_name && <MatchScoreboard matchMeta={matchMeta} />}
                
                <div className="flex items-center gap-2 border-b border-white/5 pb-2">
                   <button 
                     onClick={() => setTab("parse")}
                     className={`text-sm font-bold uppercase tracking-wider px-4 py-2 rounded-t-lg transition-all ${tab === "parse" ? "bg-cs2-orange text-black" : "text-zinc-500 hover:text-zinc-300"}`}
                   >
                     1. 选择玩家解析
                   </button>
                   <button 
                     onClick={() => setTab("clips")}
                     disabled={!parsedPlayerNames.length}
                     className={`text-sm font-bold uppercase tracking-wider px-4 py-2 rounded-t-lg transition-all disabled:opacity-30 ${tab === "clips" ? "bg-cs2-orange text-black" : "text-zinc-500 hover:text-zinc-300"}`}
                   >
                     2. 检视高光片段 {parsedPlayerNames.length > 0 && `(${selectableTotal})`}
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
                  <div className="animate-in fade-in slide-in-from-bottom-2 duration-300">
                    <ClipList
                      clips={clips}
                      targetPlayer={activePlayerTab}
                      selectedIds={selectedClipUids}
                      onToggle={handleToggleClip}
                      aiMode={aiMode}
                      queuedClientClipUids={queuedClientClipUids}
                      playerTabs={parsedPlayerNames}
                      activePlayerTab={activePlayerTab}
                      onPlayerTabChange={setActivePlayerTab}
                      parsedPlayers={parsedPlayers}
                      matchTotalRounds={matchMeta.total_rounds || 24}
                      freezeToDeathDraft={freezeToDeathDraft}
                      onFreezeToDeathDraftChange={setFreezeToDeathDraft}
                      roundMontagePickerDisabled={parsing}
                    />
                  </div>
                )}
              </div>
            </div>
          )}
        </div>

        {/* Footer actions */}
        <div className="border-t border-white/10 bg-cs2-bg-card p-4">
          <div className="flex flex-col gap-3">
             {tab === "clips" && parsedPlayerNames.length > 0 && (
               <ActionBar
                  selectedCount={selectedClipUids.size}
                  totalCount={selectableTotal}
                  hasSelection={selectedClipUids.size > 0}
                  onSelectAll={handleSelectAll}
                  onDeselectAll={handleDeselectAll}
                  onAddSelectedToQueue={handleAddSelected}
                  onAddAllHighlightsAllMatches={() => {}} // Modal 暂不支持跨场次一键加入
                  queueLength={0} // 不在这里显示全局长度
                  batchRecording={false}
                  canAddAllHighlights={false}
                  hideGlobalActions={true}
               />
             )}
             
             {progressText && (
               <div className={`flex items-center gap-2 rounded-lg bg-black/40 px-4 py-2 text-[11px] border ${
                 progressText.includes("队列") || progressText.includes("完成") || progressText.includes("成功")
                   ? "text-emerald-400 border-emerald-500/20"
                   : "text-cs2-orange border-cs2-orange/20 animate-pulse"
               }`}>
                 {progressText.includes("队列") || progressText.includes("完成") || progressText.includes("成功") ? (
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
