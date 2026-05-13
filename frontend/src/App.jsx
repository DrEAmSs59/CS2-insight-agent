import { useState, useCallback, useMemo, useEffect, useRef } from "react";
import axios from "axios";
import { Routes, Route, Navigate, useNavigate, useLocation } from "react-router-dom";
import { AppShellProvider } from "./context/AppShellContext";
import SidebarNav from "./components/SidebarNav";
import RecordingBlockedDialog from "./components/RecordingBlockedDialog";
import RecordWarmupModal from "./components/RecordWarmupModal";
import ProgressBar from "./components/ProgressBar";
import LibraryLoadModeModal from "./components/LibraryLoadModeModal";
import GuidePage from "./pages/GuidePage";
import DemoLibraryPage from "./pages/DemoLibraryPage";
import AnalysisPage from "./pages/AnalysisPage";
import RecordingQueuePage from "./pages/RecordingQueuePage";
import MontageWorkbenchPage from "./pages/MontageWorkbenchPage";
import CommonParamsPage from "./pages/CommonParamsPage";
import ObsConfigCenterPage from "./pages/ObsConfigCenterPage";
import SettingsPage from "./pages/SettingsPage";
import PlayerGameConfigPage from "./pages/PlayerGameConfigPage";
import { useRecordingQueue } from "./stores/recordingQueueStore";
import { ensureClientClipUidsOnClips } from "./utils/clipClientUid";
import {
  freezeToDeathDraftFromClipFilter,
  isFreezeToDeathCompilation,
  sliceFreezeToDeathClipForEnqueue,
} from "./utils/freezeToDeathRoundFilter";
import { warmupApiPayloadToPersisted } from "./utils/warmupDefaults";
import { buildTimelineEventClipData, buildTimelineRoundClipData } from "./utils/timelineQueue";
import { queueItemClientUid, runWithConcurrency, buildBatchGroupsFromQueue } from "./utils/recordingBatch";
import { formatRecordingApiError } from "./utils/formatRecordingApiError";
import { Loader2 } from "lucide-react";

const API = axios.create({ baseURL: "/api" });

const DEFAULT_SPEC_PLAYER_VERIFY = Object.freeze({
  demo_timescale: 0.05,
  max_retries: 4,
  per_retry_timeout_sec: 0.6,
  settle_sec: 0.12,
});

