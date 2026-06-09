import { useState, useCallback, useMemo, useEffect, useRef } from "react";
import { Routes, Route, Navigate, useNavigate, useLocation } from "react-router-dom";
import { AppShellProvider } from "./context/AppShellContext";
import SidebarNav from "./components/SidebarNav";
import UpdateCheckModal from "./components/UpdateCheckModal";
import RecordingBlockedDialog from "./components/RecordingBlockedDialog";
import RecordingResultModal from "./components/recordingQueue/RecordingResultModal";
import RecordWarmupModal from "./components/RecordWarmupModal";
import ProgressBar from "./components/ProgressBar";
import LibraryLoadModeModal from "./components/LibraryLoadModeModal";
import BatchLoadErrorModal from "./components/BatchLoadErrorModal";
import GuidePage from "./pages/GuidePage";
import DemoLibraryPage from "./pages/DemoLibraryPage";
import AnalysisPage from "./pages/AnalysisPage";
import RecordingQueuePage from "./pages/RecordingQueuePage";
import MontageWorkbenchPage from "./pages/MontageWorkbenchPage";
import RecordingParamsPage from "./pages/RecordingParamsPage";
import ObsConfigCenterPage from "./pages/ObsConfigCenterPage";
import SettingsPage from "./pages/SettingsPage";
import PlayerGameConfigPage from "./pages/PlayerGameConfigPage";
import MatchHistoryPage from "./pages/MatchHistoryPage";
import { useRecordingQueue } from "./stores/recordingQueueStore";
import { useLocaleStore } from "./i18n/localeStore";
import { useT } from "./i18n/useT.js";
import { ensureClientClipUidsOnClips } from "./utils/clipClientUid";
import {
  freezeToDeathDraftFromClipFilter,
  isFreezeToDeathCompilation,
  sliceFreezeToDeathClipForEnqueue,
} from "./utils/freezeToDeathRoundFilter";
import { splitRecordWarmupConfirmPayload } from "./utils/warmupDefaults";
import { buildTimelineEventClipData, buildTimelineRoundClipData } from "./utils/timelineQueue";
import {
  queueItemClientUid,
  runWithConcurrency,
  buildRecordingQueueRequestsFromQueue,
  applySessionObsTransitionToRequests,
  applySessionKbOverlayToRequests,
} from "./utils/recordingBatch";
import { formatRecordingApiError } from "./utils/formatRecordingApiError";
import { progressToastShowsBusy } from "./utils/progressToast";
import { Loader2 } from "lucide-react";
import API, { API_BASE_URL, BACKEND_CONNECT_LABEL } from "./api/api";

import CustomTitleBar from "./components/CustomTitleBar";

const DEFAULT_CS2_EXTRA_LAUNCH_ARGS = "-fullscreen";

function ensureDefaultCs2FullscreenArg(value) {
  const text = String(value ?? "").trim();
  if (!text) return DEFAULT_CS2_EXTRA_LAUNCH_ARGS;
  if (/(?:^|\s)-fullscreen(?=$|\s)/i.test(text)) return text;
  return `${text}\n${DEFAULT_CS2_EXTRA_LAUNCH_ARGS}`;
}

