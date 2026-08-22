import { lazy, Suspense, useState, useCallback, useMemo, useEffect, useRef } from "react";
import { Routes, Route, Navigate, useNavigate, useLocation } from "react-router-dom";
import { AppShellProvider } from "./context/AppShellContext";
import UpdateCheckModal from "./components/UpdateCheckModal";
import RecordingBlockedDialog from "./components/RecordingBlockedDialog";
import RecordingResultModal from "./components/recordingQueue/RecordingResultModal";
import RecordingProgressModal from "./components/recordingQueue/RecordingProgressModal";
import RecordWarmupModal from "./components/RecordWarmupModal";
import ProgressBar from "./components/ProgressBar";
import BatchLoadErrorModal from "./components/BatchLoadErrorModal";
import DemoLoadingCopy from "./components/DemoLoadingCopy";
import { useRecordingQueue } from "./stores/recordingQueueStore";
import { useLocaleStore } from "./i18n/localeStore";
import { useT } from "./i18n/useT.js";
import { ensureClientClipUidsOnClips } from "./utils/clipClientUid";
import {
  isFreezeToDeathCompilation,
} from "./utils/freezeToDeathRoundFilter";
import { progressToastShowsBusy } from "./utils/progressToast";
import { playerIdentityKey } from "./utils/playerIdentity.js";
import { useDemoAnalysisWorkflows } from "./features/demo-analysis/useDemoAnalysisWorkflows";
import { useDemoLibraryController } from "./features/demo-library/useDemoLibraryController";
import { useClipQueueActions } from "./features/recording-queue/useClipQueueActions";
import { useRecordingSessionController } from "./features/recording-queue/useRecordingSessionController";
import { shouldCheckAppUpdates } from "./utils/shouldCheckAppUpdates";
import { createDesktopUpdateCheck } from "./utils/desktopUpdater";
import { desktopBridge } from "./desktop/desktopBridge.js";
import { Loader2 } from "lucide-react";
import API, { BACKEND_CONNECT_LABEL } from "./api/api";

import CustomTitleBar from "./components/CustomTitleBar";
import SidebarNav from "./components/SidebarNav";