export default function App() {
  const navigate = useNavigate();
  const location = useLocation();
  const [aiMode, setAiMode] = useState(false);
  const [obsConfig, setObsConfig] = useState({ host: "localhost", port: 4455, password: "" });
  /** 服务器是否已有 OBS 密码（GET /api/config 返回脱敏或本地刚保存成功） */
  const [obsHasSavedPassword, setObsHasSavedPassword] = useState(false);
  /** 用户是否正在编辑密码框（用于失焦时恢复“已保存”提示） */
  const [obsPasswordEditing, setObsPasswordEditing] = useState(false);
  const obsConfigRef = useRef(obsConfig);
  obsConfigRef.current = obsConfig;
  const obsConfigHydratedRef = useRef(false);
  /** GET /api/config 已注入录制队列全局节奏后再允许自动写回，避免覆盖用户在本页会话内的修改 */
  const pacingPersistReadyRef = useRef(false);
  const [llmConfig, setLlmConfig] = useState({
    model: "",
    api_key: "",
    base_url: "",
  });

  /** @type {[Array<{ filename: string, path: string, players: any[], match_meta: any }>|null, Function]} */
  const [uploadedDemos, setUploadedDemos] = useState(null);

  /**
   * 与 uploadedDemos 等长；未解析的槽位为 null。
   * 已解析槽位结构: { players: { [playerName]: { clips, match_meta } }, demo_path, demo_filename }
   */
  const [parsedMatches, setParsedMatches] = useState(null);
  const [currentMatchIndex, setCurrentMatchIndex] = useState(0);
  const currentMatchIndexRef = useRef(0);
  useEffect(() => {
    currentMatchIndexRef.current = currentMatchIndex;
  }, [currentMatchIndex]);

  /** 每场 Demo 独立的多选玩家列表（索引 -> string[]） */
  const [selectedPlayers, setSelectedPlayers] = useState({});
  /** 每场「回合合集」勾选：空 → 请求里发 null（整局合规非赛后）；非空 → 只解析所选回合 */
  const [freezeToDeathRoundsByMatch, setFreezeToDeathRoundsByMatch] = useState({});

  /** 当前 Demo 正在查看的玩家 Tab（索引 -> playerName） */
  const [activePlayerTabs, setActivePlayerTabs] = useState({});

  /** 与 clip.client_clip_uid 对应（非后端 clip_id） */
  const [selectedClientClipUids, setSelectedClientClipUids] = useState(new Set());

  const [parsing, setParsing] = useState(false);
  /** 按场次索引的后台解析（与上传时的全局 parsing 区分，便于切换场次） */
  const [parsingByIndex, setParsingByIndex] = useState({});
  /** 解析分析页内嵌：当前场次解析读条 / 完成或上传成功提示（不占顶部栏） */
  const [analysisInlineProgress, setAnalysisInlineProgress] = useState(null);
  const [progressText, setProgressTextInner] = useState("");
  /** 底部 ProgressBar 可选行为：自动消失、跳转队列按钮 */
  const [progressToastMeta, setProgressToastMeta] = useState(null);
  const setProgressText = useCallback((value, toastMeta) => {
    if (typeof value === "function") {
      setProgressTextInner(value);
      setProgressToastMeta(null);
    } else {
      setProgressTextInner(value);
      setProgressToastMeta(toastMeta !== undefined ? toastMeta ?? null : null);
    }
  }, []);

  useEffect(() => {
    setAnalysisInlineProgress(null);
  }, [currentMatchIndex]);
  const [batchRecording, setBatchRecording] = useState(false);
  const [recordingBlockedMessage, setRecordingBlockedMessage] = useState("");
  const [recordWarmupOpen, setRecordWarmupOpen] = useState(false);
  const [warmupIntent, setWarmupIntent] = useState(null);
  /** @type {null | { restore_required?: boolean; message?: string; cs2_running?: boolean; backup_dir?: string }} */
  const [configBackupStatus, setConfigBackupStatus] = useState(null);
  /** 来自 data/cs2-insight.config.json（或 CS2_INSIGHT_CONFIG），打开录制预热对话框时作为初始选项 */
  const [savedRecordWarmupDefaults, setSavedRecordWarmupDefaults] = useState(null);
  const [cs2ExtraLaunchArgs, setCs2ExtraLaunchArgs] = useState("");
  const [recordInjectConsoleLines, setRecordInjectConsoleLines] = useState("");
  const [queueDrawerOpen, setQueueDrawerOpen] = useState(false);
  const [montageDrawerOpen, setMontageDrawerOpen] = useState(false);
  const [commonParamsOpen, setCommonParamsOpen] = useState(false);
  const [experimentalPovEnabled, setExperimentalPovEnabled] = useState(false);
  const [specPlayerVerify, setSpecPlayerVerify] = useState(() => ({ ...DEFAULT_SPEC_PLAYER_VERIFY }));
  const [cs2Path, setCs2Path] = useState("");
  const [ffmpegPath, setFfmpegPath] = useState("");
  const [montageEncoder, setMontageEncoder] = useState("auto");
  const [cs2FpsMax, setCs2FpsMax] = useState(240);
  const [demoWatchPaths, setDemoWatchPaths] = useState([]);
  const [expectedParsePlayersText, setExpectedParsePlayersText] = useState("");
  const [demoLibraryItems, setDemoLibraryItems] = useState([]);
  const [libraryLoading, setLibraryLoading] = useState(false);
  /** 仅「扫描本地 demo 库」进行中；不在顶部 ProgressBar 展示，由按钮内 spinner 表示 */
  const [libraryScanning, setLibraryScanning] = useState(false);
  const [libraryLoadingOverlay, setLibraryLoadingOverlay] = useState(false);
  const [libraryLoadingText, setLibraryLoadingText] = useState("正在加载 Demo...");
  const [libraryPage, setLibraryPage] = useState(1);
  const libraryPageRef = useRef(1);
  const [libraryHasNextPage, setLibraryHasNextPage] = useState(false);
  const [libraryTotal, setLibraryTotal] = useState(null);
  const [selectedLibraryDemoIds, setSelectedLibraryDemoIds] = useState(new Set());
  const [libraryDemoIdsByIndex, setLibraryDemoIdsByIndex] = useState({});
  const [libraryRename, setLibraryRename] = useState(null);
  /** @type {{ id: number, label: string } | null} */
  const [libraryDeletePrompt, setLibraryDeletePrompt] = useState(null);
  const [librarySearchInput, setLibrarySearchInput] = useState("");
  const [librarySearchQ, setLibrarySearchQ] = useState("");
  const [libraryAdvFilters, setLibraryAdvFilters] = useState({
    mapName: "",
    status: "all",
    playerQuery: "",
    steamQuery: "",
    minKills: "",
    maxDeaths: "",
    minAssists: "",
    minKd: "",
    roundsMin: "",
    roundsMax: "",
    durationMin: "",
    durationMax: "",
    dateFrom: "",
    dateTo: "",
  });
  const [libraryJumpDraft, setLibraryJumpDraft] = useState("");
  /** Demo 库列表每页条数（与 GET /demos limit 一致） */
  const [libraryPageSize, setLibraryPageSize] = useState(10);
  const libraryPageSizeEffectSkipRef = useRef(false);
  const [libraryBatchModalOpen, setLibraryBatchModalOpen] = useState(false);
  const [llmKeySavedOnServer, setLlmKeySavedOnServer] = useState(false);
  const llmConfigRef = useRef(llmConfig);
  llmConfigRef.current = llmConfig;

  const queue           = useRecordingQueue((s) => s.queue);
  const addToQueue      = useRecordingQueue((s) => s.addToQueue);
  const removeFromQueue = useRecordingQueue((s) => s.removeFromQueue);
  const clearQueue      = useRecordingQueue((s) => s.clearQueue);
  const globalPacing    = useRecordingQueue((s) => s.globalPacing);

  const currentUpload = uploadedDemos?.[currentMatchIndex] ?? null;
  const currentParsed = parsedMatches?.[currentMatchIndex] ?? null;

  // ── 当前场次已解析的玩家列表 ──
  const parsedPlayerNames = useMemo(
    () => Object.keys(currentParsed?.players ?? {}),
    [currentParsed]
  );

  // ── 当前 Tab 内的活跃玩家（默认第一个） ──
  const currentActivePlayer =
    activePlayerTabs[currentMatchIndex] ??
    parsedPlayerNames[0] ??
    "";

  const activePlayerData = currentParsed?.players?.[currentActivePlayer] ?? null;
  const clips = activePlayerData?.clips ?? [];
  const timeline = activePlayerData?.timeline ?? null;
  const roundTimeline = activePlayerData?.round_timeline ?? null;
  const matchMeta = activePlayerData?.match_meta ?? currentUpload?.match_meta ?? null;

  const players = currentUpload?.players ?? [];
  const selectedPlayersList = selectedPlayers[currentMatchIndex] ?? [];
  const freezeToDeathDraft =
    freezeToDeathRoundsByMatch[currentMatchIndex] ?? { picked: [] };
  const setFreezeToDeathDraft = useCallback((next) => {
    setFreezeToDeathRoundsByMatch((prev) => ({
      ...prev,
      [currentMatchIndex]: { picked: [...(next?.picked ?? [])] },
    }));
  }, [currentMatchIndex]);

  const roundMontageMaxRounds = useMemo(
    () =>
      Math.max(
        1,
        Number(matchMeta?.total_rounds) ||
          Number(currentUpload?.match_meta?.total_rounds) ||
          24
      ),
    [matchMeta, currentUpload]
  );

  const expectedPreviewLines = useMemo(
    () =>
      expectedParsePlayersText
        .split(/\r?\n/)
        .map((s) => s.trim())
        .filter(Boolean),
    [expectedParsePlayersText]
  );

  const anyDemoParsing = useMemo(
    () => parsing || Object.values(parsingByIndex).some(Boolean),
    [parsing, parsingByIndex]
  );

  const currentDemoFilename = currentParsed?.demo_filename ?? currentUpload?.filename ?? "";
  const queuedClientClipUidsForCurrentDemo = useMemo(() => {
    if (!currentDemoFilename) return new Set();
    return new Set(
      queue
        .filter((q) => q.demoFilename === currentDemoFilename)
        .map((q) => queueItemClientUid(q))
    );
  }, [queue, currentDemoFilename]);

  const queuedClientClipUidsGlobal = useMemo(
    () => new Set(queue.map((q) => queueItemClientUid(q))),
    [queue]
  );

  // ── 确保 client_clip_uid 已注入 ──
  useEffect(() => {
    if (!parsedMatches?.length || !uploadedDemos?.length) return;
    const idx = currentMatchIndex;
    const pm = parsedMatches[idx];
    if (!pm?.players) return;
    const anyNeedsUid = Object.values(pm.players).some(
      (pd) => pd.clips?.length && !pd.clips.every((c) => c.client_clip_uid)
    );
    if (!anyNeedsUid) return;
    setParsedMatches((prev) => {
      if (!prev || prev.length !== uploadedDemos.length) return prev;
      const next = [...prev];
      const cur = next[idx];
      if (!cur?.players) return prev;
      const newPlayers = { ...cur.players };
      for (const [name, pd] of Object.entries(newPlayers)) {
        if (pd.clips?.length && !pd.clips.every((c) => c.client_clip_uid)) {
          newPlayers[name] = { ...pd, clips: ensureClientClipUidsOnClips(pd.clips) };
        }
      }
      next[idx] = { ...cur, players: newPlayers };
      return next;
    });
  }, [parsedMatches, currentMatchIndex, uploadedDemos]);

  useEffect(() => {
    setSelectedClientClipUids((prev) => {
      const next = new Set(prev);
      let changed = false;
      for (const uid of queuedClientClipUidsForCurrentDemo) {
        if (next.has(uid)) {
          next.delete(uid);
          changed = true;
        }
      }
      return changed ? next : prev;
    });
  }, [queuedClientClipUidsForCurrentDemo]);

  // 切换玩家 Tab 时清空选中状态
  useEffect(() => {
    setSelectedClientClipUids(new Set());
  }, [currentActivePlayer]);

  // 回合合集勾选被清空后，取消其卡片选中（避免看起来已选却不能入队）
  useEffect(() => {
    const ftd = clips.find((c) => isFreezeToDeathCompilation(c));
    const uid = ftd?.client_clip_uid;
    if (!uid) return;
    if ((freezeToDeathDraft?.picked?.length ?? 0) > 0) return;
    setSelectedClientClipUids((prev) => {
      if (!prev.has(uid)) return prev;
      const next = new Set(prev);
      next.delete(uid);
      return next;
    });
  }, [freezeToDeathDraft?.picked, clips]);

  const matchTabsData = useMemo(() => {
    const n = uploadedDemos?.length ?? 0;
    if (!n) return [];
    return uploadedDemos.map((u, i) => {
      const p = parsedMatches?.[i];
      const firstPlayerMeta = p?.players
        ? Object.values(p.players)[0]?.match_meta
        : null;
      return {
        filename: u.filename,
        demo_filename: p?.demo_filename ?? u.filename,
        match_meta: firstPlayerMeta ?? u.match_meta,
        parsed: p != null,
      };
    });
  }, [uploadedDemos, parsedMatches]);

  const libraryTotalPages =
    libraryTotal == null ? null : Math.max(1, Math.ceil(libraryTotal / libraryPageSize));

  const libraryAdvFiltersKey = useMemo(() => JSON.stringify(libraryAdvFilters), [libraryAdvFilters]);

  useEffect(() => {
    setLibraryPage(1);
  }, [libraryAdvFiltersKey]);

  const appendDemoLibraryFilterParams = useCallback((params) => {
    const f = libraryAdvFilters;
    if (f.mapName.trim()) params.map_name = f.mapName.trim();
    if (f.status && f.status !== "all") params.status = f.status;
    const pq = f.playerQuery.trim();
    if (!pq) return;
    params.player_query = pq;
    const num = (v) => {
      const s = String(v ?? "").trim();
      if (!s) return null;
      const n = parseInt(s, 10);
      return Number.isFinite(n) ? n : null;
    };
    const fl = (v) => {
      const s = String(v ?? "").trim();
      if (!s) return null;
      const n = parseFloat(s);
      return Number.isFinite(n) ? n : null;
    };
    const mk = num(f.minKills);
    if (mk != null) params.min_kills = mk;
    const xdth = num(f.maxDeaths);
    if (xdth != null) params.max_deaths = xdth;
    const ma = num(f.minAssists);
    if (ma != null) params.min_assists = ma;
    const mkd = fl(f.minKd);
    if (mkd != null) params.min_kd = mkd;
  }, [libraryAdvFilters]);

  const refreshDemoLibrary = useCallback(async (page = libraryPage, opts = {}) => {
    const { manageLoading = true, searchQ: searchQOverride } = opts;
    if (manageLoading) setLibraryLoading(true);
    try {
      const limit = libraryPageSize;
      const offset = (page - 1) * limit;
      const params = { limit, offset };
      const qEff = searchQOverride !== undefined ? searchQOverride : librarySearchQ;
      if (qEff) params.q = qEff;
      appendDemoLibraryFilterParams(params);
      const { data } = await API.get("/demos", { params });
      setDemoLibraryItems(data.items || []);
      const total = typeof data.total === "number" ? data.total : null;
      if (total != null) {
        setLibraryTotal(total);
        setLibraryHasNextPage(offset + (data.items || []).length < total);
      } else {
        setLibraryTotal(null);
        setLibraryHasNextPage((data.items || []).length === limit);
      }
    } catch {
      // ignore
    } finally {
      if (manageLoading) setLibraryLoading(false);
    }
  }, [libraryPage, librarySearchQ, libraryPageSize, appendDemoLibraryFilterParams]);

  const refreshDemoLibraryRef = useRef(refreshDemoLibrary);
  refreshDemoLibraryRef.current = refreshDemoLibrary;

  const handleLibrarySearchSubmit = useCallback(() => {
    const next = librarySearchInput.trim();
    setLibrarySearchQ(next);
    setLibraryPage(1);
    void refreshDemoLibrary(1, { manageLoading: true, searchQ: next });
  }, [librarySearchInput, refreshDemoLibrary]);

  useEffect(() => {
    if (!libraryPageSizeEffectSkipRef.current) {
      libraryPageSizeEffectSkipRef.current = true;
      return;
    }
    setLibraryPage(1);
    void refreshDemoLibraryRef.current(1, { manageLoading: false });
  }, [libraryPageSize]);

  useEffect(() => {
    libraryPageRef.current = libraryPage;
  }, [libraryPage]);

  useEffect(() => {
    let cancelled = false;
    let es = null;
    let debounce = null;
    const scheduleRefresh = () => {
      if (cancelled) return;
      window.clearTimeout(debounce);
      debounce = window.setTimeout(() => {
        void refreshDemoLibrary(libraryPageRef.current, { manageLoading: false });
      }, 600);
    };
    const connect = () => {
      if (cancelled) return;
      try {
        es = new EventSource("/api/demos/stream");
      } catch {
        return;
      }
      es.addEventListener("library", scheduleRefresh);
      es.onerror = () => {
        if (cancelled) return;
        try {
          es?.close();
        } catch {
          /* ignore */
        }
        es = null;
        if (!cancelled) window.setTimeout(connect, 4000);
      };
    };
    connect();
    return () => {
      cancelled = true;
      window.clearTimeout(debounce);
      try {
        es?.close();
      } catch {
        /* ignore */
      }
    };
  }, [refreshDemoLibrary]);

  const handleLibraryPageJump = useCallback(() => {
    const raw = libraryJumpDraft.trim();
    if (!raw) return;
    const n = parseInt(raw, 10);
    if (!Number.isFinite(n) || n < 1) {
      setProgressText("请输入有效页码（≥1 的整数）");
      return;
    }
    const maxPage = libraryTotalPages;
    let target = n;
    if (maxPage != null && n > maxPage) {
      target = maxPage;
      setProgressText(`页码超过总页数，已跳转到最后一页（第 ${maxPage} 页）`);
    }
    setLibraryJumpDraft("");
    setLibraryPage(target);
    void refreshDemoLibrary(target, { manageLoading: false });
  }, [libraryJumpDraft, libraryTotalPages, refreshDemoLibrary]);

  const handleScanDemos = useCallback(async () => {
    setLibraryScanning(true);
    try {
      const { data } = await API.post("/demos/scan");
      await refreshDemoLibrary(libraryPage, { manageLoading: false });
      const n = data?.discovered_count;
      if (typeof n === "number" && n > 0) {
        setProgressText(`扫描完成：当前有 ${n} 个待入库 Demo，可点击「待入库」批量入库。`);
      }
    } catch (e) {
      setProgressText(`扫描或列表刷新失败: ${e.response?.data?.detail || e.message}`);
    } finally {
      setLibraryScanning(false);
    }
  }, [refreshDemoLibrary, libraryPage]);

  const handleDeleteDemo = useCallback(
    async (id, rescan) => {
      try {
        await API.delete(`/demos/${id}`, { params: { rescan } });
        setLibraryDeletePrompt(null);
        await refreshDemoLibrary(libraryPage, { manageLoading: false });
      } catch (e) {
        setProgressText(`删除失败: ${e.response?.data?.detail || e.message}`);
      }
    },
    [refreshDemoLibrary, libraryPage]
  );

  const handleLibraryBatchDelete = useCallback(
    async (ids, rescan = "skip") => {
      const list = [...ids];
      if (!list.length) return;
      setProgressText(`正在批量删除（0 / ${list.length}）…`);
      let done = 0;
      for (const id of list) {
        try {
          await API.delete(`/demos/${id}`, { params: { rescan } });
          done += 1;
          setProgressText(`正在批量删除（${done} / ${list.length}）…`);
        } catch (e) {
          setProgressText(`批量删除失败: ${e.response?.data?.detail || e.message}`);
          await refreshDemoLibrary(libraryPage, { manageLoading: false });
          return;
        }
      }
      setSelectedLibraryDemoIds(new Set());
      setProgressText(`已删除 ${list.length} 条 Demo。`);
      await refreshDemoLibrary(libraryPage, { manageLoading: false });
    },
    [refreshDemoLibrary, libraryPage]
  );

  const handleSaveLibraryRename = useCallback(async () => {
    if (!libraryRename) return;
    try {
      await API.patch(`/demos/${libraryRename.id}`, { display_name: libraryRename.draft });
      setLibraryRename(null);
      await refreshDemoLibrary(libraryPage, { manageLoading: false });
    } catch (e) {
      setProgressText(`改名失败: ${e.response?.data?.detail || e.message}`);
    }
  }, [libraryRename, refreshDemoLibrary, libraryPage]);

  const handleLoadDemoFromLibrary = useCallback(async (items, opts = {}) => {
    const { resolvedByDemoId, skipLoadingOverlay = false } = opts;
    if (!skipLoadingOverlay) {
      setLibraryLoadingOverlay(true);
      setLibraryLoadingText("正在加载 Demo ...");
    }
    try {
      const list = Array.isArray(items) ? items : [items];
      const loaded = await Promise.all(
        list.map(async (item) => {
          const { data } = await API.get(`/demos/${item.id}/players`);
          const cachedResult = item?.result || null;
          const cachedMeta = cachedResult?.match_meta || null;
          const ordered =
            Array.isArray(cachedResult?.analyzed_target_players) && cachedResult.analyzed_target_players.length
              ? cachedResult.analyzed_target_players.filter((n) => typeof n === "string" && n.trim())
              : null;
          const autoPlayer =
            (ordered && ordered[0]) ||
            cachedResult?.auto_target_player ||
            cachedMeta?.target_player ||
            data.players?.[0]?.name ||
            "";
          const displayLabel =
            (item.display_name && String(item.display_name).trim()) || item.filename;
          return {
            id: item.id,
            filename: displayLabel,
            path: item.path,
            players: data.players || [],
            // 优先使用实时 summary，确保地图名等基础信息总是可见
            match_meta: data.match_meta || item?.result?.match_meta || null,
            cached_result: cachedResult,
            cached_auto_player: autoPlayer,
          };
        })
      );
      setUploadedDemos(loaded);
      setParsedMatches(
        loaded.map((d) => {
          const r = d.cached_result;
          if (!r) return null;
          const pObj = r.players;
          if (pObj && typeof pObj === "object" && !Array.isArray(pObj)) {
            const names = Object.keys(pObj).filter((n) => String(n).trim());
            if (!names.length) return null;
            const players = {};
            for (const name of names) {
              const pd = pObj[name];
              if (!pd || typeof pd !== "object") continue;
              players[name] = {
                clips: ensureClientClipUidsOnClips(pd.clips || []),
                match_meta: pd.match_meta || r.match_meta || d.match_meta || null,
                timeline: pd.timeline ?? null,
                round_timeline: pd.round_timeline ?? null,
              };
            }
            if (!Object.keys(players).length) return null;
            return {
              players,
              demo_path: d.path,
              demo_filename: d.filename,
            };
          }
          const ap = d.cached_auto_player;
          if (!ap || !Array.isArray(r.clips)) return null;
          return {
            players: {
              [ap]: {
                clips: ensureClientClipUidsOnClips(r.clips || []),
                match_meta: r.match_meta || d.match_meta || null,
                timeline: r.timeline ?? null,
                round_timeline: r.round_timeline ?? null,
              },
            },
            demo_path: d.path,
            demo_filename: d.filename,
          };
        }),
      );
      const idMap = {};
      const selectedMap = {};
      const tabMap = {};
      loaded.forEach((x, i) => {
        idMap[i] = x.id;
        if (resolvedByDemoId && Object.prototype.hasOwnProperty.call(resolvedByDemoId, x.id)) {
          const r = resolvedByDemoId[x.id] ?? [];
          selectedMap[i] = r;
          if (r.length) tabMap[i] = r[0];
        } else if (x.cached_result) {
          const r = x.cached_result;
          let names = [];
          if (Array.isArray(r.analyzed_target_players) && r.analyzed_target_players.length) {
            names = r.analyzed_target_players.filter((n) => typeof n === "string" && n.trim());
          } else if (r.players && typeof r.players === "object" && !Array.isArray(r.players)) {
            names = Object.keys(r.players).filter((n) => String(n).trim());
          }
          if (names.length) {
            selectedMap[i] = names;
            tabMap[i] = names[0];
          } else if (x.cached_auto_player) {
            selectedMap[i] = [x.cached_auto_player];
            tabMap[i] = x.cached_auto_player;
          }
        }
      });
      setLibraryDemoIdsByIndex(idMap);
      setCurrentMatchIndex(0);
      setSelectedPlayers(selectedMap);
      setActivePlayerTabs(tabMap);
      const ftdByIndex = {};
      loaded.forEach((x, i) => {
        const r = x.cached_result;
        if (!r) return;
        let clips = null;
        const pObj = r.players;
        if (pObj && typeof pObj === "object" && !Array.isArray(pObj)) {
          const keys = Object.keys(pObj).filter((k) => String(k).trim());
          const ref =
            typeof r.auto_target_player === "string" &&
            r.auto_target_player.trim() &&
            pObj[r.auto_target_player]
              ? r.auto_target_player
              : keys[0];
          clips = ref && pObj[ref] && Array.isArray(pObj[ref].clips) ? pObj[ref].clips : null;
        } else {
          clips = r.clips;
        }
        if (!Array.isArray(clips)) return;
        const ftd = clips.find(
          (c) => c.category === "compilation" && c.compilation_kind === "freeze_to_death"
        );
        if (ftd) {
          const tr =
            x.cached_result?.match_meta?.total_rounds ??
            x.match_meta?.total_rounds ??
            24;
          const maxR = Math.max(1, Math.min(64, Number(tr) || 24));
          ftdByIndex[i] = freezeToDeathDraftFromClipFilter(ftd.freeze_to_death_round_filter, maxR);
        }
      });
      setFreezeToDeathRoundsByMatch(ftdByIndex);
      setSelectedClientClipUids(new Set());
      setProgressText("");
      navigate("/analysis");
      return loaded;
    } catch (e) {
      setProgressText(`加载 Demo 库失败: ${e.response?.data?.detail || e.message}`);
      return null;
    } finally {
      if (!skipLoadingOverlay) {
        setLibraryLoadingOverlay(false);
        setLibraryLoadingText("正在加载 Demo...");
      }
    }
  }, [navigate]);

  const handleLoadSelectedLibraryDemos = useCallback(async () => {
    const ids = Array.from(selectedLibraryDemoIds);
    if (!ids.length) return;
    try {
      ids.sort((a, b) => Number(a) - Number(b));
      const items = await Promise.all(ids.map((id) => API.get(`/demos/${id}`).then((r) => r.data)));
      await handleLoadDemoFromLibrary(items);
    } catch (e) {
      setProgressText(`载入选中失败: ${e.response?.data?.detail || e.message}`);
    }
  }, [selectedLibraryDemoIds, handleLoadDemoFromLibrary]);

  const selectLibraryPage = useCallback(() => {
    setSelectedLibraryDemoIds((prev) => {
      const next = new Set(prev);
      for (const it of demoLibraryItems) {
        next.add(it.id);
      }
      return next;
    });
  }, [demoLibraryItems]);

  const selectAllLibraryDemos = useCallback(async () => {
    try {
      const cap = 1000;
      const want = libraryTotal != null ? Math.min(libraryTotal, cap) : cap;
      const params = { limit: want, offset: 0 };
      if (librarySearchQ) params.q = librarySearchQ;
      appendDemoLibraryFilterParams(params);
      const { data } = await API.get("/demos", { params });
      const rows = data.items || [];
      setSelectedLibraryDemoIds(new Set(rows.map((it) => it.id)));
      if (libraryTotal != null && libraryTotal > cap) {
        setProgressText(`已全选前 ${cap} 条（列表接口单次上限 ${cap}）；其余请分页勾选。`);
      }
    } catch (e) {
      setProgressText(`全选失败: ${e.response?.data?.detail || e.message}`);
    }
  }, [libraryTotal, librarySearchQ, appendDemoLibraryFilterParams]);

  const clearLibrarySelection = useCallback(() => {
    setSelectedLibraryDemoIds(new Set());
  }, []);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const { data } = await API.get("config");
        if (cancelled) return;
        if (data.obs) {
          const rawPw = data.obs.password ?? "";
          const masked = typeof rawPw === "string" && rawPw.startsWith("****");
          setObsHasSavedPassword(masked);
          setObsPasswordEditing(false);
          setObsConfig({
            ...data.obs,
            password: "",
          });
        }
        if (data.llm) {
          const rawKey = data.llm.api_key ?? "";
          const masked = typeof rawKey === "string" && rawKey.startsWith("****");
          setLlmKeySavedOnServer(masked);
          setLlmConfig({
            ...data.llm,
            api_key: masked ? "" : rawKey,
          });
        }
        if (typeof data.ai_mode === "boolean") setAiMode(data.ai_mode);
        if (typeof data.experimental?.pov_enabled === "boolean") {
          setExperimentalPovEnabled(data.experimental.pov_enabled);
        }
        if (data.spec_player_verify && typeof data.spec_player_verify === "object") {
          const spv = data.spec_player_verify;
          setSpecPlayerVerify((prev) => ({
            ...prev,
            ...(typeof spv.demo_timescale === "number" && Number.isFinite(spv.demo_timescale)
              ? { demo_timescale: spv.demo_timescale }
              : {}),
            ...(typeof spv.max_retries === "number" && Number.isFinite(spv.max_retries)
              ? { max_retries: Math.round(spv.max_retries) }
              : {}),
            ...(typeof spv.per_retry_timeout_sec === "number" &&
            Number.isFinite(spv.per_retry_timeout_sec)
              ? { per_retry_timeout_sec: spv.per_retry_timeout_sec }
              : {}),
            ...(typeof spv.settle_sec === "number" && Number.isFinite(spv.settle_sec)
              ? { settle_sec: spv.settle_sec }
              : {}),
          }));
        }
        if (data.cs2_path) setCs2Path(data.cs2_path);
        if (typeof data.ffmpeg_path === "string") setFfmpegPath(data.ffmpeg_path);
        if (typeof data.montage_encoder === "string" && data.montage_encoder.trim()) {
          setMontageEncoder(data.montage_encoder.trim().toLowerCase());
        }
        if (typeof data.cs2_fps_max === "number") setCs2FpsMax(data.cs2_fps_max);
        if (Array.isArray(data.demo_watch_paths)) setDemoWatchPaths(data.demo_watch_paths);
        if (Array.isArray(data.expected_parse_players)) {
          setExpectedParsePlayersText(data.expected_parse_players.join("\n"));
        }
        if (
          data.default_record_warmup &&
          typeof data.default_record_warmup === "object" &&
          !Array.isArray(data.default_record_warmup)
        ) {
          setSavedRecordWarmupDefaults(data.default_record_warmup);
        }
        if (typeof data.cs2_extra_launch_args === "string") {
          setCs2ExtraLaunchArgs(data.cs2_extra_launch_args);
        }
        if (typeof data.record_inject_console_lines === "string") {
          setRecordInjectConsoleLines(data.record_inject_console_lines);
        }
        if (
          data.recording_global_pacing &&
          typeof data.recording_global_pacing === "object" &&
          !Array.isArray(data.recording_global_pacing)
        ) {
          useRecordingQueue.getState().hydrateGlobalPacing(data.recording_global_pacing);
        }
        if (!cancelled) {
          obsConfigHydratedRef.current = true;
          queueMicrotask(() => {
            pacingPersistReadyRef.current = true;
          });
        }
      } catch {
        /* ignore */
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  const refreshConfigBackupStatus = useCallback(async () => {
    try {
      const { data } = await API.get("/config-backup/status");
      setConfigBackupStatus(data);
    } catch {
      setConfigBackupStatus(null);
    }
  }, []);

  useEffect(() => {
    void refreshConfigBackupStatus();
  }, [refreshConfigBackupStatus]);

  useEffect(() => {
    if (!pacingPersistReadyRef.current) return;
    const t = setTimeout(() => {
      void API.put("config", { recording_global_pacing: globalPacing }).catch(() => {});
    }, 600);
    return () => clearTimeout(t);
  }, [globalPacing]);

  useEffect(() => {
    if (!pacingPersistReadyRef.current) return;
    const t = setTimeout(() => {
      void API.put("config", { spec_player_verify: specPlayerVerify }).catch(() => {});
    }, 600);
    return () => clearTimeout(t);
  }, [specPlayerVerify]);

  useEffect(() => {
    // 切页拉一次；库变更另由 /api/demos/stream（SSE）防抖刷新。新增文件需点「扫描本地 demo 库」入库。
    void refreshDemoLibrary(libraryPage, { manageLoading: false });
  }, [refreshDemoLibrary, libraryPage]);

  const hasLibraryAdvancedFilters = useMemo(() => {
    const f = libraryAdvFilters;
    const numOrStr = (v) => String(v ?? "").trim();
    return !!(
      f.mapName.trim() ||
      (f.status && f.status !== "all") ||
      f.playerQuery.trim() ||
      f.steamQuery.trim() ||
      numOrStr(f.minKills) ||
      numOrStr(f.maxDeaths) ||
      numOrStr(f.minAssists) ||
      numOrStr(f.minKd) ||
      numOrStr(f.roundsMin) ||
      numOrStr(f.roundsMax) ||
      numOrStr(f.durationMin) ||
      numOrStr(f.durationMax) ||
      numOrStr(f.dateFrom) ||
      numOrStr(f.dateTo)
    );
  }, [libraryAdvFilters]);

  const handleUpload = useCallback(async (files) => {
    const list = Array.isArray(files) ? files : [files];
    if (!list.length) return;

    setProgressText("正在上传 Demo 文件...");
    setParsing(true);

    try {
      const formData = new FormData();
      list.forEach((f) => formData.append("files", f));
      const { data } = await API.post("/demo/upload-multiple", formData);
      const uploads = data.uploads ?? [];
      setUploadedDemos(uploads);
      setParsedMatches(uploads.map(() => null));
      setLibraryDemoIdsByIndex({});
      setCurrentMatchIndex(0);
      setSelectedPlayers({});
      setActivePlayerTabs({});
      setFreezeToDeathRoundsByMatch({});
      setSelectedClientClipUids(new Set());
      const uploadDoneMsg =
        uploads.length > 1
          ? `已上传 ${uploads.length} 个 Demo。请切换场次，分别为每场选择玩家并点击「开始分析」。`
          : "上传完成，请选择要分析的玩家后点击「开始分析」。";
      setProgressText("");
      setAnalysisInlineProgress({ active: false, text: uploadDoneMsg });
      navigate("/analysis");
    } catch (e) {
      setProgressText(`上传失败: ${e.response?.data?.detail || e.message}`);
    } finally {
      setParsing(false);
    }
  }, [navigate]);

  const roundMontageCanEnqueue = useMemo(() => {
    const p = freezeToDeathDraft?.picked ?? [];
    return p.length > 0;
  }, [freezeToDeathDraft]);

  const regularSelectableTotal = useMemo(
    () =>
      clips.filter((c) => {
        if (c.category === "meme_death" || !c.client_clip_uid) return false;
        if (queuedClientClipUidsForCurrentDemo.has(c.client_clip_uid)) return false;
        if (isFreezeToDeathCompilation(c) && !roundMontageCanEnqueue) return false;
        return true;
      }).length,
    [clips, queuedClientClipUidsForCurrentDemo, roundMontageCanEnqueue]
  );
  const selectedRegularCount = useMemo(
    () =>
      clips.filter((c) => {
        if (c.category === "meme_death" || !c.client_clip_uid) return false;
        if (!selectedClientClipUids.has(c.client_clip_uid)) return false;
        if (queuedClientClipUidsForCurrentDemo.has(c.client_clip_uid)) return false;
        if (isFreezeToDeathCompilation(c) && !roundMontageCanEnqueue) return false;
        return true;
      }).length,
    [
      clips,
      selectedClientClipUids,
      queuedClientClipUidsForCurrentDemo,
      roundMontageCanEnqueue,
    ]
  );

  const canAddAllHighlights = useMemo(
    () =>
      Boolean(
        parsedMatches?.some((pm) =>
          Object.values(pm?.players ?? {}).some((pd) =>
            pd.clips?.some((c) => c.category === "highlight")
          )
        )
      ),
    [parsedMatches]
  );

  /**
   * @param {number} idx
   * @param {string[] | null} [playerListOverride] 非 null 时忽略 selectedPlayers
   * @param {{ demos?: any[]; libraryDemoIdsByIndex?: Record<number, number>; suppressProgressText?: boolean } | null} [ctx] 库批量载入后立即解析时使用，避免尚未提交的 React 状态
   */
  const handleParseForIndex = useCallback(
    async (idx, playerListOverride = null, ctx = null) => {
      const demos = ctx?.demos ?? uploadedDemos;
      const libIds = ctx?.libraryDemoIdsByIndex ?? libraryDemoIdsByIndex;
      const quietProgress = Boolean(ctx?.suppressProgressText);
      if (!demos?.length) return;
      const names =
        playerListOverride != null ? playerListOverride : (selectedPlayers[idx] ?? []);
      if (!names.length) return;
      const fn = demos[idx]?.filename;
      if (!fn) return;

      setParsingByIndex((prev) => ({ ...prev, [idx]: true }));
      const viewingHere = currentMatchIndexRef.current === idx;
      if (viewingHere && !quietProgress) {
        setProgressText("");
        setAnalysisInlineProgress({ active: true, text: `正在解析「${fn}」…` });
        setSelectedClientClipUids(new Set());
      }

      try {
        const activeLibraryDemoId = libIds[idx] ?? demos[idx]?.id;
        const body = { target_players: names };
        const ftdCfg = freezeToDeathRoundsByMatch[idx] ?? { picked: [] };
        const ftdPicked = [...(ftdCfg.picked || [])].sort((a, b) => a - b);
        // null = 后端按全部合规非赛后回合生成回合合集；[] 会显式跳过生成（见 demo_parser）
        body.freeze_to_death_rounds = ftdPicked.length ? ftdPicked : null;
        const { data } = activeLibraryDemoId
          ? await API.post(`/demos/${activeLibraryDemoId}/analyze`, body)
          : await API.post(`/demo/parse-multi?filename=${encodeURIComponent(fn)}`, body);

        const processedPlayers = {};
        for (const [playerName, playerData] of Object.entries(data.players ?? {})) {
          processedPlayers[playerName] = {
            ...playerData,
            clips: ensureClientClipUidsOnClips(playerData.clips ?? []),
          };
        }

        setParsedMatches((prev) => {
          const base =
            prev && prev.length === demos.length ? [...prev] : demos.map(() => null);
          const cur = base[idx];
          const mergedPlayers = { ...(cur?.players || {}), ...processedPlayers };
          base[idx] = {
            players: mergedPlayers,
            demo_path: demos[idx].path,
            demo_filename: fn,
          };
          return base;
        });

        const firstMeta = Object.values(processedPlayers)[0]?.match_meta;
        const ftdMaxRounds = Math.max(
          1,
          Math.min(
            64,
            Number(firstMeta?.total_rounds) ||
              Number(demos[idx]?.match_meta?.total_rounds) ||
              24
          )
        );

        const refPlayer = names[0];
        const refClips = processedPlayers[refPlayer]?.clips ?? [];
        const ftdClip = refClips.find(
          (c) => c.category === "compilation" && c.compilation_kind === "freeze_to_death"
        );
        setFreezeToDeathRoundsByMatch((prev) => ({
          ...prev,
          [idx]: ftdClip
            ? freezeToDeathDraftFromClipFilter(
                ftdClip.freeze_to_death_round_filter,
                ftdMaxRounds
              )
            : { picked: [] },
        }));

        setActivePlayerTabs((prev) => ({ ...prev, [idx]: names[0] }));

        const rounds = firstMeta?.total_rounds ?? "?";
        const totalRegular = Object.values(processedPlayers).reduce(
          (s, pd) => s + (pd.clips ?? []).filter((c) => c.category !== "meme_death").length,
          0
        );
        const totalMeme = Object.values(processedPlayers).reduce(
          (s, pd) => s + (pd.clips ?? []).filter((c) => c.category === "meme_death").length,
          0
        );
        const playerLabel =
          names.length === 1 ? names[0] : `${names.length} 名玩家`;
        const doneMsg =
          totalMeme > 0
            ? `「${fn}」分析完成 — ${rounds} 回合，${playerLabel}，常规片段 ${totalRegular} 个，另含下饭 ${totalMeme} 段。`
            : `「${fn}」分析完成 — ${rounds} 回合，${playerLabel}，共 ${totalRegular} 个片段。`;
        if (!quietProgress) {
          if (viewingHere) setAnalysisInlineProgress({ active: false, text: doneMsg });
          else setProgressText((prev) => (prev ? `${prev}\n${doneMsg}` : doneMsg));
        }
      } catch (e) {
        const err = `解析失败「${fn}」: ${e.response?.data?.detail || e.message}`;
        if (!quietProgress) {
          if (viewingHere) setAnalysisInlineProgress({ active: false, text: err });
          else setProgressText((prev) => (prev ? `${prev}\n${err}` : err));
        }
      } finally {
        setParsingByIndex((prev) => {
          const next = { ...prev };
          delete next[idx];
          return next;
        });
      }
    },
    [uploadedDemos, selectedPlayers, libraryDemoIdsByIndex, freezeToDeathRoundsByMatch]
  );

  const handleParse = useCallback(async () => {
    await handleParseForIndex(currentMatchIndex, null, null);
  }, [currentMatchIndex, handleParseForIndex]);

  const LIBRARY_PARSE_CONCURRENCY = 2;

  const runLibraryBatchLoad = useCallback(
    async ({ mode, manualLines }) => {
      const ids = Array.from(selectedLibraryDemoIds);
      if (!ids.length) return;
      ids.sort((a, b) => Number(a) - Number(b));
      const holdOverlayUntilParsed = mode === "expected" || mode === "manual";
      if (holdOverlayUntilParsed) {
        setLibraryLoadingOverlay(true);
        setLibraryLoadingText("正在载入并解析所选 Demo…");
      }
      try {
        const items = await Promise.all(ids.map((id) => API.get(`/demos/${id}`).then((r) => r.data)));
        let resolvedByDemoId = null;
        if (mode !== "none") {
          if (holdOverlayUntilParsed) {
            setLibraryLoadingText("正在匹配玩家名单…");
          }
          const apiMode = mode === "expected" ? "config_expected" : "manual";
          const { data } = await API.post("/demos/batch-resolve-players", {
            demo_ids: ids.map((id) => Number(id)),
            mode: apiMode,
            manual_lines: mode === "manual" ? manualLines : null,
          });
          const raw = data.resolved || {};
          resolvedByDemoId = {};
          for (const it of items) {
            const key = String(it.id);
            resolvedByDemoId[it.id] = raw[key] ?? raw[it.id] ?? [];
          }
        }
        if (holdOverlayUntilParsed) {
          setLibraryLoadingText("正在加载 Demo 文件…");
        }
        const loaded = await handleLoadDemoFromLibrary(items, {
          resolvedByDemoId: mode === "none" ? undefined : resolvedByDemoId,
          skipLoadingOverlay: holdOverlayUntilParsed,
        });
        if (!loaded?.length) return;
        if (mode === "none") return;
        const idMap = {};
        loaded.forEach((x, i) => {
          idMap[i] = x.id;
        });
        const specs = loaded
          .map((row, index) => ({
            index,
            players: resolvedByDemoId[row.id] ?? [],
          }))
          .filter((s) => s.players.length > 0);
        if (!specs.length) {
          setProgressText((prev) =>
            `${prev || ""}\n未匹配到可解析玩家（请检查关注名单或手动昵称）。`.trim()
          );
          return;
        }
        if (holdOverlayUntilParsed) {
          setLibraryLoadingText(`正在解析高光（0 / ${specs.length} 场）…`);
        }
        const ctx = {
          demos: loaded,
          libraryDemoIdsByIndex: idMap,
          suppressProgressText: holdOverlayUntilParsed,
        };
        let done = 0;
        await runWithConcurrency(LIBRARY_PARSE_CONCURRENCY, specs, async (spec) => {
          await handleParseForIndex(spec.index, spec.players, ctx);
          if (holdOverlayUntilParsed) {
            done += 1;
            setLibraryLoadingText(`正在解析高光（${done} / ${specs.length} 场）…`);
          }
        });
        setProgressText("");
      } catch (e) {
        setProgressText(`载入并解析失败: ${e.response?.data?.detail || e.message}`);
      } finally {
        if (holdOverlayUntilParsed) {
          setLibraryLoadingOverlay(false);
          setLibraryLoadingText("正在加载 Demo...");
        }
      }
    },
    [selectedLibraryDemoIds, handleLoadDemoFromLibrary, handleParseForIndex]
  );

  const handleToggleClip = useCallback(
    (clientClipUid) => {
      if (!clientClipUid || queuedClientClipUidsForCurrentDemo.has(clientClipUid)) return;
      const clip = clips.find((c) => c.client_clip_uid === clientClipUid);
      if (clip && isFreezeToDeathCompilation(clip)) {
        const p = freezeToDeathDraft?.picked ?? [];
        if (!p.length) return;
      }
      setSelectedClientClipUids((prev) => {
        const next = new Set(prev);
        if (next.has(clientClipUid)) next.delete(clientClipUid);
        else next.add(clientClipUid);
        return next;
      });
    },
    [queuedClientClipUidsForCurrentDemo, clips, freezeToDeathDraft]
  );

  const handleSelectAll = useCallback(() => {
    setSelectedClientClipUids((prev) => {
      const next = new Set(prev);
      clips
        .filter((c) => {
          if (c.category === "meme_death" || !c.client_clip_uid) return false;
          if (queuedClientClipUidsForCurrentDemo.has(c.client_clip_uid)) return false;
          if (isFreezeToDeathCompilation(c) && !roundMontageCanEnqueue) return false;
          return true;
        })
        .forEach((c) => next.add(c.client_clip_uid));
      return next;
    });
  }, [clips, queuedClientClipUidsForCurrentDemo, roundMontageCanEnqueue]);

  const handleDeselectAll = useCallback(() => {
    setSelectedClientClipUids(new Set());
  }, []);

  const queueItemMetaForPlayer = useCallback(
    (index, playerName) => {
      const um = uploadedDemos?.[index];
      const pm = parsedMatches?.[index];
      const playerData = pm?.players?.[playerName];
      const meta = playerData?.match_meta ?? um?.match_meta ?? null;
      const demoFilename = pm?.demo_filename ?? um?.filename ?? "";
      const demoPath = pm?.demo_path ?? um?.path ?? "";
      const steam =
        meta?.target_steam_id != null && meta?.target_steam_id !== ""
          ? String(meta.target_steam_id)
          : null;
      return {
        demoFilename,
        demoPath,
        targetPlayer: meta?.target_player || playerName || null,
        targetPlayerUserId: meta?.target_player_user_id ?? null,
        targetSteamId: steam,
      };
    },
    [uploadedDemos, parsedMatches]
  );

  // 兼容旧版接口（单玩家，用当前活跃玩家）
  const queueItemMetaForIndex = useCallback(
    (index) => {
      const activePlayer =
        activePlayerTabs[index] ??
        Object.keys(parsedMatches?.[index]?.players ?? {})[0] ??
        selectedPlayers[index]?.[0] ??
        "";
      return queueItemMetaForPlayer(index, activePlayer);
    },
    [activePlayerTabs, parsedMatches, selectedPlayers, queueItemMetaForPlayer]
  );

  const handleAddSelectedToQueue = useCallback(() => {
    if (!currentParsed || selectedClientClipUids.size === 0) return;
    const meta = queueItemMetaForIndex(currentMatchIndex);
    const ftdPicksSorted = [...(freezeToDeathDraft?.picked ?? [])].sort((a, b) => a - b);
    const candidates = clips.filter(
      (c) => c.client_clip_uid && selectedClientClipUids.has(c.client_clip_uid)
    );
    const toAdd = [];
    for (const c of candidates) {
      const row = {
        demoPath: meta.demoPath,
        demoFilename: meta.demoFilename,
        targetPlayer: meta.targetPlayer,
        targetPlayerUserId: meta.targetPlayerUserId,
        targetSteamId: meta.targetSteamId,
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
        toAdd.push({
          ...row,
          clientClipUid: sliced.clip.client_clip_uid,
          clipData: sliced.clip,
          freezeToDeathQueueRounds: [...ftdPicksSorted],
        });
      } else {
        toAdd.push(row);
      }
    }
    if (!toAdd.length) {
      return;
    }
    addToQueue(toAdd);
    setSelectedClientClipUids(new Set());
    const skipped = candidates.length - toAdd.length;
    const skipHint =
      skipped > 0 ? `（已跳过 ${skipped} 条未满足条件的片段）` : "";
    setProgressText(`已加入录制队列 ${toAdd.length} 条（当前场次）${skipHint}`, {
      autoDismissMs: 2000,
      queueLink: true,
    });
  }, [
    currentParsed,
    clips,
    selectedClientClipUids,
    addToQueue,
    currentMatchIndex,
    queueItemMetaForIndex,
    freezeToDeathDraft,
  ]);

  const handleAddAllHighlightsAllMatches = useCallback(() => {
    if (!parsedMatches?.length) return;
    const toAdd = [];
    parsedMatches.forEach((pm, index) => {
      if (!pm?.players) return;
      Object.entries(pm.players).forEach(([playerName, playerData]) => {
        const meta = queueItemMetaForPlayer(index, playerName);
        for (const c of playerData.clips ?? []) {
          if (c.category !== "highlight") continue;
          if (!c.client_clip_uid || queuedClientClipUidsGlobal.has(c.client_clip_uid)) continue;
          toAdd.push({
            demoPath: meta.demoPath,
            demoFilename: meta.demoFilename,
            targetPlayer: meta.targetPlayer,
            targetPlayerUserId: meta.targetPlayerUserId,
            targetSteamId: meta.targetSteamId,
            clipId: c.clip_id,
            clientClipUid: c.client_clip_uid,
            clipData: c,
          });
        }
      });
    });
    if (!toAdd.length) {
      setProgressText("没有可加入的高光（可能已全部在队列中）。");
      return;
    }
    addToQueue(toAdd);
    setProgressText(`已将 ${toAdd.length} 条高光片段加入队列（跨场次）。`, {
      autoDismissMs: 2000,
      queueLink: true,
    });
  }, [parsedMatches, addToQueue, queueItemMetaForPlayer, queuedClientClipUidsGlobal]);

  const handleAddTimelineEventToQueue = useCallback(
    (event, roundRow) => {
      const hasWindow =
        (event?.suggested_clip && typeof event.suggested_clip === "object") ||
        (event?.start_tick != null && event?.end_tick != null);
      if (!currentParsed || !hasWindow) return;
      const meta = queueItemMetaForIndex(currentMatchIndex);
      const mapName = matchMeta?.map_name || "";
      const clipData = buildTimelineEventClipData({
        event,
        mapName,
        targetPlayer: meta.targetPlayer,
        round: roundRow?.round ?? event?.round,
      });
      const uid = clipData.client_clip_uid;
      const qk = queueItemClientUid({
        clientClipUid: uid,
        clipData,
        demoFilename: meta.demoFilename,
        clipId: clipData.clip_id,
      });
      if (queuedClientClipUidsGlobal.has(qk)) {
        setProgressText("该项已在录制队列中。", { autoDismissMs: 2000 });
        return;
      }
      addToQueue({
        demoPath: meta.demoPath,
        demoFilename: meta.demoFilename,
        targetPlayer: meta.targetPlayer,
        targetPlayerUserId: meta.targetPlayerUserId,
        targetSteamId: meta.targetSteamId,
        clipId: clipData.clip_id,
        clientClipUid: uid,
        clipData,
      });
      setProgressText("已加入录制队列（时间线）", { autoDismissMs: 2000, queueLink: true });
    },
    [
      currentParsed,
      currentMatchIndex,
      queueItemMetaForIndex,
      matchMeta,
      addToQueue,
      queuedClientClipUidsGlobal,
      setProgressText,
    ],
  );

  const handleAddTimelineRoundToQueue = useCallback(
    (roundRow) => {
      if (!currentParsed || !roundRow) return;
      const meta = queueItemMetaForIndex(currentMatchIndex);
      const mapName = matchMeta?.map_name || "";
      const clipData = buildTimelineRoundClipData({ roundRow, mapName, targetPlayer: meta.targetPlayer });
      const uid = clipData.client_clip_uid;
      const qk = queueItemClientUid({
        clientClipUid: uid,
        clipData,
        demoFilename: meta.demoFilename,
        clipId: clipData.clip_id,
      });
      if (queuedClientClipUidsGlobal.has(qk)) {
        setProgressText("该回合整段已在队列中。", { autoDismissMs: 2000 });
        return;
      }
      addToQueue({
        demoPath: meta.demoPath,
        demoFilename: meta.demoFilename,
        targetPlayer: meta.targetPlayer,
        targetPlayerUserId: meta.targetPlayerUserId,
        targetSteamId: meta.targetSteamId,
        clipId: clipData.clip_id,
        clientClipUid: uid,
        clipData,
      });
      setProgressText("已加入本回合到录制队列", { autoDismissMs: 2000, queueLink: true });
    },
    [
      currentParsed,
      currentMatchIndex,
      queueItemMetaForIndex,
      matchMeta,
      addToQueue,
      queuedClientClipUidsGlobal,
      setProgressText,
    ],
  );

  const handleAddTimelineEventsBatchToQueue = useCallback(
    (eventList) => {
      if (!currentParsed || !Array.isArray(eventList) || !eventList.length) return;
      const meta = queueItemMetaForIndex(currentMatchIndex);
      const mapName = matchMeta?.map_name || "";
      const toAdd = [];
      for (const ev of eventList) {
        if (!ev?.suggested_clip && (ev?.start_tick == null || ev?.end_tick == null)) continue;
        const clipData = buildTimelineEventClipData({
          event: ev,
          mapName,
          targetPlayer: meta.targetPlayer,
          round: ev.round,
        });
        const uid = clipData.client_clip_uid;
        const qk = queueItemClientUid({
          clientClipUid: uid,
          clipData,
          demoFilename: meta.demoFilename,
          clipId: clipData.clip_id,
        });
        if (queuedClientClipUidsGlobal.has(qk)) continue;
        toAdd.push({
          demoPath: meta.demoPath,
          demoFilename: meta.demoFilename,
          targetPlayer: meta.targetPlayer,
          targetPlayerUserId: meta.targetPlayerUserId,
          targetSteamId: meta.targetSteamId,
          clipId: clipData.clip_id,
          clientClipUid: uid,
          clipData,
        });
      }
      if (!toAdd.length) {
        setProgressText("所选时间线事件均已在队列中。", { autoDismissMs: 2000 });
        return;
      }
      addToQueue(toAdd);
      setProgressText(`已加入 ${toAdd.length} 条时间线片段`, { autoDismissMs: 2000, queueLink: true });
    },
    [
      currentParsed,
      currentMatchIndex,
      queueItemMetaForIndex,
      matchMeta,
      addToQueue,
      queuedClientClipUidsGlobal,
      setProgressText,
    ],
  );

  const persistCs2RecordExtras = useCallback(async (payload) => {
    try {
      await API.put("config", payload);
    } catch {
      /* silent */
    }
  }, []);

  const persistWarmupDefaults = useCallback(async (obj) => {
    setSavedRecordWarmupDefaults(obj);
    try {
      await API.put("config", { default_record_warmup: obj });
    } catch {
      /* silent */
    }
  }, []);

  const persistExperimentalPov = useCallback(async (enabled) => {
    try {
      await API.put("config", { experimental: { pov_enabled: enabled } });
      setExperimentalPovEnabled(!!enabled);
    } catch {
      /* silent */
    }
  }, []);

  const patchSpecPlayerVerify = useCallback((partial) => {
    setSpecPlayerVerify((prev) => ({ ...prev, ...partial }));
  }, []);

  const openBatchWarmup = useCallback(() => {
    if (!queue.length) return;
    if (configBackupStatus?.restore_required) {
      setRecordingBlockedMessage(
        "检测到上次录制可能异常退出，玩家配置尚未恢复。\n请先点击「一键恢复玩家配置」，恢复完成后再开始新的录制。",
      );
      return;
    }
    setQueueDrawerOpen(false);
    setWarmupIntent("batch");
    setRecordWarmupOpen(true);
  }, [queue.length, configBackupStatus?.restore_required]);

  const handleWarmupConfirm = useCallback(
    async (warmup) => {
      const intent = warmupIntent;
      await persistWarmupDefaults(warmupApiPayloadToPersisted(warmup));

      setRecordWarmupOpen(false);
      if (intent === "batch") {
        setWarmupIntent(null);
        if (!queue.length) return;
        setBatchRecording(true);
        setProgressText("正在执行批量 OBS 导播…");
        try {
          const groups = buildBatchGroupsFromQueue(queue, useRecordingQueue.getState().globalPacing);
          const { data } = await API.post("/record/batch", { groups, warmup, obs: obsConfig });
          const results = data.results ?? [];
          const ok = results.filter((r) => r.status === "recorded").length;
          const aborted = results.filter((r) => r.status === "aborted").length;
          if (aborted > 0) {
            setProgressText(
              `批量录制已结束：成功 ${ok}，中止 ${aborted}，其余 ${results.length - ok - aborted} 条；共 ${results.length} 个片段。`,
              { autoDismissMs: 3000 },
            );
          } else {
            setProgressText(`批量录制完成！成功 ${ok} / ${results.length} 个片段。`, {
              autoDismissMs: 3000,
            });
          }
          clearQueue();
        } catch (e) {
          const detail = formatRecordingApiError(e);
          if (e.response?.status === 409 || e.response?.status === 422) {
            setRecordingBlockedMessage(detail || "录制启动失败");
          }
          setProgressText(`批量录制失败: ${detail}`);
        } finally {
          setBatchRecording(false);
          void refreshConfigBackupStatus();
        }
        return;
      }
      setWarmupIntent(null);
    },
    [
      warmupIntent,
      queue,
      clearQueue,
      obsConfig,
      globalPacing,
      persistWarmupDefaults,
      refreshConfigBackupStatus,
    ]
  );

  const handleRestorePlayerConfig = useCallback(async () => {
    setProgressText("正在恢复玩家配置…");
    try {
      const { data } = await API.post("/config-backup/restore");
      if (data?.ok) {
        setProgressText(data.message || "玩家配置已恢复");
      } else {
        setProgressText(data?.message || "部分配置恢复失败");
      }
      await refreshConfigBackupStatus();
    } catch (e) {
      const st = e.response?.status;
      const det = e.response?.data?.detail;
      if (st === 409 && det?.code === "CS2_RUNNING") {
        setRecordingBlockedMessage(
          "CS2 正在运行，无法覆盖配置文件。\n请先关闭 CS2，然后再次点击一键恢复。",
        );
      } else {
        setProgressText(`恢复失败: ${formatRecordingApiError(e)}`);
      }
      await refreshConfigBackupStatus();
    }
  }, [refreshConfigBackupStatus]);

  const handleOpenConfigBackupDir = useCallback(async () => {
    try {
      const { data } = await API.post("/config-backup/open-dir");
      if (data && data.ok === false && data.backup_dir) {
        setProgressText(`${data.message || "请手动打开"} ${data.backup_dir}`);
      }
    } catch (e) {
      setProgressText(`打开备份目录失败: ${formatRecordingApiError(e)}`);
    }
  }, []);

  const handleAbortBatchRecording = useCallback(async () => {
    try {
      const { data } = await API.post("/record/abort");
      setProgressText(data?.message || "已发送中止请求。");
    } catch (e) {
      setProgressText(`中止失败: ${e.response?.data?.detail || e.message}`);
    }
  }, []);

  const handleSaveConfig = useCallback(async (config) => {
    try {
      await API.put("config", config);
    } catch {
      // silent
    }
  }, []);

  const handleSaveExpectedParsePlayers = useCallback(async () => {
    const arr = expectedParsePlayersText
      .split(/\r?\n/)
      .map((s) => s.trim())
      .filter(Boolean);
    try {
      await API.put("config", { expected_parse_players: arr });
      setProgressText(
        arr.length
          ? `已保存 ${arr.length} 个关注昵称（同一场 Demo 可对多名并排写入库展示名）。`
          : "已清空关注名单。",
      );
    } catch (e) {
      setProgressText(`保存关注名单失败: ${e.response?.data?.detail || e.message}`);
    }
  }, [expectedParsePlayersText]);

  const persistObsConfig = useCallback(async () => {
    const o = obsConfigRef.current;
    const obs = {
      host: String(o.host ?? "").trim() || "localhost",
      port: Number(o.port) > 0 ? Number(o.port) : 4455,
    };
    const pw = String(o.password ?? "").trim();
    // 仅当用户显式输入新密码时才提交 password 字段；留空表示沿用服务器已保存密码。
    if (pw && !pw.startsWith("****")) {
      obs.password = pw;
    }
    try {
      await API.put("config", { obs });
      if (pw && !pw.startsWith("****")) {
        setObsHasSavedPassword(true);
        setObsPasswordEditing(false);
        setObsConfig((prev) => ({ ...prev, password: "" }));
      }
    } catch (e) {
      setProgressText(`保存 OBS 配置失败: ${e.response?.data?.detail || e.message}`);
    }
  }, []);

  const obsPasswordPlaceholder =
    obsHasSavedPassword && !obsPasswordEditing ? "已保存（点击输入以修改）" : "";

  const handleObsPasswordFocus = useCallback(() => {
    setObsPasswordEditing(true);
    if (obsHasSavedPassword) {
      setObsConfig((prev) => ({ ...prev, password: "" }));
    }
  }, [obsHasSavedPassword]);

  const handleObsPasswordBlur = useCallback(() => {
    const pw = String(obsConfigRef.current.password ?? "").trim();
    if (!pw && obsHasSavedPassword) {
      setObsPasswordEditing(false);
      return;
    }
    if (pw) {
      void persistObsConfig();
    }
  }, [obsHasSavedPassword, persistObsConfig]);

  useEffect(() => {
    if (!obsConfigHydratedRef.current) return;
    const t = setTimeout(() => {
      void persistObsConfig();
    }, 500);
    return () => clearTimeout(t);
  }, [obsConfig.host, obsConfig.port, persistObsConfig]);

  const persistLlmConfig = useCallback(async () => {
    await Promise.resolve();
    const c = llmConfigRef.current;
    const payload = {
      model: c.model,
      base_url: (c.base_url || "").trim() || null,
    };
    const k = (c.api_key || "").trim();
    if (k && !k.startsWith("****")) {
      payload.api_key = k;
    }
    try {
      await API.put("config", { llm: payload });
      if (k && !k.startsWith("****")) {
        setLlmKeySavedOnServer(true);
      } else {
        try {
          const { data } = await API.get("config");
          const rawKey = data.llm?.api_key ?? "";
          setLlmKeySavedOnServer(
            typeof rawKey === "string" && rawKey.trim().length > 0 && rawKey.startsWith("****")
          );
        } catch {
          /* keep prior llmKeySavedOnServer */
        }
      }
    } catch (e) {
      setProgressText(`保存大模型配置失败: ${e.response?.data?.detail || e.message}`);
    }
  }, []);

  const handleAiModeChange = useCallback(
    async (next) => {
      const prev = !next;
      setAiMode(next);
      try {
        await API.put("config", { ai_mode: next });
      } catch (e) {
        setAiMode(prev);
        setProgressText(`保存分析模式失败: ${e.response?.data?.detail || e.message}`);
        return;
      }
      if (next) {
        await persistLlmConfig();
        setProgressText(
          "已开启 AI 洞察并同步大模型配置。请再点「解析当前场次」生成锐评（解析完成后卡片上会出现分数与气泡）。"
        );
      } else {
        setProgressText("已切换为极速本地：解析不再请求大模型，仅本地规则提取片段。");
      }
    },
    [persistLlmConfig]
  );

  const handleResetDemo = useCallback(() => {
    setUploadedDemos(null);
    setParsedMatches(null);
    setLibraryDemoIdsByIndex({});
    setCurrentMatchIndex(0);
    setSelectedPlayers({});
    setActivePlayerTabs({});
    setFreezeToDeathRoundsByMatch({});
    setSelectedClientClipUids(new Set());
    setProgressText("");
    setAnalysisInlineProgress(null);
  }, []);

  const handleDetectCs2 = useCallback(async () => {
    try {
      const { data } = await API.post("config/detect-cs2");
      if (data.cs2_path) {
        setCs2Path(data.cs2_path);
        setProgressText(`已自动找到 CS2：${data.cs2_path}`);
      }
    } catch (e) {
      const msg = e.response?.data?.detail || e.message;
      setProgressText(typeof msg === "string" ? msg : "CS2 自动探测失败");
    }
  }, []);

  const saveExpectedPlayersFromList = useCallback(async (playersList) => {
    const cleaned = Array.isArray(playersList)
      ? [...new Set(playersList.map((s) => String(s).trim()).filter(Boolean))].slice(0, 50)
      : [];
    try {
      await API.put("config", { expected_parse_players: cleaned });
      setExpectedParsePlayersText(cleaned.join("\n"));
      setProgressText(
        cleaned.length ? `已保存 ${cleaned.length} 个关注昵称。` : "已清空关注名单。",
        { autoDismissMs: 2500 },
      );
    } catch (e) {
      setProgressText(`保存关注名单失败: ${e.response?.data?.detail || e.message}`);
    }
  }, []);

  const handleSaveAllSettingsPage = useCallback(
    async (expectedPlayersList) => {
      const arr = Array.isArray(expectedPlayersList)
        ? [...new Set(expectedPlayersList.map((s) => String(s).trim()).filter(Boolean))].slice(0, 50)
        : [];
      try {
        await API.put("config", {
          cs2_path: cs2Path,
          ffmpeg_path: ffmpegPath,
          montage_encoder: montageEncoder,
          cs2_fps_max: cs2FpsMax,
          expected_parse_players: arr,
        });
        setExpectedParsePlayersText(arr.join("\n"));
        await persistLlmConfig();
        setProgressText("设置已保存。", { autoDismissMs: 2200 });
      } catch (e) {
        setProgressText(`保存失败: ${e.response?.data?.detail || e.message}`);
      }
    },
    [cs2Path, ffmpegPath, montageEncoder, cs2FpsMax, persistLlmConfig, setExpectedParsePlayersText],
  );

  const handleExportSettingsConfig = useCallback(async () => {
    try {
      const { data } = await API.get("config");
      const blob = new Blob([JSON.stringify(data, null, 2)], { type: "application/json;charset=utf-8" });
      const a = document.createElement("a");
      a.href = URL.createObjectURL(blob);
      a.download = `cs2-insight-config-${new Date().toISOString().slice(0, 19).replace(/[:T]/g, "-")}.json`;
      a.click();
      URL.revokeObjectURL(a.href);
      setProgressText("已导出配置 JSON（导出中的密钥为脱敏显示）。", { autoDismissMs: 3500 });
    } catch (e) {
      setProgressText(`导出失败: ${e.response?.data?.detail || e.message}`);
    }
  }, []);

  const applyImportedSettings = useCallback(async (raw) => {
    if (!raw || typeof raw !== "object") {
      setProgressText("导入失败：不是有效的 JSON 对象。");
      return;
    }
    try {
      const put = {};
      if (typeof raw.cs2_path === "string") {
        put.cs2_path = raw.cs2_path;
        setCs2Path(raw.cs2_path);
      }
      if (typeof raw.ffmpeg_path === "string") {
        put.ffmpeg_path = raw.ffmpeg_path;
        setFfmpegPath(raw.ffmpeg_path);
      }
      if (typeof raw.montage_encoder === "string" && raw.montage_encoder.trim()) {
        put.montage_encoder = raw.montage_encoder.trim().toLowerCase();
        setMontageEncoder(put.montage_encoder);
      }
      if (typeof raw.cs2_fps_max === "number") {
        put.cs2_fps_max = raw.cs2_fps_max;
        setCs2FpsMax(raw.cs2_fps_max);
      }
      if (typeof raw.ai_mode === "boolean") {
        put.ai_mode = raw.ai_mode;
        setAiMode(raw.ai_mode);
      }
      if (Array.isArray(raw.demo_watch_paths)) {
        put.demo_watch_paths = raw.demo_watch_paths;
        setDemoWatchPaths(raw.demo_watch_paths);
      }
      if (Array.isArray(raw.expected_parse_players)) {
        put.expected_parse_players = raw.expected_parse_players;
        setExpectedParsePlayersText(raw.expected_parse_players.join("\n"));
      }
      if (Object.keys(put).length) {
        await API.put("config", put);
      }
      if (raw.spec_player_verify && typeof raw.spec_player_verify === "object") {
        const spv = raw.spec_player_verify;
        const merged = {
          demo_timescale: 0.05,
          max_retries: 4,
          per_retry_timeout_sec: 0.6,
          settle_sec: 0.12,
        };
        if (typeof spv.demo_timescale === "number" && Number.isFinite(spv.demo_timescale)) {
          merged.demo_timescale = spv.demo_timescale;
        }
        if (typeof spv.max_retries === "number" && Number.isFinite(spv.max_retries)) {
          merged.max_retries = Math.round(spv.max_retries);
        }
        if (typeof spv.per_retry_timeout_sec === "number" && Number.isFinite(spv.per_retry_timeout_sec)) {
          merged.per_retry_timeout_sec = spv.per_retry_timeout_sec;
        }
        if (typeof spv.settle_sec === "number" && Number.isFinite(spv.settle_sec)) {
          merged.settle_sec = spv.settle_sec;
        }
        await API.put("config", { spec_player_verify: merged });
        setSpecPlayerVerify(merged);
      }
      if (raw.llm && typeof raw.llm === "object") {
        const lm = raw.llm;
        const payload = {
          model: String(lm.model ?? "").trim(),
          base_url: lm.base_url != null ? String(lm.base_url).trim() || null : null,
        };
        const k = lm.api_key != null ? String(lm.api_key).trim() : "";
        if (k && !k.startsWith("****")) {
          payload.api_key = k;
        }
        await API.put("config", { llm: payload });
        setLlmConfig((prev) => ({
          model: payload.model,
          base_url: payload.base_url || "",
          api_key: payload.api_key ?? prev.api_key,
        }));
        if (k && !k.startsWith("****")) {
          setLlmKeySavedOnServer(true);
        }
      }
      setProgressText("已应用导入的配置。", { autoDismissMs: 2800 });
    } catch (e) {
      setProgressText(`导入失败: ${e.response?.data?.detail || e.message}`);
    }
  }, []);

  const handleResetSettingsDefaults = useCallback(async () => {
    if (
      !window.confirm(
        "将 CS2/FFmpeg 路径、合辑编码、fps_max、分析模式、关注名单与大模型接口/模型名恢复为默认（不含 OBS 与 Demo 监听目录）。已保存在服务器上的 API 密钥若未在导入文件中提供则仍会保留。确定继续？",
      )
    ) {
      return;
    }
    const defaults = {
      cs2_path: "",
      ffmpeg_path: "",
      montage_encoder: "auto",
      cs2_fps_max: 240,
      ai_mode: false,
      expected_parse_players: [],
      llm: {
        model: "",
        base_url: null,
      },
    };
    try {
      await API.put("config", defaults);
      setCs2Path("");
      setFfmpegPath("");
      setMontageEncoder("auto");
      setCs2FpsMax(240);
      setAiMode(false);
      setExpectedParsePlayersText("");
      setLlmConfig({
        model: "",
        api_key: "",
        base_url: "",
      });
      setProgressText("已恢复默认（路径与解析相关项）。", { autoDismissMs: 3000 });
    } catch (e) {
      setProgressText(`恢复默认失败: ${e.response?.data?.detail || e.message}`);
    }
  }, []);

  const handleOpenConfigDataDir = useCallback(async () => {
    try {
      const { data } = await API.post("config/open-dir");
      if (data?.ok === false) {
        setProgressText(`${data.message || "无法打开目录"} ${data.path || ""}`.trim());
      }
    } catch (e) {
      setProgressText(`打开目录失败: ${e.response?.data?.detail || e.message}`);
    }
  }, []);

  const handleTestLlmConnection = useCallback(async () => {
    await persistLlmConfig();
    try {
      const { data } = await API.post("config/test-llm");
      if (data?.ok) {
        setProgressText(`AI 连接正常${data.detail ? `：${data.detail}` : ""}`, { autoDismissMs: 4000 });
      } else {
        setProgressText(`AI 连接失败：${data?.detail || "未知错误"}`);
      }
    } catch (e) {
      setProgressText(`AI 测试请求失败: ${e.response?.data?.detail || e.message}`);
    }
  }, [persistLlmConfig]);

  const hasDemos = uploadedDemos && uploadedDemos.length > 0;
  const currentFilename = currentUpload?.filename ?? "";

  useEffect(() => {
    if (!uploadedDemos?.length) return;
    if (currentMatchIndex >= uploadedDemos.length) {
      setCurrentMatchIndex(0);
    }
  }, [uploadedDemos, currentMatchIndex]);

  useEffect(() => {
    setSelectedClientClipUids(new Set());
  }, [currentMatchIndex]);
  const shell = {
    aiMode,
    queue,
    uploadedDemos,
    libraryTotal,
    handleAiModeChange,
    obsConfig,
    setObsConfig,
    persistObsConfig,
    obsPasswordPlaceholder,
    handleObsPasswordFocus,
    handleObsPasswordBlur,
    llmConfig,
    setLlmConfig,
    llmKeySavedOnServer,
    persistLlmConfig,
    cs2Path,
    setCs2Path,
    ffmpegPath,
    setFfmpegPath,
    montageEncoder,
    setMontageEncoder,
    cs2FpsMax,
    setCs2FpsMax,
    demoWatchPaths,
    setDemoWatchPaths,
    handleSaveConfig,
    handleDetectCs2,
    handleSaveAllSettingsPage,
    saveExpectedPlayersFromList,
    handleExportSettingsConfig,
    applyImportedSettings,
    handleResetSettingsDefaults,
    handleOpenConfigDataDir,
    handleTestLlmConnection,
    handleScanDemos,
    libraryLoading,
    libraryScanning,
    expectedParsePlayersText,
    setExpectedParsePlayersText,
    handleSaveExpectedParsePlayers,
    currentDemoFilename,
    batchRecording,
    savedRecordWarmupDefaults,
    persistWarmupDefaults,
    cs2ExtraLaunchArgs,
    setCs2ExtraLaunchArgs,
    recordInjectConsoleLines,
    setRecordInjectConsoleLines,
    persistCs2RecordExtras,
    experimentalPovEnabled,
    persistExperimentalPov,
    specPlayerVerify,
    patchSpecPlayerVerify,
    hasDemos,
    parsing,
    handleUpload,
    currentFilename,
    matchTabsData,
    currentMatchIndex,
    setCurrentMatchIndex,
    players,
    matchMeta,
    currentParsed,
    selectedPlayersList,
    setSelectedPlayers,
    handleParse,
    parsingByIndex,
    analysisInlineProgress,
    anyDemoParsing,
    progressText,
    handleAbortBatchRecording,
    clips,
    timeline,
    roundTimeline,
    handleAddTimelineEventToQueue,
    handleAddTimelineRoundToQueue,
    handleAddTimelineEventsBatchToQueue,
    selectedClientClipUids,
    handleToggleClip,
    queuedClientClipUidsForCurrentDemo,
    parsedPlayerNames,
    currentActivePlayer,
    setActivePlayerTabs,
    roundMontageMaxRounds,
    freezeToDeathDraft,
    setFreezeToDeathDraft,
    selectedRegularCount,
    regularSelectableTotal,
    handleSelectAll,
    handleDeselectAll,
    handleAddSelectedToQueue,
    handleAddAllHighlightsAllMatches,
    canAddAllHighlights,
    handleResetDemo,
    removeFromQueue,
    clearQueue,
    openBatchWarmup,
    demoLibraryItems,
    setLibrarySearchInput,
    librarySearchInput,
    librarySearchQ,
    setLibrarySearchQ,
    handleLibrarySearchSubmit,
    libraryAdvFilters,
    setLibraryAdvFilters,
    selectLibraryPage,
    selectAllLibraryDemos,
    clearLibrarySelection,
    handleLoadSelectedLibraryDemos,
    setLibraryBatchModalOpen,
    selectedLibraryDemoIds,
    setSelectedLibraryDemoIds,
    libraryPage,
    setLibraryPage,
    libraryPageSize,
    setLibraryPageSize,
    libraryTotalPages,
    libraryHasNextPage,
    libraryJumpDraft,
    setLibraryJumpDraft,
    handleLibraryPageJump,
    refreshDemoLibrary,
    hasLibraryAdvancedFilters,
    handleLoadDemoFromLibrary,
    handleDeleteDemo,
    handleLibraryBatchDelete,
    setProgressText,
    handleSaveLibraryRename,
    setLibraryRename,
    setLibraryDeletePrompt,
    libraryRename,
    libraryDeletePrompt,
    configBackupStatus,
    refreshConfigBackupStatus,
    handleRestorePlayerConfig,
    handleOpenConfigBackupDir,
  };

  const hasDemosInline = uploadedDemos && uploadedDemos.length > 0;
  const parsingShownInline =
    location.pathname === "/analysis" &&
    hasDemosInline &&
    (Boolean(parsingByIndex[currentMatchIndex]) || analysisInlineProgress?.active === true);

  const showGlobalNotice =
    batchRecording ||
    Boolean(progressText?.trim()) ||
    (anyDemoParsing && !parsingShownInline);

  return (
    <AppShellProvider value={shell}>
      <div className="relative flex h-screen overflow-hidden bg-cs2-bg-dark">
        {libraryLoadingOverlay && (
          <div className="absolute inset-0 z-[70] flex items-center justify-center bg-black/55 backdrop-blur-[1px]">
            <div className="flex items-center gap-3 rounded-lg border border-white/10 bg-cs2-bg-card px-4 py-3 shadow-2xl">
              <Loader2 className="h-5 w-5 animate-spin text-cs2-orange" />
              <p className="text-sm font-medium text-zinc-200">{libraryLoadingText}</p>
            </div>
          </div>
        )}
        <SidebarNav queueLength={queue.length} disabled={batchRecording} />
        <main className="flex min-w-0 flex-1 flex-col overflow-hidden">
          <div className="min-h-0 flex-1 overflow-hidden">
            <Routes>
              <Route path="/" element={<GuidePage />} />
              <Route path="/library" element={<DemoLibraryPage />} />
              <Route path="/analysis" element={<AnalysisPage />} />
              <Route path="/queue" element={<RecordingQueuePage />} />
              <Route path="/montage" element={<MontageWorkbenchPage />} />
              <Route path="/params" element={<CommonParamsPage />} />
              <Route path="/obs-config-center" element={<ObsConfigCenterPage />} />
              <Route path="/settings" element={<SettingsPage />} />
              <Route path="/player-game-config" element={<PlayerGameConfigPage />} />
              <Route path="*" element={<Navigate to="/" replace />} />
            </Routes>
          </div>
        </main>

        {showGlobalNotice ? (
          <div
            className="pointer-events-none fixed inset-x-0 bottom-0 z-[60] flex justify-center px-4 pb-[max(1rem,env(safe-area-inset-bottom))] pt-2 sm:px-6"
            aria-live="polite"
          >
            <div className="pointer-events-auto w-full max-w-lg shadow-2xl shadow-black/50">
              <ProgressBar
                text={progressText || (batchRecording ? "正在批量录制…" : "")}
                active={anyDemoParsing}
                batchRecording={batchRecording}
                onAbortBatch={handleAbortBatchRecording}
                dismissible={Boolean(progressText?.trim())}
                onDismiss={() => setProgressText("")}
                autoDismissAfterMs={progressToastMeta?.autoDismissMs ?? undefined}
                showQueueNavigate={Boolean(progressToastMeta?.queueLink)}
              />
            </div>
          </div>
        ) : null}

        <RecordWarmupModal
          open={recordWarmupOpen}
          onClose={() => {
            setRecordWarmupOpen(false);
            setWarmupIntent(null);
          }}
          onConfirm={handleWarmupConfirm}
          defaultOverrides={savedRecordWarmupDefaults ?? undefined}
          experimentalPovEnabled={experimentalPovEnabled}
          onExperimentalPovChange={persistExperimentalPov}
          cs2ExtraLaunchArgs={cs2ExtraLaunchArgs}
          onCs2ExtraLaunchArgsChange={setCs2ExtraLaunchArgs}
          recordInjectConsoleLines={recordInjectConsoleLines}
          onRecordInjectConsoleLinesChange={setRecordInjectConsoleLines}
          onPersistCs2RecordExtras={persistCs2RecordExtras}
        />

        <LibraryLoadModeModal
          open={libraryBatchModalOpen}
          onClose={() => setLibraryBatchModalOpen(false)}
          expectedPreviewLines={expectedPreviewLines}
          onConfirm={(payload) => {
            setLibraryBatchModalOpen(false);
            void runLibraryBatchLoad(payload);
          }}
        />

        <RecordingBlockedDialog
          message={recordingBlockedMessage}
          onClose={() => setRecordingBlockedMessage("")}
        />
      </div>
    </AppShellProvider>
  );
}