export default function App() {
  const navigate = useNavigate();
  const location = useLocation();
  const t = useT();
  const locale = useLocaleStore((s) => s.locale);
  const [backendReady, setBackendReady] = useState(false);
  const [aiMode, setAiMode] = useState(false);
  
  // 修正 isPackaged 检测：同步判断
  const [isPackaged, setIsPackaged] = useState(false);
  useEffect(() => {
    if (window.electron?.isPackaged) {
      window.electron.isPackaged().then(setIsPackaged);
    }
  }, []);
  const [obsConfig, setObsConfig] = useState({ host: "localhost", port: 4455, password: "", obs_path: "" });
  /** 服务器是否已有 OBS 密码（GET /api/config 返回脱敏或本地刚保存成功） */
  const [obsHasSavedPassword, setObsHasSavedPassword] = useState(false);
  /** 用户是否正在编辑密码框（用于失焦时恢复“已保存”提示） */
  const [obsPasswordEditing, setObsPasswordEditing] = useState(false);
  const [updateInfo, setUpdateInfo] = useState(null);
  const [updateModalOpen, setUpdateModalOpen] = useState(false);
  const [updateModalManual, setUpdateModalManual] = useState(false);
  const obsConfigRef = useRef(obsConfig);
  obsConfigRef.current = obsConfig;
  const obsConfigHydratedRef = useRef(false);
  /** GET /api/config 已注入录制队列全局节奏后再允许自动写回，避免覆盖用户在本页会话内的修改 */
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
  const [recordingResults, setRecordingResults] = useState(null);
  const [recordingResultModalOpen, setRecordingResultModalOpen] = useState(false);
  const [recordingBlockedMessage, setRecordingBlockedMessage] = useState("");
  const [recordWarmupOpen, setRecordWarmupOpen] = useState(false);
  const [warmupIntent, setWarmupIntent] = useState(null);
  /** @type {null | { restore_required?: boolean; message?: string; cs2_running?: boolean; backup_dir?: string }} */
  const [configBackupStatus, setConfigBackupStatus] = useState(null);
  const [configBackupLoading, setConfigBackupLoading] = useState(false);
  /** 来自 data/cs2-insight.config.json（或 CS2_INSIGHT_CONFIG），打开录制预热对话框时作为初始选项 */
  const [savedRecordWarmupDefaults, setSavedRecordWarmupDefaults] = useState(null);
  const savedRecordWarmupDefaultsRef = useRef(null);
  const [cs2ExtraLaunchArgs, setCs2ExtraLaunchArgs] = useState("");
  const [recordInjectConsoleLines, setRecordInjectConsoleLines] = useState("");
  const [queueDrawerOpen, setQueueDrawerOpen] = useState(false);
  const [montageDrawerOpen, setMontageDrawerOpen] = useState(false);
  const [commonParamsOpen, setCommonParamsOpen] = useState(false);
  const [experimentalPovEnabled, setExperimentalPovEnabled] = useState(false);
  const [obsTransitionEnabled, setObsTransitionEnabled] = useState(false);
  const [obsTransitionName, setObsTransitionName] = useState("Fade");
  const [obsTransitionDurationMs, setObsTransitionDurationMs] = useState(100);
  const [kbOverlayEnabled, setKbOverlayEnabled] = useState(false);
  const [kbOverlayTickOffset, setKbOverlayTickOffset] = useState(6);
  const [kbOverlayPosition, setKbOverlayPosition] = useState("bottom_center");
  /** 保存或拉取配置后递增，驱动常用参数页表单重新灌入 */
  const [commonParamsRefreshKey, setCommonParamsRefreshKey] = useState(0);
  const [cs2Path, setCs2Path] = useState("");
  const [ffmpegPath, setFfmpegPath] = useState("");
  const [updateGithubMirror, setUpdateGithubMirror] = useState("auto");
  const [updateGithubMirrorCustom, setUpdateGithubMirrorCustom] = useState("");
  const [montageEncoder, setMontageEncoder] = useState("auto");
  const [demoWatchPaths, setDemoWatchPaths] = useState([]);
  const [expectedParsePlayersText, setExpectedParsePlayersText] = useState("");
  const [demoLibraryItems, setDemoLibraryItems] = useState([]);
  const [libraryLoading, setLibraryLoading] = useState(false);
  /** 仅「扫描本地 demo 库」进行中；不在顶部 ProgressBar 展示，由按钮内 spinner 表示 */
  const [libraryScanning, setLibraryScanning] = useState(false);
  const [libraryLoadingOverlay, setLibraryLoadingOverlay] = useState(false);
  const [libraryLoadingText, setLibraryLoadingText] = useState("");
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
  const [libraryPageSize, setLibraryPageSize] = useState(12);
  const libraryPageSizeEffectSkipRef = useRef(false);
  const [libraryBatchModalOpen, setLibraryBatchModalOpen] = useState(false);
  const [batchLoadError, setBatchLoadError] = useState({ open: false, failed: [] });
  const [llmKeySavedOnServer, setLlmKeySavedOnServer] = useState(false);
  const llmConfigRef = useRef(llmConfig);
  llmConfigRef.current = llmConfig;

  const queue           = useRecordingQueue((s) => s.queue);
  const addToQueue      = useRecordingQueue((s) => s.addToQueue);
  const removeFromQueue        = useRecordingQueue((s) => s.removeFromQueue);
  const removeByClientClipUid  = useRecordingQueue((s) => s.removeByClientClipUid);
  const clearQueue             = useRecordingQueue((s) => s.clearQueue);
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
    const uids = new Set();
    for (const q of queue) {
      if (q.demoFilename !== currentDemoFilename) continue;
      uids.add(queueItemClientUid(q));
      if (q.sourceClientClipUid) uids.add(q.sourceClientClipUid);
    }
    return uids;
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
        es = new EventSource(`${API_BASE_URL}/api/demos/stream`);
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
      setProgressText(t("app.libraryPageJumpInvalid"));
      return;
    }
    const maxPage = libraryTotalPages;
    let target = n;
    if (maxPage != null && n > maxPage) {
      target = maxPage;
      setProgressText(t("app.libraryPageJumpClamped", { maxPage }));
    }
    setLibraryJumpDraft("");
    setLibraryPage(target);
    void refreshDemoLibrary(target, { manageLoading: false });
  }, [libraryJumpDraft, libraryTotalPages, refreshDemoLibrary, t]);

  const handleScanDemos = useCallback(async () => {
    setLibraryScanning(true);
    try {
      const { data } = await API.post("/demos/scan");
      await refreshDemoLibrary(libraryPage, { manageLoading: false });
      const n = data?.discovered_count;
      if (typeof n === "number" && n > 0) {
        setProgressText(t("app.scanDone", { n }));
      }
    } catch (e) {
      setProgressText(t("app.scanFail", { msg: e.response?.data?.detail || e.message }), { isError: true });
    } finally {
      setLibraryScanning(false);
    }
  }, [refreshDemoLibrary, libraryPage, t]);

  const handleDeleteDemo = useCallback(
    async (id, rescan) => {
      try {
        await API.delete(`/demos/${id}`, { params: { rescan } });
        setLibraryDeletePrompt(null);
        await refreshDemoLibrary(libraryPage, { manageLoading: false });
      } catch (e) {
        setProgressText(t("app.deleteFail", { msg: e.response?.data?.detail || e.message }), { isError: true });
      }
    },
    [refreshDemoLibrary, libraryPage, t]
  );

  const handleDeleteDemoFile = useCallback(
    async (id) => {
      try {
        await API.post(`/demos/${id}/delete-file`);
        setLibraryDeletePrompt(null);
        setProgressText(t("app.deleteFileDone"));
        await refreshDemoLibrary(libraryPage, { manageLoading: false });
      } catch (e) {
        setProgressText(t("app.deleteFileFail", { msg: e.response?.data?.detail || e.message }), { isError: true });
      }
    },
    [refreshDemoLibrary, libraryPage, t]
  );

  const handleLibraryBatchDelete = useCallback(
    async (ids, rescan = "skip") => {
      const list = [...ids];
      if (!list.length) return;
      setProgressText(t("app.batchDeleteProgress", { done: 0, total: list.length }), { loading: true });
      let done = 0;
      for (const id of list) {
        try {
          await API.delete(`/demos/${id}`, { params: { rescan } });
          done += 1;
          setProgressText(t("app.batchDeleteProgress", { done, total: list.length }), { loading: true });
        } catch (e) {
          setProgressText(t("app.batchDeleteFail", { msg: e.response?.data?.detail || e.message }), { isError: true });
          await refreshDemoLibrary(libraryPage, { manageLoading: false });
          return;
        }
      }
      setSelectedLibraryDemoIds(new Set());
      setProgressText(t("app.batchDeleteDone", { n: list.length }));
      await refreshDemoLibrary(libraryPage, { manageLoading: false });
    },
    [refreshDemoLibrary, libraryPage, t]
  );

  const handleSaveLibraryRename = useCallback(async () => {
    if (!libraryRename) return;
    try {
      await API.patch(`/demos/${libraryRename.id}`, { display_name: libraryRename.draft });
      setLibraryRename(null);
      await refreshDemoLibrary(libraryPage, { manageLoading: false });
    } catch (e) {
      setProgressText(t("app.renameFail", { msg: e.response?.data?.detail || e.message }), { isError: true });
    }
  }, [libraryRename, refreshDemoLibrary, libraryPage, t]);

  const handleLoadDemoFromLibrary = useCallback(async (items, opts = {}) => {
    const { resolvedByDemoId, skipLoadingOverlay = false } = opts;
    if (!skipLoadingOverlay) {
      setLibraryLoadingOverlay(true);
      setLibraryLoadingText(t("app.libraryLoadingDemo"));
    }
    try {
      const list = Array.isArray(items) ? items : [items];
      const loaded = await Promise.all(
        list.map(async (item) => {
          const playersResult =
            item.players != null
              ? { players: item.players, match_meta: item.match_meta }
              : (await API.get(`/demos/${item.id}/players`)).data;
          const data = playersResult;
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
      setProgressText(t("app.libraryLoadFail", { msg: e.response?.data?.detail || e.message }), { isError: true });
      return null;
    } finally {
      if (!skipLoadingOverlay) {
        setLibraryLoadingOverlay(false);
        setLibraryLoadingText(t("app.libraryLoadingDemo"));
      }
    }
  }, [navigate, t]);

  const handleLoadSelectedLibraryDemos = useCallback(async () => {
    const ids = Array.from(selectedLibraryDemoIds);
    if (!ids.length) return;
    setLibraryLoadingOverlay(true);
    setLibraryLoadingText(t("app.libraryLoadingDemo"));
    try {
      ids.sort((a, b) => Number(a) - Number(b));
      const { data } = await API.post("/demos/batch-summary", { ids });
      await handleLoadDemoFromLibrary(data.items, { skipLoadingOverlay: true });
    } catch (e) {
      const failed = e.response?.data?.detail?.failed;
      if (Array.isArray(failed) && failed.length) {
        setBatchLoadError({ open: true, failed });
      } else {
        setProgressText(t("app.libraryLoadSelectedFail", { msg: e.response?.data?.detail?.message || e.response?.data?.detail || e.message }), { isError: true });
      }
    } finally {
      setLibraryLoadingOverlay(false);
    }
  }, [selectedLibraryDemoIds, handleLoadDemoFromLibrary, setProgressText, t]);

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
        setProgressText(t("app.librarySelectAllCapped", { cap }));
      }
    } catch (e) {
      setProgressText(t("app.librarySelectAllFail", { msg: e.response?.data?.detail || e.message }), { isError: true });
    }
  }, [libraryTotal, librarySearchQ, appendDemoLibraryFilterParams, t]);

  const clearLibrarySelection = useCallback(() => {
    setSelectedLibraryDemoIds(new Set());
  }, []);

  const applyCommonParamsFromConfigData = useCallback((data) => {
    if (!data || typeof data !== "object") return;
    if (data.default_record_warmup && typeof data.default_record_warmup === "object") {
      setSavedRecordWarmupDefaults(
        Array.isArray(data.default_record_warmup) ? {} : data.default_record_warmup,
      );
    } else {
      setSavedRecordWarmupDefaults({});
    }
    if (typeof data.cs2_extra_launch_args === "string") {
      setCs2ExtraLaunchArgs(data.cs2_extra_launch_args);
    }
    if (typeof data.record_inject_console_lines === "string") {
      setRecordInjectConsoleLines(data.record_inject_console_lines);
    }
    if (typeof data.obs_transition_enabled === "boolean") {
      setObsTransitionEnabled(data.obs_transition_enabled);
    }
    if (typeof data.obs_transition_name === "string") {
      setObsTransitionName(data.obs_transition_name);
    }
    if (typeof data.obs_transition_duration_ms === "number") {
      setObsTransitionDurationMs(data.obs_transition_duration_ms);
    }
    if (typeof data.kb_overlay_enabled === "boolean") {
      setKbOverlayEnabled(data.kb_overlay_enabled);
    }
    if (typeof data.kb_overlay_tick_offset === "number") {
      setKbOverlayTickOffset(data.kb_overlay_tick_offset);
    }
    if (typeof data.kb_overlay_position === "string") {
      setKbOverlayPosition(data.kb_overlay_position);
    }
    if (data.experimental && typeof data.experimental.pov_enabled === "boolean") {
      setExperimentalPovEnabled(data.experimental.pov_enabled);
    }
    if (
      data.recording_global_pacing &&
      typeof data.recording_global_pacing === "object" &&
      !Array.isArray(data.recording_global_pacing)
    ) {
      useRecordingQueue.getState().hydrateGlobalPacing(data.recording_global_pacing);
    }
  }, []);

  const refreshCommonParamsFromServer = useCallback(async () => {
    const { data } = await API.get("config");
    applyCommonParamsFromConfigData(data);
    setCommonParamsRefreshKey((k) => k + 1);
    return data;
  }, [applyCommonParamsFromConfigData]);

  useEffect(() => {
    let cancelled = false;
    const initialize = async () => {
      while (!cancelled) {
        try {
          const { data } = await API.get("config");
          if (cancelled) return;
          useLocaleStore.getState().hydrate(data.locale);
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
          if (data.cs2_path) setCs2Path(data.cs2_path);
          if (typeof data.ffmpeg_path === "string") setFfmpegPath(data.ffmpeg_path);
          if (typeof data.update_github_mirror === "string") {
            const m = data.update_github_mirror.trim();
            if (m.startsWith("http://") || m.startsWith("https://")) {
              setUpdateGithubMirror("custom");
              setUpdateGithubMirrorCustom(m);
            } else if (m) {
              setUpdateGithubMirror(m);
              setUpdateGithubMirrorCustom("");
            }
          }
          if (typeof data.montage_encoder === "string" && data.montage_encoder.trim()) {
            setMontageEncoder(data.montage_encoder.trim().toLowerCase());
          }
          if (Array.isArray(data.demo_watch_paths)) setDemoWatchPaths(data.demo_watch_paths);
          if (Array.isArray(data.expected_parse_players)) {
            setExpectedParsePlayersText(data.expected_parse_players.join("\n"));
          }
          applyCommonParamsFromConfigData(data);
          setCommonParamsRefreshKey((k) => k + 1);

          obsConfigHydratedRef.current = true;
          setBackendReady(true);
          break;
        } catch {
          await new Promise((resolve) => setTimeout(resolve, 1000));
        }
      }
    };

    initialize();
    return () => {
      cancelled = true;
    };
  }, [applyCommonParamsFromConfigData]);

  const refreshConfigBackupStatus = useCallback(async () => {
    setConfigBackupLoading(true);
    try {
      const { data } = await API.get("/config-backup/status");
      setConfigBackupStatus(data && typeof data === "object" ? data : null);
    } catch (e) {
      const msg =
        e?.response?.data?.detail != null
          ? typeof e.response.data.detail === "string"
            ? e.response.data.detail
            : JSON.stringify(e.response.data.detail)
          : e?.message || t("app.backendConnectFail");
      setConfigBackupStatus({
        fetch_failed: true,
        message: String(msg),
      });
    } finally {
      setConfigBackupLoading(false);
    }
  }, [t]);

  useEffect(() => {
    void refreshConfigBackupStatus();
  }, [refreshConfigBackupStatus]);

  // 全局节奏改由「常用参数」页顶「保存」写入配置；录制队列抽屉内微调仍只改内存，刷新后以配置文件为准。

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

    setProgressText(t("app.uploadingDemo"), { loading: true });
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
          ? t("app.uploadDoneMulti", { n: uploads.length })
          : t("app.uploadDoneSingle");
      setProgressText("");
      setAnalysisInlineProgress({ active: false, text: uploadDoneMsg });
      navigate("/analysis");
    } catch (e) {
      setProgressText(t("app.uploadFail", { msg: e.response?.data?.detail || e.message }), { isError: true });
    } finally {
      setParsing(false);
    }
  }, [navigate, t]);

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
        setAnalysisInlineProgress({ active: true, text: t("app.parsingDemo", { fn }) });
        setSelectedClientClipUids(new Set());
      }

      try {
        const activeLibraryDemoId = libIds[idx] ?? demos[idx]?.id;
        const body = { target_players: names, locale: useLocaleStore.getState().locale };
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
          names.length === 1 ? names[0] : t("app.parseDonePlayerCount", { n: names.length });
        const doneMsg =
          totalMeme > 0
            ? t("app.parseDoneWithMeme", { fn, rounds, playerLabel, totalRegular, totalMeme })
            : t("app.parseDone", { fn, rounds, playerLabel, totalRegular });
        if (!quietProgress) {
          if (viewingHere) setAnalysisInlineProgress({ active: false, text: doneMsg });
          else setProgressText((prev) => (prev ? `${prev}\n${doneMsg}` : doneMsg));
        }
      } catch (e) {
        const err = t("app.parseFail", { fn, msg: e.response?.data?.detail || e.message });
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
    [uploadedDemos, selectedPlayers, libraryDemoIdsByIndex, freezeToDeathRoundsByMatch, t]
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
        setLibraryLoadingText(t("app.libraryLoadingAndParsing"));
      }
      try {
        const items = await Promise.all(ids.map((id) => API.get(`/demos/${id}`).then((r) => r.data)));
        let resolvedByDemoId = null;
        if (mode !== "none") {
          if (holdOverlayUntilParsed) {
            setLibraryLoadingText(t("app.libraryMatchingPlayers"));
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
          setLibraryLoadingText(t("app.libraryLoadingDemoFiles"));
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
            `${prev || ""}\n${t("app.libraryNoPlayersMatched")}`.trim()
          );
          return;
        }
        if (holdOverlayUntilParsed) {
          setLibraryLoadingText(t("app.libraryParsingHighlights", { done: 0, total: specs.length }));
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
            setLibraryLoadingText(t("app.libraryParsingHighlights", { done, total: specs.length }));
          }
        });
        setProgressText("");
      } catch (e) {
        setProgressText(t("app.libraryLoadAndParseFail", { msg: e.response?.data?.detail || e.message }), { isError: true });
      } finally {
        if (holdOverlayUntilParsed) {
          setLibraryLoadingOverlay(false);
          setLibraryLoadingText(t("app.libraryLoadingDemo"));
        }
      }
    },
    [selectedLibraryDemoIds, handleLoadDemoFromLibrary, handleParseForIndex, t]
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
          setProgressText(t(sliced.errorKey));
          return;
        }
        toAdd.push({
          ...row,
          clientClipUid: sliced.clip.client_clip_uid,
          sourceClientClipUid: c.client_clip_uid,
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
      skipped > 0 ? t("app.enqueueSkippedHint", { n: skipped }) : "";
    setProgressText(t("app.enqueueAdded", { n: toAdd.length }) + skipHint, {
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
    t,
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
      setProgressText(t("app.enqueueAllHighlightsEmpty"));
      return;
    }
    addToQueue(toAdd);
    setProgressText(t("app.enqueueAllHighlightsDone", { n: toAdd.length }), {
      autoDismissMs: 2000,
      queueLink: true,
    });
  }, [parsedMatches, addToQueue, queueItemMetaForPlayer, queuedClientClipUidsGlobal, t]);

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
        t,
        locale,
      });
      const uid = clipData.client_clip_uid;
      const qk = queueItemClientUid({
        clientClipUid: uid,
        clipData,
        demoFilename: meta.demoFilename,
        clipId: clipData.clip_id,
      });
      if (queuedClientClipUidsGlobal.has(qk)) {
        setProgressText(t("app.enqueueTimelineAlreadyIn"), { autoDismissMs: 2000 });
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
      setProgressText(t("app.enqueueTimelineDone"), { autoDismissMs: 2000, queueLink: true });
    },
    [
      currentParsed,
      currentMatchIndex,
      queueItemMetaForIndex,
      matchMeta,
      addToQueue,
      queuedClientClipUidsGlobal,
      setProgressText,
      t,
      locale,
    ],
  );

  const handleAddTimelineRoundToQueue = useCallback(
    (roundRow) => {
      if (!currentParsed || !roundRow) return;
      const meta = queueItemMetaForIndex(currentMatchIndex);
      const mapName = matchMeta?.map_name || "";
      const clipData = buildTimelineRoundClipData({ roundRow, mapName, targetPlayer: meta.targetPlayer, demoFilename: meta.demoFilename, t });
      const uid = clipData.client_clip_uid;
      const qk = queueItemClientUid({
        clientClipUid: uid,
        clipData,
        demoFilename: meta.demoFilename,
        clipId: clipData.clip_id,
      });
      if (queuedClientClipUidsGlobal.has(qk)) {
        setProgressText(t("app.enqueueRoundAlreadyIn"), { autoDismissMs: 2000 });
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
      setProgressText(t("app.enqueueRoundDone"), { autoDismissMs: 2000, queueLink: true });
    },
    [
      currentParsed,
      currentMatchIndex,
      queueItemMetaForIndex,
      matchMeta,
      addToQueue,
      queuedClientClipUidsGlobal,
      setProgressText,
      t,
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
          t,
          locale,
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
        setProgressText(t("app.enqueueTimelineBatchAllIn"), { autoDismissMs: 2000 });
        return;
      }
      addToQueue(toAdd);
      setProgressText(t("app.enqueueTimelineBatchDone", { n: toAdd.length }), { autoDismissMs: 2000, queueLink: true });
    },
    [
      currentParsed,
      currentMatchIndex,
      queueItemMetaForIndex,
      matchMeta,
      addToQueue,
      queuedClientClipUidsGlobal,
      setProgressText,
      t,
      locale,
    ],
  );

  const handleDequeueClip = useCallback(
    (clientClipUid) => {
      removeByClientClipUid(clientClipUid);
    },
    [removeByClientClipUid],
  );

  const handleRemoveTimelineEventFromQueue = useCallback(
    (event, roundRow) => {
      if (!currentParsed) return;
      const meta = queueItemMetaForIndex(currentMatchIndex);
      const mapName = matchMeta?.map_name || "";
      const clipData = buildTimelineEventClipData({
        event,
        mapName,
        targetPlayer: meta.targetPlayer,
        round: roundRow?.round ?? event?.round,
        t,
        locale,
      });
      removeByClientClipUid(clipData.client_clip_uid);
    },
    [currentParsed, currentMatchIndex, queueItemMetaForIndex, matchMeta, removeByClientClipUid, t, locale],
  );

  const handleRemoveTimelineRoundFromQueue = useCallback(
    (roundRow) => {
      if (!currentParsed || !roundRow) return;
      const meta = queueItemMetaForIndex(currentMatchIndex);
      const mapName = matchMeta?.map_name || "";
      const clipData = buildTimelineRoundClipData({
        roundRow,
        mapName,
        targetPlayer: meta.targetPlayer,
        demoFilename: meta.demoFilename,
        t,
      });
      removeByClientClipUid(clipData.client_clip_uid);
    },
    [currentParsed, currentMatchIndex, queueItemMetaForIndex, matchMeta, removeByClientClipUid],
  );

  const persistCs2RecordExtras = useCallback(async (payload) => {
    try {
      await API.put("config", payload);
    } catch {
      /* silent */
    }
  }, []);

  savedRecordWarmupDefaultsRef.current = savedRecordWarmupDefaults;

  const persistWarmupDefaults = useCallback(async (obj) => {
    const merged = { ...(savedRecordWarmupDefaultsRef.current ?? {}), ...obj };
    setSavedRecordWarmupDefaults(merged);
    try {
      await API.put("config", { default_record_warmup: merged });
    } catch {
      /* silent */
    }
  }, []);

  const persistObsTransition = useCallback(async (data) => {
    const enabled = !!data.obs_transition_enabled;
    const name = data.obs_transition_name ?? "Fade";
    const ms = Number(data.obs_transition_duration_ms) || 100;
    setObsTransitionEnabled(enabled);
    setObsTransitionName(name);
    setObsTransitionDurationMs(ms);
    try {
      await API.put("config", {
        obs_transition_enabled: enabled,
        obs_transition_name: name,
        obs_transition_duration_ms: ms,
      });
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

  /** 常用参数页：一次性写入配置文件（替代分项防抖保存） */
  const saveAllCommonParams = useCallback(async (payload) => {
    const warmupPatch =
      payload?.default_record_warmup && typeof payload.default_record_warmup === "object"
        ? payload.default_record_warmup
        : {};
    const mergedWarmup = { ...(savedRecordWarmupDefaultsRef.current ?? {}), ...warmupPatch };
    const pacing =
      payload?.recording_global_pacing && typeof payload.recording_global_pacing === "object"
        ? payload.recording_global_pacing
        : useRecordingQueue.getState().globalPacing;
    const body = {
      default_record_warmup: mergedWarmup,
      recording_global_pacing: pacing,
      cs2_extra_launch_args: String(payload?.cs2_extra_launch_args ?? ""),
      record_inject_console_lines: String(payload?.record_inject_console_lines ?? ""),
      obs_transition_enabled: !!payload?.obs_transition_enabled,
      obs_transition_name: payload?.obs_transition_name ?? "Fade",
      obs_transition_duration_ms: Number(payload?.obs_transition_duration_ms) || 100,
      kb_overlay_enabled: !!payload?.kb_overlay_enabled,
      kb_overlay_tick_offset: Number.isInteger(payload?.kb_overlay_tick_offset) ? payload.kb_overlay_tick_offset : 6,
      kb_overlay_position: ["bottom_center", "minimap_below", "weapon_right"].includes(payload?.kb_overlay_position) ? payload.kb_overlay_position : "bottom_center",
      experimental: { pov_enabled: !!payload?.experimental_pov_enabled },
    };
    try {
      await API.put("config", body);
      await refreshCommonParamsFromServer();
      setProgressText(t("app.commonParamsSaved"), { autoDismissMs: 2800 });
      return { ok: true };
    } catch (e) {
      const detail = e.response?.data?.detail;
      const msg =
        detail != null
          ? typeof detail === "string"
            ? detail
            : JSON.stringify(detail)
          : e.message || t("app.saveFailed");
      setProgressText(t("app.commonParamsSaveFail", { msg }), { isError: true });
      return { ok: false, error: msg };
    }
  }, [setProgressText, refreshCommonParamsFromServer, t]);

  const openBatchWarmup = useCallback(async () => {
    if (!queue.length) return;
    // 每次点击开始录制时现场拉取最新状态，避免程序刚启动时 state 尚未加载而漏检
    setProgressText(t("app.checkingPlayerConfig"), { loading: true });
    try {
      const { data: cfgStatus } = await API.get("/config-backup/status");
      setConfigBackupStatus(cfgStatus && typeof cfgStatus === "object" ? cfgStatus : null);
      if (cfgStatus?.restore_required) {
        setProgressText("");
        setRecordingBlockedMessage(t("app.recordBlockedConfigNotRestored"));
        return;
      }
    } catch {
      // 获取失败时退回本地缓存，不阻断流程
      if (configBackupStatus?.restore_required) {
        setProgressText("");
        setRecordingBlockedMessage(t("app.recordBlockedConfigNotRestored"));
        return;
      }
    }
    // 调用后端配置检查：自动拉起 OBS + 15s 内重试 WebSocket 连接
    setProgressText(t("app.checkingObsConnection"), { loading: true });
    try {
      const { data } = await API.post("/obs/config-check", obsConfig);
      if (!data?.connected) {
        setProgressText(t("app.obsConnectFail"), { isError: true });
        return;
      }
    } catch (e) {
      setProgressText(t("app.obsCheckFail", { msg: e.response?.data?.detail || e.message }), { isError: true });
      return;
    }
    setQueueDrawerOpen(false);
    setWarmupIntent("batch");
    setRecordWarmupOpen(true);
    setProgressText("");
  }, [queue.length, configBackupStatus, setConfigBackupStatus, setProgressText, obsConfig, t]);

  const handleWarmupConfirm = useCallback(
    async (warmupPayload) => {
      const intent = warmupIntent;
      const { warmupForApi, session } = splitRecordWarmupConfirmPayload(warmupPayload);
      // 录制前参数为一次性配置：kb_overlay 仅作用于本次录制（见 applySessionKbOverlayToRequests），
      // 不写入配置文件。持久化仅由「录制参数配置」页的 saveAllCommonParams 负责。

      setRecordWarmupOpen(false);
      if (intent === "batch") {
        setWarmupIntent(null);
        if (!queue.length) return;
        setBatchRecording(true);
        setProgressText(t("app.preparingRecording"), { loading: true });

        // 如果启用了虚拟键盘 Overlay，轮询预构建进度并更新提示文字
        const _kbOverlayOn = session.kb_overlay_enabled;
        let _kbPollTimer = null;
        if (_kbOverlayOn) {
          _kbPollTimer = setInterval(async () => {
            try {
              const { data: kbst } = await API.get("recording/kb-prebuild-status");
              if (kbst?.active) {
                setProgressText(
                  t("app.kbPrebuildProgress", { done: kbst.done, total: kbst.total }),
                  { loading: true }
                );
              } else if (kbst?.done > 0 && !kbst?.active) {
                setProgressText(t("app.kbPrebuildReady"), { loading: true });
              }
            } catch { /* ignore */ }
          }, 1000);
        }

        try {
          let requests = buildRecordingQueueRequestsFromQueue(
            queue,
            useRecordingQueue.getState().globalPacing,
            uploadedDemos,
            parsedMatches,
            demoLibraryItems,
          );
          if (!requests.length) {
            setProgressText(t("app.queueNoRecordableClips"));
            return;
          }
          requests = applySessionObsTransitionToRequests(requests, session);
          requests = applySessionKbOverlayToRequests(requests, session);
          const povHud = session.experimental_pov_enabled
            ? {
                enabled: true,
                radar_mode: Number(warmupForApi?.pov_radar_mode ?? 0),
                teamcounter_numeric: Boolean(warmupForApi?.pov_teamcounter_numeric),
              }
            : undefined;
          const body = {
            requests,
            warmup: warmupForApi,
            obs: obsConfig,
            cs2_extra_launch_args: session.cs2_extra_launch_args,
            record_inject_console_lines: session.record_inject_console_lines,
            ...(povHud ? { pov_hud: povHud } : {}),
          };
          const { data } = await API.post("recording/queue", body);
          const results = Array.isArray(data) ? data : [];

          // Build request_id → queue item mapping for friendly names in the result modal
          const reqIdToQueueItem = {};
          requests.forEach((req) => {
            const qid = req.source_ref?.queue_item_id;
            if (qid) {
              const found = queue.find((q) => q.id === qid);
              if (found) reqIdToQueueItem[req.request_id] = found;
            }
          });

          const annotated = results.map((r, i) => ({
            ...r,
            _queueItem: reqIdToQueueItem[r?.request_id] ?? null,
            _index: i,
          }));
          const allSucceeded = results.length > 0 && results.every((r) => r && r.success);
          if (allSucceeded) clearQueue();
          setRecordingResults(annotated);
          setRecordingResultModalOpen(true);
          setProgressText("", { autoDismissMs: 100 });
        } catch (e) {
          const detail = formatRecordingApiError(e, t("common.requestFail"));
          if (e.response?.status === 409 || e.response?.status === 422) {
            setRecordingBlockedMessage(detail || t("app.recordStartFailed"));
          }
          setProgressText(t("app.batchRecordFail", { msg: detail }), { isError: true });
        } finally {
          if (_kbPollTimer) clearInterval(_kbPollTimer);
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
      refreshConfigBackupStatus,
      uploadedDemos,
      parsedMatches,
      demoLibraryItems,
      t,
    ]
  );

  const handleRestorePlayerConfig = useCallback(async () => {
    setProgressText(t("app.restoringPlayerConfig"), { loading: true });
    try {
      const { data } = await API.post("/config-backup/restore");
      if (data?.ok) {
        setProgressText(data.message || t("app.playerConfigRestored"), { autoDismissMs: 3000 });
      } else {
        setProgressText(data?.message || t("app.playerConfigRestorePartial"), { autoDismissMs: 4000 });
      }
      await refreshConfigBackupStatus();
    } catch (e) {
      const st = e.response?.status;
      const det = e.response?.data?.detail;
      if (st === 409 && det?.code === "CS2_RUNNING") {
        setRecordingBlockedMessage(
          t("app.restoreBlockedCs2Running"),
        );
      } else {
        setProgressText(t("app.restoreFail", { msg: formatRecordingApiError(e, t("common.requestFail")) }), { autoDismissMs: 5000, isError: true });
      }
      await refreshConfigBackupStatus();
    }
  }, [refreshConfigBackupStatus, t]);

  const handleOpenConfigBackupDir = useCallback(async () => {
    try {
      const { data } = await API.post("/config-backup/open-dir");
      if (data && data.ok === false && data.backup_dir) {
        setProgressText(`${data.message || t("app.openDirManual")} ${data.backup_dir}`);
      }
    } catch (e) {
      setProgressText(t("app.openBackupDirFail", { msg: formatRecordingApiError(e, t("common.requestFail")) }), { isError: true });
    }
  }, [t]);

  const handleAbortBatchRecording = useCallback(async () => {
    try {
      const { data } = await API.post("recording/abort");
      setProgressText(data?.message || t("app.abortSent"));
    } catch (e) {
      setProgressText(t("app.abortFail", { msg: e.response?.data?.detail || e.message }), { isError: true });
    }
  }, [t]);

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
          ? t("app.savedPlayersLong", { n: arr.length })
          : t("app.clearedPlayers"),
      );
    } catch (e) {
      setProgressText(t("app.savePlayersFail", { msg: e.response?.data?.detail || e.message }), { isError: true });
    }
  }, [expectedParsePlayersText, t]);

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
    const obsPath = String(o.obs_path ?? "").trim();
    if (obsPath) {
      obs.obs_path = obsPath;
    }
    try {
      await API.put("config", { obs });
      if (pw && !pw.startsWith("****")) {
        setObsHasSavedPassword(true);
        setObsPasswordEditing(false);
        setObsConfig((prev) => ({ ...prev, password: "" }));
      }
    } catch (e) {
      setProgressText(t("app.saveObsConfigFail", { msg: e.response?.data?.detail || e.message }), { isError: true });
    }
  }, [t]);

  const obsPasswordPlaceholder =
    obsHasSavedPassword && !obsPasswordEditing ? t("app.obsPasswordSaved") : "";

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
  }, [obsConfig.host, obsConfig.port, obsConfig.obs_path, persistObsConfig]);

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
      setProgressText(t("app.saveLlmConfigFail", { msg: e.response?.data?.detail || e.message }), { isError: true });
    }
  }, [t]);

  const handleAiModeChange = useCallback(
    async (next) => {
      const prev = !next;
      setAiMode(next);
      try {
        await API.put("config", { ai_mode: next });
      } catch (e) {
        setAiMode(prev);
        setProgressText(t("app.saveAiModeFail", { msg: e.response?.data?.detail || e.message }), { isError: true });
        return;
      }
      if (next) {
        await persistLlmConfig();
        setProgressText(
          t("app.aiModeOnMsg")
        );
      } else {
        setProgressText(t("app.aiModeOffMsg"));
      }
    },
    [persistLlmConfig, t]
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
        setProgressText(t("app.cs2DetectFound", { path: data.cs2_path }), { autoDismissMs: 4500 });
      }
    } catch (e) {
      const msg = e.response?.data?.detail || e.message;
      setProgressText(typeof msg === "string" ? msg : t("app.cs2DetectFail"));
    }
  }, [t]);

  const handleDetectFfmpeg = useCallback(async () => {
    try {
      const { data } = await API.post("config/detect-ffmpeg");
      if (data.ffmpeg_path) {
        setFfmpegPath(data.ffmpeg_path);
        setProgressText(t("app.ffmpegDetectFound", { path: data.ffmpeg_path }), { autoDismissMs: 4500 });
      }
    } catch (e) {
      const msg = e.response?.data?.detail || e.message;
      setProgressText(typeof msg === "string" ? msg : t("app.ffmpegDetectFail"));
    }
  }, [t]);

  const saveExpectedPlayersFromList = useCallback(async (playersList) => {
    const cleaned = Array.isArray(playersList)
      ? [...new Set(playersList.map((s) => String(s).trim()).filter(Boolean))].slice(0, 50)
      : [];
    try {
      await API.put("config", { expected_parse_players: cleaned });
      setExpectedParsePlayersText(cleaned.join("\n"));
      setProgressText(
        cleaned.length ? t("app.savedPlayers", { n: cleaned.length }) : t("app.clearedPlayers"),
        { autoDismissMs: 2500 },
      );
    } catch (e) {
      setProgressText(t("app.savePlayersFail", { msg: e.response?.data?.detail || e.message }), { isError: true });
    }
  }, [t]);

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
          expected_parse_players: arr,
        });
        setExpectedParsePlayersText(arr.join("\n"));
        await persistLlmConfig();
        setProgressText(t("app.settingsSaved"), { autoDismissMs: 2200 });
      } catch (e) {
        setProgressText(t("app.settingsSaveFail", { msg: e.response?.data?.detail || e.message }), { isError: true });
      }
    },
    [cs2Path, ffmpegPath, montageEncoder, persistLlmConfig, setExpectedParsePlayersText, t],
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
      setProgressText(t("app.configExportDone"), { autoDismissMs: 3500 });
    } catch (e) {
      setProgressText(t("app.configExportFail", { msg: e.response?.data?.detail || e.message }), { isError: true });
    }
  }, [t]);

  const applyImportedSettings = useCallback(async (raw) => {
    if (!raw || typeof raw !== "object") {
      setProgressText(t("app.configImportInvalidJson"));
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
      if (typeof raw.cs2_extra_launch_args === "string") {
        const launchArgsUserConfigured =
          typeof raw.cs2_extra_launch_args_user_configured === "boolean"
            ? raw.cs2_extra_launch_args_user_configured
            : false;
        const launchArgs = launchArgsUserConfigured
          ? raw.cs2_extra_launch_args
          : ensureDefaultCs2FullscreenArg(raw.cs2_extra_launch_args);
        put.cs2_extra_launch_args = launchArgs;
        put.cs2_extra_launch_args_user_configured = launchArgsUserConfigured;
        setCs2ExtraLaunchArgs(launchArgs);
      } else if (typeof raw.cs2_extra_launch_args_user_configured === "boolean") {
        put.cs2_extra_launch_args_user_configured = raw.cs2_extra_launch_args_user_configured;
      }
      if (Object.keys(put).length) {
        await API.put("config", put);
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
      setProgressText(t("app.configImportDone"), { autoDismissMs: 2800 });
    } catch (e) {
      setProgressText(t("app.configImportFail", { msg: e.response?.data?.detail || e.message }), { isError: true });
    }
  }, [t]);

  const handleResetSettingsDefaults = useCallback(async () => {
    if (
      !window.confirm(t("app.resetSettingsConfirm"))
    ) {
      return;
    }
    const defaults = {
      cs2_path: "",
      ffmpeg_path: "",
      update_github_mirror: "auto",
      montage_encoder: "auto",
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
      setUpdateGithubMirror("auto");
      setUpdateGithubMirrorCustom("");
      setMontageEncoder("auto");
      setAiMode(false);
      setExpectedParsePlayersText("");
      setLlmConfig({
        model: "",
        api_key: "",
        base_url: "",
      });
      setProgressText(t("app.resetSettingsDone"), { autoDismissMs: 3000 });
    } catch (e) {
      setProgressText(t("app.resetSettingsFail", { msg: e.response?.data?.detail || e.message }), { isError: true });
    }
  }, [t]);

  const handleOpenConfigDataDir = useCallback(async () => {
    try {
      const { data } = await API.post("config/open-dir");
      if (data?.ok === false) {
        setProgressText(`${data.message || t("app.openDirFailed")} ${data.path || ""}`.trim());
      }
    } catch (e) {
      setProgressText(t("app.openConfigDirFail", { msg: e.response?.data?.detail || e.message }), { isError: true });
    }
  }, [t]);

  const handleTestLlmConnection = useCallback(async () => {
    await persistLlmConfig();
    try {
      const { data } = await API.post("config/test-llm");
      if (data?.ok) {
        setProgressText(t("app.aiTestOk") + (data.detail ? `：${data.detail}` : ""), { autoDismissMs: 4000 });
      } else {
        setProgressText(t("app.aiTestFail", { msg: data?.detail || t("app.unknownError") }), { isError: true });
      }
    } catch (e) {
      setProgressText(t("app.aiTestRequestFail", { msg: e.response?.data?.detail || e.message }), { isError: true });
    }
  }, [persistLlmConfig, t]);

  const fetchUpdateInfo = useCallback(async (opts = { force: false, manual: false }) => {
    try {
      const { data } = await API.get("/app/update-info", {
        params: opts.force ? { force: "true" } : {},
        timeout: 15000,
      });
      setUpdateInfo(data);
      if (data?.update_available) {
        setUpdateModalManual(Boolean(opts.manual));
        setUpdateModalOpen(true);
      } else if (opts.manual) {
        setUpdateModalManual(true);
        setUpdateModalOpen(true);
      }
    } catch {
      if (opts.manual) {
        setUpdateInfo({
          error: t("app.updateConnectFail"),
          current_version: "",
          latest_version: null,
          update_available: false,
          release_notes: "",
          release_url: "",
          downloads: { setup_url: null, zip_url: null },
        });
        setUpdateModalManual(true);
        setUpdateModalOpen(true);
      }
    }
  }, [t]);

  useEffect(() => {
    void fetchUpdateInfo({ force: false, manual: false });
  }, [fetchUpdateInfo]);

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
    updateGithubMirror,
    setUpdateGithubMirror,
    updateGithubMirrorCustom,
    setUpdateGithubMirrorCustom,
    montageEncoder,
    setMontageEncoder,
    demoWatchPaths,
    setDemoWatchPaths,
    handleSaveConfig,
    fetchUpdateInfo,
    handleDetectCs2,
    handleDetectFfmpeg,
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
    saveAllCommonParams,
    commonParamsRefreshKey,
    cs2ExtraLaunchArgs,
    recordInjectConsoleLines,
    experimentalPovEnabled,
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
    handleDequeueClip,
    handleRemoveTimelineEventFromQueue,
    handleRemoveTimelineRoundFromQueue,
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
    handleDeleteDemoFile,
    handleLibraryBatchDelete,
    setProgressText,
    handleSaveLibraryRename,
    setLibraryRename,
    setLibraryDeletePrompt,
    libraryRename,
    libraryDeletePrompt,
    configBackupStatus,
    configBackupLoading,
    refreshConfigBackupStatus,
    handleRestorePlayerConfig,
    handleOpenConfigBackupDir,
    obsTransitionEnabled,
    obsTransitionName,
    obsTransitionDurationMs,
    kbOverlayEnabled,
    kbOverlayTickOffset,
    kbOverlayPosition,
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
      <div className="relative flex flex-col h-screen overflow-hidden bg-cs2-bg-dark">
        <CustomTitleBar />
        <div className="relative flex flex-1 overflow-hidden">
          {libraryLoadingOverlay && (
            <div className="absolute inset-0 z-[70] flex items-center justify-center bg-black/55 backdrop-blur-[1px]">
              <div className="flex items-center gap-3 rounded-lg border border-white/10 bg-cs2-bg-card px-4 py-3 shadow-2xl">
                <Loader2 className="h-5 w-5 animate-spin text-cs2-orange" />
                <p className="text-sm font-medium text-dynamic-zinc-200">{libraryLoadingText}</p>
              </div>
            </div>
          )}
          <SidebarNav
            queueLength={queue.length}
            disabled={batchRecording}
            onCheckUpdate={() => void fetchUpdateInfo({ force: true, manual: true })}
          />
          <main className="flex min-w-0 flex-1 flex-col overflow-hidden relative">
            {!backendReady ? (
              <div className="absolute inset-0 z-50 flex flex-col items-center justify-center bg-cs2-bg-dark/80 backdrop-blur-sm">
                <div className="flex flex-col items-center gap-6 p-8 rounded-2xl border border-white/5 bg-cs2-bg-card shadow-2xl">
                  <div className="relative">
                    <Loader2 className="h-12 w-12 animate-spin text-cs2-orange" />
                    <div className="absolute inset-0 animate-ping rounded-full bg-cs2-orange/20" />
                  </div>
                  <div className="flex flex-col items-center gap-2">
                    <h2 className="text-xl font-bold tracking-tight text-dynamic-white">{t("app.backendConnecting")}</h2>
                    <p className="text-sm text-dynamic-zinc-400">{t("app.backendStarting")}</p>
                  </div>
                  <div className="flex items-center gap-2 px-3 py-1.5 rounded-full bg-black/40 border border-white/5">
                    <div className="w-1.5 h-1.5 rounded-full bg-cs2-orange animate-pulse" />
                    <span className="text-[10px] font-mono text-zinc-500 uppercase tracking-widest">
                      Attempting to connect: {BACKEND_CONNECT_LABEL}
                    </span>
                  </div>
                </div>
              </div>
            ) : null}

            <div className="flex min-h-0 flex-1 flex-col overflow-hidden">
              <Routes>
                <Route path="/" element={<GuidePage />} />
                <Route path="/library" element={<DemoLibraryPage />} />
                <Route path="/analysis" element={<AnalysisPage />} />
                <Route path="/queue" element={<RecordingQueuePage />} />
                <Route path="/montage" element={<MontageWorkbenchPage />} />
                <Route path="/params" element={<RecordingParamsPage />} />
                <Route path="/obs-config-center" element={<ObsConfigCenterPage />} />
                <Route path="/settings" element={<SettingsPage />} />
                <Route path="/player-game-config" element={<PlayerGameConfigPage />} />
                <Route path="/match-history" element={<MatchHistoryPage />} />
                <Route path="*" element={<Navigate to="/" replace />} />
              </Routes>
            </div>
          </main>
        </div>

        {showGlobalNotice ? (
          <div
            className="pointer-events-none fixed inset-x-0 bottom-0 z-[60] flex justify-center px-4 pb-[max(1rem,env(safe-area-inset-bottom))] pt-2 sm:px-6"
            aria-live="polite"
          >
            <div className="pointer-events-auto w-full max-w-lg shadow-2xl shadow-black/50">
              <ProgressBar
                text={progressText || (batchRecording ? t("app.batchRecording") : "")}
                active={progressToastShowsBusy(progressText, {
                  parsing: anyDemoParsing,
                  loading: progressToastMeta?.loading === true,
                })}
                batchRecording={batchRecording}
                onAbortBatch={handleAbortBatchRecording}
                dismissible={Boolean(progressText?.trim())}
                onDismiss={() => setProgressText("")}
                autoDismissAfterMs={progressToastMeta?.autoDismissMs ?? undefined}
                showQueueNavigate={Boolean(progressToastMeta?.queueLink)}
                isError={progressToastMeta?.isError === true}
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
          cs2ExtraLaunchArgs={cs2ExtraLaunchArgs}
          recordInjectConsoleLines={recordInjectConsoleLines}
          initObsTransEnabled={obsTransitionEnabled}
          initObsTransName={obsTransitionName}
          initObsTransDurationMs={obsTransitionDurationMs}
          initKbOverlayEnabled={kbOverlayEnabled}
          initKbOverlayTickOffset={kbOverlayTickOffset}
          initKbOverlayPosition={kbOverlayPosition}
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
        <BatchLoadErrorModal
          open={batchLoadError.open}
          failed={batchLoadError.failed}
          onClose={() => setBatchLoadError({ open: false, failed: [] })}
        />

        <RecordingResultModal
          open={recordingResultModalOpen}
          onClose={() => setRecordingResultModalOpen(false)}
          onClearQueue={() => {
            clearQueue();
            setRecordingResultModalOpen(false);
          }}
          results={recordingResults ?? []}
        />

        <RecordingBlockedDialog
          message={recordingBlockedMessage}
          onClose={() => setRecordingBlockedMessage("")}
        />

        <UpdateCheckModal
          open={updateModalOpen}
          info={updateInfo}
          manual={updateModalManual}
          title={updateModalManual ? t("app.checkUpdate") : t("app.updateFound")}
          onClose={() => {
            setUpdateModalOpen(false);
            setUpdateModalManual(false);
          }}
        />
      </div>
    </AppShellProvider>
  );
}