const GuidePage = lazy(() => import("./pages/GuidePage"));
const DemoLibraryPage = lazy(() => import("./features/demo-library/DemoLibraryPage"));
const DemoAnalysisPage = lazy(() => import("./features/demo-analysis/DemoAnalysisPage"));
const RecordingQueuePage = lazy(() => import("./pages/RecordingQueuePage"));
const MontageWorkbenchPage = lazy(() => import("./pages/MontageWorkbenchPage"));
const LiteCutEditorPage = lazy(() => import("./features/lite-cut/pages/LiteCutEditorPage"));
const LiteCutExportPage = lazy(() => import("./features/lite-cut/pages/LiteCutExportPage"));
const RecordingParamsPage = lazy(() => import("./pages/RecordingParamsPage"));
const SettingsPage = lazy(() => import("./pages/SettingsPage"));
const PlayerGameConfigPage = lazy(() => import("./pages/PlayerGameConfigPage"));
const MatchHistoryPage = lazy(() => import("./pages/MatchHistoryPage"));
const ObsAiTuningPreviewPage = lazy(() => import("./pages/ObsAiTuningPreviewPage"));
const ObsAiEntryPreviewPage = lazy(() => import("./pages/ObsAiEntryPreviewPage"));
const CosmeticsWorkshopPage = lazy(() => import("./features/cosmetics-workshop/CosmeticsWorkshopPage"));

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
  /** 后端就绪后的启动流程：先检查更新，再拉取首页配置检查 */
  const [startupInitDone, setStartupInitDone] = useState(false);
  const [startupInitPhase, setStartupInitPhase] = useState(/** @type {"update" | "config" | null} */ (null));
  const [initialQuickCheckStatus, setInitialQuickCheckStatus] = useState(null);
  const startupInitStartedRef = useRef(false);
  const startupUpdateWaitRef = useRef(/** @type {(() => void) | null} */ (null));
  const [aiMode, setAiMode] = useState(false);

  const [obsConfig, setObsConfig] = useState({ host: "localhost", port: 4455, password: "", obs_path: "" });
  /** 服务器是否已有 OBS 密码（GET /api/config 返回脱敏或本地刚保存成功） */
  const [obsHasSavedPassword, setObsHasSavedPassword] = useState(false);
  /** 用户是否正在编辑密码框（用于失焦时恢复“已保存”提示） */
  const [obsPasswordEditing, setObsPasswordEditing] = useState(false);
  const [updateInfo, setUpdateInfo] = useState(null);
  const [updateModalOpen, setUpdateModalOpen] = useState(false);
  const [updateModalManual, setUpdateModalManual] = useState(false);
  const updateCheckOptsRef = useRef({ manual: false, awaitDismiss: false });
  /** 当前活跃的 Tauri updater 控制器；旧控制器的迟到状态会被忽略 */
  const updateControllerRef = useRef(null);
  /** 用户点「关闭」后忽略后续 cancelled 重开弹窗 */
  const updateModalDismissedRef = useRef(false);
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
  const autoParseLoadedDemosRef = useRef(null);

  /** 每场 Demo 独立的多选玩家列表（索引 -> string[]） */
  const [selectedPlayers, setSelectedPlayers] = useState({});
  /** 每场「回合合集」勾选：空 → 请求里发 null（整局合规非赛后）；非空 → 只解析所选回合 */
  const [freezeToDeathRoundsByMatch, setFreezeToDeathRoundsByMatch] = useState({});

  /** 当前 Demo 正在查看的玩家 Tab（索引 -> playerName） */
  const [activePlayerTabs, setActivePlayerTabs] = useState({});

  /** 与 clip.client_clip_uid 对应（非后端 clip_id） */
  const [selectedClientClipUids, setSelectedClientClipUids] = useState(new Set());

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

  /** 来自 data/cs2-insight.config.json（或 CS2_INSIGHT_CONFIG），打开录制预热对话框时作为初始选项 */
  const [savedRecordWarmupDefaults, setSavedRecordWarmupDefaults] = useState(null);
  const savedRecordWarmupDefaultsRef = useRef(null);
  const queuePacingInitializedRef = useRef(false);
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
  const [killFxEnabled, setKillFxEnabled] = useState(false);
  const [killFxTickOffset, setKillFxTickOffset] = useState(6);
  /** 保存或拉取配置后递增，驱动常用参数页表单重新灌入 */
  const [commonParamsRefreshKey, setCommonParamsRefreshKey] = useState(0);
  const [cs2Path, setCs2Path] = useState("");
  const [ffmpegPath, setFfmpegPath] = useState("");
  const [montageEncoder, setMontageEncoder] = useState("auto");
  const [demoWatchPaths, setDemoWatchPaths] = useState([]);
  const [demoWatchScanDepth, setDemoWatchScanDepth] = useState(2);
  const [expectedParsePlayersText, setExpectedParsePlayersText] = useState("");
  const {
    demoLibraryItems,
    libraryLoading,
    libraryScanning,
    libraryLoadingOverlay,
    libraryLoadingText,
    libraryPage,
    setLibraryPage,
    libraryHasNextPage,
    libraryTotal,
    selectedLibraryDemoIds,
    setSelectedLibraryDemoIds,
    libraryDemoIdsByIndex,
    setLibraryDemoIdsByIndex,
    libraryRename,
    setLibraryRename,
    libraryDeletePrompt,
    setLibraryDeletePrompt,
    librarySearchInput,
    setLibrarySearchInput,
    librarySearchQ,
    setLibrarySearchQ,
    libraryAdvFilters,
    setLibraryAdvFilters,
    libraryJumpDraft,
    setLibraryJumpDraft,
    libraryPageSize,
    setLibraryPageSize,
    libraryTotalPages,
    batchLoadError,
    setBatchLoadError,
    hasLibraryAdvancedFilters,
    refreshDemoLibrary,
    handleLibrarySearchSubmit,
    handleLibraryPageJump,
    handleScanDemos,
    handleDeleteDemo,
    handleDeleteDemoFile,
    handleLibraryBatchDelete,
    handleSaveLibraryRename,
    handleLoadDemoFromLibrary,
    handleLoadSelectedLibraryDemos,
    selectLibraryPage,
    selectAllLibraryDemos,
    clearLibrarySelection,
  } = useDemoLibraryController({
    t,
    navigate,
    setProgressText,
    startupInitDone,
    analysis: {
      autoParseLoadedDemosRef,
      setUploadedDemos,
      setParsedMatches,
      setCurrentMatchIndex,
      setSelectedPlayers,
      setActivePlayerTabs,
      setFreezeToDeathRoundsByMatch,
      setSelectedClientClipUids,
    },
  });
  const {
    parsing,
    parsingByIndex,
    analysisInlineProgress,
    aiReviewingPlayers,
    handleUpload,
    handleParse,
    ensurePlayerAiReview,
    resetAnalysisWorkflow,
  } = useDemoAnalysisWorkflows({
    t,
    navigate,
    setProgressText,
    setBatchLoadError,
    aiMode,
    uploadedDemos,
    setUploadedDemos,
    parsedMatches,
    setParsedMatches,
    currentMatchIndex,
    setCurrentMatchIndex,
    selectedPlayers,
    setSelectedPlayers,
    freezeToDeathRoundsByMatch,
    setFreezeToDeathRoundsByMatch,
    setActivePlayerTabs,
    setSelectedClientClipUids,
    libraryDemoIdsByIndex,
    setLibraryDemoIdsByIndex,
    autoParseLoadedDemosRef,
  });
  const [llmKeySavedOnServer, setLlmKeySavedOnServer] = useState(false);
  const llmConfigRef = useRef(llmConfig);
  llmConfigRef.current = llmConfig;

  const queue           = useRecordingQueue((s) => s.queue);
  const addToQueue      = useRecordingQueue((s) => s.addToQueue);
  const removeFromQueue        = useRecordingQueue((s) => s.removeFromQueue);
  const removeByClientClipUid  = useRecordingQueue((s) => s.removeByClientClipUid);
  const clearQueue             = useRecordingQueue((s) => s.clearQueue);
  const globalPacing    = useRecordingQueue((s) => s.globalPacing);

  const {
    batchRecording,
    recordingAbortRequested,
    recordingResults,
    recordingResultModalOpen,
    recordingBlockedMessage,
    recordingBlockedCode,
    recordingRecoveryPrompt,
    recordWarmupOpen,
    configBackupStatus,
    configBackupLoading,
    refreshConfigBackupStatus,
    openBatchWarmup,
    handleWarmupConfirm,
    handleRestorePlayerConfig,
    handleOpenConfigBackupDir,
    handleAbortBatchRecording,
    dismissWarmup,
    closeRecordingResults,
    clearRecordingResultsAndQueue,
    clearRecordingBlock,
  } = useRecordingSessionController({
    t,
    setProgressText,
    setQueueDrawerOpen,
    queue,
    clearQueue,
    obsConfig,
    uploadedDemos,
    parsedMatches,
    demoLibraryItems,
  });

  const currentUpload = uploadedDemos?.[currentMatchIndex] ?? null;
  const currentParsed = parsedMatches?.[currentMatchIndex] ?? null;

  // ── 当前场次已解析的玩家列表 ──
  const parsedPlayerNames = useMemo(
    () => Object.keys(currentParsed?.players ?? {}),
    [currentParsed]
  );

  const players = currentUpload?.players ?? [];
  const rosterPlayerNames = players
    .map(playerIdentityKey)
    .map((name) => String(name).trim())
    .filter(Boolean);
  const availablePlayerNames = rosterPlayerNames.length ? rosterPlayerNames : parsedPlayerNames;

  // ── 当前 Tab 内的活跃玩家（无有效记忆时自然落到阵容首位，不触发 AI 请求） ──
  const requestedActivePlayer = String(activePlayerTabs[currentMatchIndex] ?? "").trim();
  const currentActivePlayer = availablePlayerNames.includes(requestedActivePlayer)
    ? requestedActivePlayer
    : (availablePlayerNames[0] ?? "");

  const activePlayerData = currentParsed?.players?.[currentActivePlayer] ?? null;
  const analysisWorkspace = currentParsed?.analysis_workspace ?? null;
  const clips = activePlayerData?.clips ?? [];
  const timeline = activePlayerData?.timeline ?? null;
  const roundTimeline = activePlayerData?.round_timeline ?? null;
  const matchMeta = activePlayerData?.match_meta ?? currentUpload?.match_meta ?? null;

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


  const anyDemoParsing = useMemo(
    () => parsing || Object.values(parsingByIndex).some(Boolean),
    [parsing, parsingByIndex]
  );

  const currentDemoFilename = currentParsed?.demo_filename ?? currentUpload?.filename ?? "";
  const {
    queuedClientClipUidsForCurrentDemo,
    regularSelectableTotal,
    selectedRegularCount,
    canAddCurrentPlayerHighlights,
    canAddCurrentPlayerFails,
    handleToggleClip,
    handleSelectAll,
    handleDeselectAll,
    handleAddSelectedToQueue,
    handleAddCurrentPlayerHighlights,
    handleAddCurrentPlayerFails,
    handleAddTimelineEventToQueue,
    handleAddTimelineRoundToQueue,
    handleAddTimelineEventsBatchToQueue,
    handleAddWeaponKillsToQueue,
    handleDequeueClip,
    handleRemoveTimelineEventFromQueue,
    handleRemoveTimelineRoundFromQueue,
  } = useClipQueueActions({
    t,
    locale,
    setProgressText,
    queue,
    addToQueue,
    removeByClientClipUid,
    uploadedDemos,
    parsedMatches,
    currentMatchIndex,
    currentParsed,
    currentActivePlayer,
    matchMeta,
    activePlayerTabs,
    selectedPlayers,
    clips,
    freezeToDeathDraft,
    selectedClientClipUids,
    setSelectedClientClipUids,
    currentDemoFilename,
  });

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
    if (typeof data.kill_fx_enabled === "boolean") {
      setKillFxEnabled(data.kill_fx_enabled);
    }
    if (typeof data.kill_fx_tick_offset === "number") {
      setKillFxTickOffset(data.kill_fx_tick_offset);
    }
    if (data.experimental && typeof data.experimental.pov_enabled === "boolean") {
      setExperimentalPovEnabled(data.experimental.pov_enabled);
    }
    const savedPacing =
      data.recording_global_pacing &&
      typeof data.recording_global_pacing === "object" &&
      !Array.isArray(data.recording_global_pacing)
        ? data.recording_global_pacing
        : {};
    const queueStore = useRecordingQueue.getState();
    queueStore.hydratePresetPacing(savedPacing);
    if (!queuePacingInitializedRef.current) {
      queueStore.hydrateGlobalPacing(savedPacing);
      queuePacingInitializedRef.current = true;
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
          if (typeof data.montage_encoder === "string" && data.montage_encoder.trim()) {
            setMontageEncoder(data.montage_encoder.trim().toLowerCase());
          }
          if (Array.isArray(data.demo_watch_paths)) setDemoWatchPaths(data.demo_watch_paths);
          if (Number.isInteger(data.demo_watch_scan_depth)) setDemoWatchScanDepth(data.demo_watch_scan_depth);
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

  // 全局节奏改由「常用参数」页顶「保存」写入配置；录制队列抽屉内微调仍只改内存，刷新后以配置文件为准。

  savedRecordWarmupDefaultsRef.current = savedRecordWarmupDefaults;

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
        : useRecordingQueue.getState().presetPacing;
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
      kill_fx_enabled: !!payload?.kill_fx_enabled,
      kill_fx_tick_offset: Number.isInteger(payload?.kill_fx_tick_offset) ? payload.kill_fx_tick_offset : 6,
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

  const handleSaveConfig = useCallback(async (config) => {
    try {
      await API.put("config", config);
      return true;
    } catch (error) {
      setProgressText(t("app.saveConfigFail", { msg: error?.response?.data?.detail || error?.message || t("common.requestFail") }), { isError: true });
      return false;
    }
  }, [t]);

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
    resetAnalysisWorkflow();
  }, [resetAnalysisWorkflow, setLibraryDemoIdsByIndex, setProgressText]);

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
      if (Number.isInteger(raw.demo_watch_scan_depth)) {
        put.demo_watch_scan_depth = Math.max(0, Math.min(32, raw.demo_watch_scan_depth));
        setDemoWatchScanDepth(put.demo_watch_scan_depth);
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

  const waitForUpdateModalDismiss = useCallback(
    () =>
      new Promise((resolve) => {
        startupUpdateWaitRef.current = resolve;
      }),
    [],
  );

  const markUpdateChecked = useCallback(async () => {
    const checkedAt = new Date().toISOString();
    try {
      await API.put("config", { last_update_check_at: checkedAt });
    } catch {
      // ignore persistence failures
    }
  }, []);

  const handleUpdateModalClose = useCallback(() => {
    const st = String(updateInfo?.status || "");
    const isForce = String(updateInfo?.update_mode || "").toLowerCase() === "force";
    // force：发现更新后或下载中不可关闭
    if (isForce && (st === "available" || st === "downloading" || st === "downloaded")) {
      return;
    }
    updateModalDismissedRef.current = true;
    if (st === "checking" || st === "available") {
      if (typeof updateControllerRef.current?.defer === "function") {
        updateControllerRef.current.defer();
      } else {
        updateControllerRef.current?.cancel();
      }
    }
    setUpdateModalOpen(false);
    setUpdateModalManual(false);
    const resume = startupUpdateWaitRef.current;
    startupUpdateWaitRef.current = null;
    resume?.();
  }, [updateInfo?.status, updateInfo?.update_mode]);

  const handleUpdateConfirm = useCallback(() => {
    updateControllerRef.current?.confirm?.();
  }, []);

  const handleUpdateCancel = useCallback(() => {
    // 「停止更新」：仅 normal；下载开始后无法真正打断
    if (String(updateInfo?.update_mode || "").toLowerCase() === "force") return;
    updateModalDismissedRef.current = false;
    updateControllerRef.current?.cancel();
  }, [updateInfo?.update_mode]);

  /** Cloudflare R2 + Tauri updater（不走 GitHub /api/app/update-info） */
  const fetchUpdateInfo = useCallback(
    async (opts = { manual: false, awaitDismiss: false }) => {
      const manual = Boolean(opts.manual);
      const awaitDismiss = Boolean(opts.awaitDismiss);

      if (!(await shouldCheckAppUpdates())) {
        if (manual) {
          setUpdateInfo({
            status: "error",
            error: t("settings.updateDevModeError"),
            current_version: "",
            latest_version: null,
            update_mode: "normal",
          });
          setUpdateModalManual(true);
          setUpdateModalOpen(true);
        }
        return;
      }

      updateCheckOptsRef.current = { manual, awaitDismiss };
      updateModalDismissedRef.current = false;

      let currentVersion = "";
      try {
        currentVersion = String((await desktopBridge?.getVersion()) || "");
      } catch {
        currentVersion = "";
      }

      updateControllerRef.current?.cancel();

      const controller = createDesktopUpdateCheck((statusPayload) => {
        if (updateControllerRef.current !== controller) return;
        const status = String(statusPayload?.status || "");
        const incomingLatest =
          statusPayload?.latest_version || statusPayload?.info?.version || null;
        const incomingNotes =
          typeof statusPayload?.release_notes === "string"
            ? statusPayload.release_notes
            : typeof statusPayload?.info?.releaseNotes === "string"
              ? statusPayload.info.releaseNotes
              : "";
        const incomingMode =
          statusPayload?.update_mode || statusPayload?.info?.update_mode || null;
        setUpdateInfo((prev) => ({
          status,
          current_version: currentVersion || prev?.current_version || "",
          latest_version: incomingLatest || prev?.latest_version || null,
          release_notes: incomingNotes || prev?.release_notes || "",
          update_mode: incomingMode || prev?.update_mode || "normal",
          progress: statusPayload?.progress || null,
          error:
            statusPayload?.error === "dev-mode"
              ? t("settings.updateDevModeError")
              : statusPayload?.error
                ? String(statusPayload.error)
                : "",
        }));

        const isManual = Boolean(updateCheckOptsRef.current.manual);

        if (status === "checking") {
          if (isManual) {
            setUpdateModalManual(true);
            setUpdateModalOpen(true);
          }
          return;
        }

        if (status === "available" || status === "downloading" || status === "downloaded") {
          if (status === "available") void markUpdateChecked();
          setUpdateModalManual(isManual);
          setUpdateModalOpen(true);
          return;
        }

        if (status === "cancelled") {
          if (updateModalDismissedRef.current) {
            setUpdateModalOpen(false);
            const resume = startupUpdateWaitRef.current;
            startupUpdateWaitRef.current = null;
            resume?.();
            return;
          }
          if (isManual) {
            setUpdateModalManual(true);
            setUpdateModalOpen(true);
          } else {
            setUpdateModalOpen(false);
            const resume = startupUpdateWaitRef.current;
            startupUpdateWaitRef.current = null;
            resume?.();
          }
          return;
        }

        if (status === "not-available") {
          void markUpdateChecked();
          if (isManual) {
            setUpdateModalManual(true);
            setUpdateModalOpen(true);
          } else {
            const resume = startupUpdateWaitRef.current;
            startupUpdateWaitRef.current = null;
            resume?.();
          }
          return;
        }

        if (status === "error") {
          if (isManual) {
            setUpdateModalManual(true);
            setUpdateModalOpen(true);
          } else {
            const resume = startupUpdateWaitRef.current;
            startupUpdateWaitRef.current = null;
            resume?.();
          }
        }
      });
      updateControllerRef.current = controller;

      setUpdateInfo({
        status: "checking",
        current_version: currentVersion,
        latest_version: null,
        release_notes: "",
        update_mode: "normal",
        error: "",
      });
      if (manual) {
        setUpdateModalManual(true);
        setUpdateModalOpen(true);
      }

      const dismissWait = awaitDismiss ? waitForUpdateModalDismiss() : null;
      controller.start();
      if (dismissWait) await dismissWait;
    },
    [t, waitForUpdateModalDismiss, markUpdateChecked],
  );

  useEffect(() => {
    return () => {
      updateControllerRef.current?.cancel();
      updateControllerRef.current = null;
    };
  }, []);

  useEffect(() => {
    if (!backendReady || startupInitStartedRef.current) return;
    startupInitStartedRef.current = true;

    let cancelled = false;
    const runStartupInit = async () => {
      try {
        if ((await shouldCheckAppUpdates())) {
          setStartupInitPhase("update");
          await fetchUpdateInfo({ manual: false, awaitDismiss: true });
          if (cancelled) return;
        }

        setStartupInitPhase("config");
        try {
          const { data } = await API.get("/config/quick-check");
          if (!cancelled) setInitialQuickCheckStatus(data);
        } catch {
          if (!cancelled) setInitialQuickCheckStatus(null);
        }
      } finally {
        if (!cancelled) {
          setStartupInitPhase(null);
          setStartupInitDone(true);
        }
      }
    };

    void runStartupInit();
    return () => {
      cancelled = true;
    };
  }, [backendReady, fetchUpdateInfo]);

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
    demoWatchPaths,
    setDemoWatchPaths,
    demoWatchScanDepth,
    setDemoWatchScanDepth,
    handleSaveConfig,
    fetchUpdateInfo,
    startupInitDone,
    initialQuickCheckStatus,
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
    recordingAbortRequested,
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
    analysisWorkspace,
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
    handleAddWeaponKillsToQueue,
    handleDequeueClip,
    handleRemoveTimelineEventFromQueue,
    handleRemoveTimelineRoundFromQueue,
    selectedClientClipUids,
    handleToggleClip,
    queuedClientClipUidsForCurrentDemo,
    parsedPlayerNames,
    currentActivePlayer,
    setActivePlayerTabs,
    ensurePlayerAiReview,
    aiReviewingPlayers,
    roundMontageMaxRounds,
    freezeToDeathDraft,
    setFreezeToDeathDraft,
    selectedRegularCount,
    regularSelectableTotal,
    handleSelectAll,
    handleDeselectAll,
    handleAddSelectedToQueue,
    handleAddCurrentPlayerHighlights,
    handleAddCurrentPlayerFails,
    canAddCurrentPlayerHighlights,
    canAddCurrentPlayerFails,
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
    killFxEnabled,
    killFxTickOffset,
  };

  const parsingShownInline =
    location.pathname === "/analysis" &&
    (parsing || anyDemoParsing || analysisInlineProgress?.active === true);

  const showGlobalNotice = !batchRecording && (
    (Boolean(progressText?.trim()) && !parsingShownInline) ||
    (anyDemoParsing && !parsingShownInline)
  );
  const globalNoticeText = progressText
    || (batchRecording ? t("app.batchRecording") : "")
    || (analysisInlineProgress?.active === true ? analysisInlineProgress.text : "")
    || (anyDemoParsing ? t("analysis.parsing") : "");
  const isStandalonePreview = [
    "/obs-ai-preview",
    "/obs-ai-entry-preview",
    "/cosmetics-workshop",
  ].includes(location.pathname);

  return (
    <AppShellProvider value={shell}>
      <div className="relative flex h-screen overflow-hidden bg-cs2-bg-page">
        <SidebarNav queueLength={queue.length} disabled={batchRecording} />
        <div className="flex min-w-0 flex-1 flex-col overflow-hidden">
          <CustomTitleBar />
          <div className="relative flex min-h-0 flex-1 overflow-hidden">
          {libraryLoadingOverlay && (
            <div className="absolute inset-0 z-[120] flex items-center justify-center bg-black/55 backdrop-blur-[1px]">
              <div className="flex items-center gap-3 rounded-lg border border-white/10 bg-cs2-bg-card px-4 py-3 shadow-2xl">
                <Loader2 className="h-5 w-5 shrink-0 animate-spin text-cs2-orange" />
                <DemoLoadingCopy detail={libraryLoadingText} aiEnabled={aiMode} compact />
              </div>
            </div>
          )}
          <main className="flex min-w-0 flex-1 flex-col overflow-hidden relative">
            {!isStandalonePreview && (!backendReady ? (
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
                  <div className="flex items-center gap-2 rounded-full border border-cs2-border bg-cs2-bg-input px-3 py-1.5">
                    <div className="h-1.5 w-1.5 animate-pulse rounded-full bg-cs2-accent" />
                    <span className="font-mono text-[10px] uppercase tracking-widest text-cs2-text-secondary">
                      Attempting to connect: {BACKEND_CONNECT_LABEL}
                    </span>
                  </div>
                </div>
              </div>
            ) : !startupInitDone ? (
              <div className="absolute inset-0 z-50 flex flex-col items-center justify-center bg-cs2-bg-dark/80 backdrop-blur-sm">
                <div className="flex flex-col items-center gap-6 p-8 rounded-2xl border border-white/5 bg-cs2-bg-card shadow-2xl">
                  <Loader2 className="h-12 w-12 animate-spin text-cs2-orange" />
                  <div className="flex flex-col items-center gap-2">
                    <h2 className="text-xl font-bold tracking-tight text-dynamic-white">
                      {startupInitPhase === "config"
                        ? t("app.startupCheckingConfig")
                        : t("app.startupCheckingUpdate")}
                    </h2>
                    <p className="text-sm text-dynamic-zinc-400">{t("app.startupPleaseWait")}</p>
                  </div>
                </div>
              </div>
            ) : null)}

            <div className="flex min-h-0 flex-1 flex-col overflow-hidden">
              <Suspense fallback={<div className="flex min-h-0 flex-1 items-center justify-center" aria-label={t("app.loadingPage")}><Loader2 className="h-7 w-7 animate-spin text-cs2-orange" /></div>}>
              <Routes>
                <Route path="/" element={<GuidePage />} />
                <Route path="/library" element={<DemoLibraryPage />} />
                <Route path="/analysis" element={<DemoAnalysisPage />} />
                <Route path="/cosmetics-workshop" element={<CosmeticsWorkshopPage />} />
                <Route path="/demo-analysis-preview" element={<Navigate to="/analysis" replace />} />
                <Route path="/queue" element={<RecordingQueuePage />} />
                <Route path="/montage" element={<MontageWorkbenchPage />} />
                <Route path="/lite-cut" element={<LiteCutEditorPage />} />
                <Route path="/lite-cut/editor" element={<Navigate to="/lite-cut" replace />} />
                <Route path="/lite-cut/text" element={<Navigate to="/lite-cut" replace />} />
                <Route path="/lite-cut/color" element={<Navigate to="/lite-cut" replace />} />
                <Route path="/lite-cut/export" element={<LiteCutExportPage />} />
                <Route path="/params" element={<RecordingParamsPage />} />
                <Route path="/settings" element={<SettingsPage />} />
                <Route path="/player-game-config" element={<PlayerGameConfigPage />} />
                <Route path="/match-history" element={<MatchHistoryPage />} />
                <Route path="/obs-ai-entry-preview" element={<ObsAiEntryPreviewPage />} />
                <Route path="/obs-ai-preview" element={<ObsAiTuningPreviewPage />} />
                <Route path="*" element={<Navigate to="/" replace />} />
              </Routes>
              </Suspense>
            </div>
          </main>
          </div>
        </div>

        {showGlobalNotice ? (
          <div
            className="pointer-events-none fixed inset-x-0 bottom-0 z-[100] flex justify-center px-4 pb-[max(1rem,env(safe-area-inset-bottom))] pt-2 sm:px-6"
            aria-live="polite"
          >
            <div className="pointer-events-auto w-full max-w-lg rounded-xl shadow-2xl shadow-black/50">
              <ProgressBar
                text={globalNoticeText}
                active={progressToastShowsBusy(progressText, {
                  parsing: anyDemoParsing,
                  loading: progressToastMeta?.loading === true,
                })}
                batchRecording={batchRecording}
                onAbortBatch={
                  recordingAbortRequested ? undefined : handleAbortBatchRecording
                }
                dismissible={Boolean(progressText?.trim())}
                onDismiss={() => setProgressText("")}
                autoDismissAfterMs={progressToastMeta?.autoDismissMs ?? undefined}
                showQueueNavigate={Boolean(progressToastMeta?.queueLink)}
                isError={progressToastMeta?.isError === true}
              />
            </div>
          </div>
        ) : null}

        <RecordingProgressModal
          open={batchRecording}
          statusText={progressText}
          queueLength={queue.length}
          abortRequested={recordingAbortRequested}
          onAbort={recordingAbortRequested ? undefined : handleAbortBatchRecording}
        />

        <RecordWarmupModal
          open={recordWarmupOpen}
          onClose={dismissWarmup}
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
          initKillFxEnabled={killFxEnabled}
          initKillFxTickOffset={killFxTickOffset}
        />

        <BatchLoadErrorModal
          open={batchLoadError.open}
          failed={batchLoadError.failed}
          mode={batchLoadError.mode}
          onClose={() => setBatchLoadError({ open: false, failed: [], mode: "load" })}
        />

        <RecordingResultModal
          open={recordingResultModalOpen}
          onClose={closeRecordingResults}
          onClearQueue={clearRecordingResultsAndQueue}
          results={recordingResults ?? []}
        />

        <RecordingBlockedDialog
          message={recordingBlockedMessage}
          errorCode={recordingBlockedCode}
          configRecoveryNeeded={recordingRecoveryPrompt.configRecoveryNeeded}
          povRecoveryNeeded={recordingRecoveryPrompt.povRecoveryNeeded}
          onClose={clearRecordingBlock}
        />

        <UpdateCheckModal
          open={updateModalOpen}
          info={updateInfo}
          title={updateModalManual ? t("app.checkUpdate") : t("app.updateFound")}
          onClose={handleUpdateModalClose}
          onCancel={handleUpdateCancel}
          onConfirm={handleUpdateConfirm}
        />
      </div>
    </AppShellProvider>
  );
}
