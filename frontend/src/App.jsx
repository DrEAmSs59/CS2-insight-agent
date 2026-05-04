import { useState, useCallback, useMemo, useEffect, useRef } from "react";
import axios from "axios";
import Sidebar from "./components/Sidebar";
import DemoUpload from "./components/DemoUpload";
import PlayerSelect from "./components/PlayerSelect";
import MatchScoreboard from "./components/MatchScoreboard";
import ClipList from "./components/ClipList";
import ActionBar from "./components/ActionBar";
import RecordWarmupModal from "./components/RecordWarmupModal";
import ProgressBar from "./components/ProgressBar";
import MatchSwitcher from "./components/MatchSwitcher";
import LibraryLoadModeModal from "./components/LibraryLoadModeModal";
import RecordingQueueDrawer from "./components/RecordingQueueDrawer";
import CommonParamsModal from "./components/CommonParamsModal";
import { useRecordingQueue, stripGlobalPacingMetaKeys } from "./stores/recordingQueueStore";
import { ensureClientClipUidsOnClips, stripClientClipUid } from "./utils/clipClientUid";
import {
  freezeToDeathDraftFromClipFilter,
  isFreezeToDeathCompilation,
} from "./utils/freezeToDeathRoundFilter";
import { warmupApiPayloadToPersisted } from "./utils/warmupDefaults";
import {
  Package,
  RefreshCw,
  Loader2,
  FolderSync,
  Trash2,
  RotateCw,
  ChevronLeft,
  ChevronRight,
  ChevronDown,
  Pencil,
  Search,
  ShieldAlert,
  SlidersHorizontal,
  FolderOpen,
  AlertTriangle,
  X,
} from "lucide-react";

const API = axios.create({ baseURL: "/api" });

/** Demo 库地图筛选下拉项（顺序固定）。 */
const DEMO_LIBRARY_MAP_OPTIONS = [
  "de_dust2",
  "de_mirage",
  "de_inferno",
  "de_ancient",
  "de_nuke",
  "de_anubis",
  "de_overpass",
  "de_train",
  "de_cache",
  "de_vertigo",
];

const DEMO_LIBRARY_STATUS_FILTER_OPTIONS = [
  { value: "pending", label: "待解析" },
  { value: "done", label: "已完成" },
  { value: "error", label: "解析失败" },
];

const DEMO_LIBRARY_STATUS_LABELS = {
  pending: "待解析",
  done: "已完成",
  parsed: "已完成",
  error: "解析失败",
};

function demoLibraryStatusLabel(code) {
  if (code == null || code === "") return "—";
  const key = String(code).trim().toLowerCase();
  return DEMO_LIBRARY_STATUS_LABELS[key] ?? String(code);
}

/**
 * 推断对话框副标题：根据后端返回的 detail 文本判定具体阻断场景。
 * 与原 "CS2 正在运行" 路径共用同一个对话框组件，保持视觉风格统一。
 */
function recordingBlockedSubtitle(message) {
  const m = String(message || "");
  if (
    m.includes("分辨率") ||
    m.includes("屏幕比例") ||
    m.includes("宽高") ||
    m.includes("启动分辨率") ||
    m.includes("所选屏幕比例") ||
    m.includes("填写启动分辨率")
  ) {
    return "录制预热选项未通过校验";
  }
  if (m.includes("GSI") || m.includes("未就绪") || m.includes("未进入游戏")) {
    return "CS2 未在限定时间内进入游戏画面";
  }
  if (m.includes("正在运行") || m.includes("CS2") && m.includes("退出")) {
    return "当前检测到 CS2 正在运行";
  }
  if (m.includes("已有录制任务")) {
    return "已有录制任务进行中";
  }
  if (m.includes("尚未恢复") || m.includes("异常退出") || m.includes("一键恢复")) {
    return "玩家配置需要先恢复";
  }
  return "录制启动条件未满足";
}

/** 提取 FastAPI / axios 报错文案（含 422 校验数组）。 */
function formatRecordingApiError(e) {
  const data = e?.response?.data;
  const d = data?.detail;
  if (typeof d === "string") return d;
  if (Array.isArray(d)) {
    return d
      .map((item) => {
        if (item && typeof item === "object" && item.msg != null) return String(item.msg);
        try {
          return JSON.stringify(item);
        } catch {
          return String(item);
        }
      })
      .join(" ");
  }
  if (d != null && typeof d === "object") {
    if (typeof d.message === "string") return d.message;
    try {
      return JSON.stringify(d);
    } catch {
      /* fallthrough */
    }
  }
  return String(e?.message || "请求失败");
}

function RecordingBlockedDialog({ message, onClose }) {
  if (!message) return null;
  const subtitle = recordingBlockedSubtitle(message);
  return (
    <div
      className="fixed inset-0 z-[120] flex items-center justify-center bg-black/70 px-4 py-6 backdrop-blur-sm"
      role="dialog"
      aria-modal="true"
      aria-labelledby="recording-blocked-title"
      onClick={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div className="relative w-full max-w-md overflow-hidden rounded-xl border border-white/10 bg-cs2-bg-card shadow-2xl">
        <button
          type="button"
          onClick={onClose}
          className="absolute right-3 top-3 rounded-md p-1.5 text-zinc-500 hover:bg-white/[0.06] hover:text-zinc-300"
          aria-label="关闭"
        >
          <X className="h-4 w-4" />
        </button>

        <div className="flex items-start gap-3 border-b border-white/10 px-5 py-4">
          <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg border border-cs2-orange/30 bg-cs2-orange/10 text-cs2-orange">
            <ShieldAlert className="h-5 w-5" />
          </div>
          <div className="min-w-0 pr-7">
            <h2 id="recording-blocked-title" className="text-sm font-bold text-white">
              无法开始录制
            </h2>
            <p className="mt-1 text-[11px] leading-relaxed text-zinc-500">{subtitle}</p>
          </div>
        </div>

        <div className="px-5 py-4">
          <p className="text-sm leading-6 text-zinc-300 whitespace-pre-wrap break-words">{message}</p>
        </div>

        <div className="flex justify-end border-t border-white/10 bg-black/20 px-5 py-3">
          <button
            type="button"
            onClick={onClose}
            className="rounded-lg bg-cs2-orange px-4 py-2 text-sm font-extrabold text-black shadow-lg shadow-cs2-orange/20 transition-colors hover:bg-cs2-orange-light"
          >
            知道了
          </button>
        </div>
      </div>
    </div>
  );
}

function queueItemClientUid(it) {
  return it.clientClipUid || `legacy:${it.demoFilename}:${it.clipId}`;
}

/** @param {number} limit @param {T[]} items @param {(item: T) => Promise<void>} work @template T */
async function runWithConcurrency(limit, items, work) {
  if (!items.length) return;
  const n = Math.min(Math.max(1, limit), items.length);
  let cursor = 0;
  const worker = async () => {
    while (true) {
      const my = cursor++;
      if (my >= items.length) break;
      await work(items[my]);
    }
  };
  await Promise.all(Array.from({ length: n }, () => worker()));
}

/**
 * 构建批量录制 groups 数组。
 * @param {import("./stores/recordingQueueStore").RecordingQueueItem[]} queue
 * @param {import("./stores/recordingQueueStore").PacingOverride} globalPacing
 *   全局节奏参数，作为所有片段的基底；片段自身的 pacing_override 优先级更高（覆盖同名字段）。
 */
function buildBatchGroupsFromQueue(queue, globalPacing = {}) {
  // 分组键 = demo文件名 + 玩家名，同一个 demo 的不同玩家各自独立成一个 group，
  // 这样后端才能在同一 CS2 会话内按玩家切换 spec_player。
  const byDemoPlayer = new Map();
  for (const it of queue) {
    const demoIdentity = it.demoPath || it.demoFilename;
    const key = `${demoIdentity}::${it.targetPlayer || ""}`;
    if (!byDemoPlayer.has(key)) {
      byDemoPlayer.set(key, {
        demo_filename: it.demoFilename,
        demo_path: it.demoPath || null,
        clips: [],
        target_player: it.targetPlayer || null,
        target_player_user_id: it.targetPlayerUserId ?? null,
        target_steam_id: it.targetSteamId || null,
      });
    }
    const clip = { ...stripClientClipUid(it.clipData) };
    const baseGlobal = stripGlobalPacingMetaKeys(globalPacing);
    // 全局节奏作为基底，片段自身 pacing_override 覆盖同名字段（优先级更高）
    const mergedPacing = {
      ...( Object.keys(baseGlobal).length ? baseGlobal : {} ),
      ...( it.pacing_override && typeof it.pacing_override === "object" ? it.pacing_override : {} ),
    };
    if (Object.keys(mergedPacing).length) {
      clip.pacing_override = mergedPacing;
    }
    if (clip.fixed_segment_pacing && clip.pacing_override && typeof clip.pacing_override === "object") {
      const deny = new Set([
        "pre_first_sec",
        "post_last_sec",
        "max_gap_sec",
        "post_mid_sec",
        "pre_cont_sec",
      ]);
      const po = { ...clip.pacing_override };
      for (const k of deny) delete po[k];
      if (Object.keys(po).length) clip.pacing_override = po;
      else delete clip.pacing_override;
    }
    byDemoPlayer.get(key).clips.push(clip);
  }
  return Array.from(byDemoPlayer.values());
}

export default function App() {
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
    provider: "deepseek",
    model: "deepseek-chat",
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
  const [progressText, setProgressText] = useState("");
  const [batchRecording, setBatchRecording] = useState(false);
  const [recordingBlockedMessage, setRecordingBlockedMessage] = useState("");
  const [recordWarmupOpen, setRecordWarmupOpen] = useState(false);
  const [warmupIntent, setWarmupIntent] = useState(null);
  /** @type {null | { restore_required?: boolean; message?: string; cs2_running?: boolean; backup_dir?: string }} */
  const [configBackupStatus, setConfigBackupStatus] = useState(null);
  /** 来自 cs2-insight.config.json，打开录制预热对话框时作为初始选项 */
  const [savedRecordWarmupDefaults, setSavedRecordWarmupDefaults] = useState(null);
  const [queueDrawerOpen, setQueueDrawerOpen] = useState(false);
  const [commonParamsOpen, setCommonParamsOpen] = useState(false);
  const [cs2Path, setCs2Path] = useState("");
  const [cs2FpsMax, setCs2FpsMax] = useState(240);
  const [demoWatchPaths, setDemoWatchPaths] = useState([]);
  const [expectedParsePlayersText, setExpectedParsePlayersText] = useState("");
  const [demoLibraryItems, setDemoLibraryItems] = useState([]);
  const [libraryLoading, setLibraryLoading] = useState(false);
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
    minKills: "",
    maxDeaths: "",
    minAssists: "",
    minKd: "",
  });
  const [libraryJumpDraft, setLibraryJumpDraft] = useState("");
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

  const LIBRARY_PAGE_SIZE = 5;
  const libraryTotalPages =
    libraryTotal == null ? null : Math.max(1, Math.ceil(libraryTotal / LIBRARY_PAGE_SIZE));

  const libraryAdvFiltersKey = useMemo(() => JSON.stringify(libraryAdvFilters), [libraryAdvFilters]);

  useEffect(() => {
    setLibraryPage(1);
  }, [libraryAdvFiltersKey]);

  useEffect(() => {
    const t = setTimeout(() => {
      const next = librarySearchInput.trim();
      setLibrarySearchQ((prev) => {
        if (prev === next) return prev;
        setLibraryPage(1);
        return next;
      });
    }, 320);
    return () => clearTimeout(t);
  }, [librarySearchInput]);

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
    const { manageLoading = true } = opts;
    if (manageLoading) setLibraryLoading(true);
    try {
      const limit = LIBRARY_PAGE_SIZE;
      const offset = (page - 1) * limit;
      const params = { limit, offset };
      if (librarySearchQ) params.q = librarySearchQ;
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
  }, [libraryPage, librarySearchQ, appendDemoLibraryFilterParams]);

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
    setLibraryLoading(true);
    setProgressText("正在扫描监听目录并补全全部缺失的玩家统计索引…");
    try {
      const { data } = await API.post("/demos/scan");
      setProgressText("扫描完成，正在刷新列表…");
      await refreshDemoLibrary(libraryPage, { manageLoading: false });
      const idx = data?.player_stats_index;
      if (idx && idx.processed > 0) {
        setProgressText(
          `已更新 Demo 库。玩家统计索引：处理 ${idx.processed}，成功 ${idx.indexed}。`
        );
      } else {
        setProgressText("已更新 Demo 库。");
      }
    } catch (e) {
      setProgressText(`扫描或列表刷新失败: ${e.response?.data?.detail || e.message}`);
    } finally {
      setLibraryLoading(false);
    }
  }, [refreshDemoLibrary, libraryPage]);

  const handleReparseDemo = useCallback(async (id) => {
    try {
      await API.post(`/demos/${id}/parse`);
      await refreshDemoLibrary(libraryPage, { manageLoading: false });
    } catch (e) {
      setProgressText(`重解析失败: ${e.response?.data?.detail || e.message}`);
    }
  }, [refreshDemoLibrary]);

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
          const autoPlayer =
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
          const ap = d.cached_auto_player;
          if (!r || !ap || !Array.isArray(r.clips)) return null;
          return {
            players: {
              [ap]: {
                clips: ensureClientClipUidsOnClips(r.clips || []),
                match_meta: r.match_meta || d.match_meta || null,
              },
            },
            demo_path: d.path,
            demo_filename: d.filename,
          };
        })
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
        } else if (x.cached_result && x.cached_auto_player) {
          selectedMap[i] = [x.cached_auto_player];
          tabMap[i] = x.cached_auto_player;
        }
      });
      setLibraryDemoIdsByIndex(idMap);
      setCurrentMatchIndex(0);
      setSelectedPlayers(selectedMap);
      setActivePlayerTabs(tabMap);
      const ftdByIndex = {};
      loaded.forEach((x, i) => {
        const clips = x.cached_result?.clips;
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
      const cachedCount = loaded.filter((x) => Boolean(x.cached_result)).length;
      setProgressText(
        cachedCount > 0
          ? `已载入 ${loaded.length} 个 Demo，其中 ${cachedCount} 个命中缓存并已自动展示片段。`
          : `已从 Demo 库载入 ${loaded.length} 个 Demo`
      );
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
  }, []);

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
        if (data.cs2_path) setCs2Path(data.cs2_path);
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
    // 切页拉一次；库变更另由 /api/demos/stream（SSE）防抖刷新。新增文件需点「刷新」扫描入库。
    void refreshDemoLibrary(libraryPage, { manageLoading: false });
  }, [refreshDemoLibrary, libraryPage]);

  const hasLibraryAdvancedFilters = useMemo(() => {
    const f = libraryAdvFilters;
    return !!(f.mapName.trim() || (f.status && f.status !== "all") || f.playerQuery.trim());
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
      setProgressText(
        uploads.length > 1
          ? `已上传 ${uploads.length} 个 Demo。请切换场次，分别为每场选择玩家并点击「开始分析」。`
          : "上传完成，请选择要分析的玩家后点击「开始分析」。"
      );
    } catch (e) {
      setProgressText(`上传失败: ${e.response?.data?.detail || e.message}`);
    } finally {
      setParsing(false);
    }
  }, []);

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
        setProgressText(`正在解析「${fn}」…`);
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
          if (viewingHere) setProgressText(doneMsg);
          else setProgressText((prev) => (prev ? `${prev}\n${doneMsg}` : doneMsg));
        }
      } catch (e) {
        const err = `解析失败「${fn}」: ${e.response?.data?.detail || e.message}`;
        if (!quietProgress) {
          if (viewingHere) setProgressText(err);
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
        setProgressText(
          `已载入 ${loaded.length} 个 Demo，并完成 ${specs.length} 场高光解析。`
        );
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
    const toAdd = candidates
      .filter((c) => {
        if (!isFreezeToDeathCompilation(c)) return true;
        return ftdPicksSorted.length > 0;
      })
      .map((c) => {
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
        if (isFreezeToDeathCompilation(c) && ftdPicksSorted.length) {
          return { ...row, freezeToDeathQueueRounds: [...ftdPicksSorted] };
        }
        return row;
      });
    if (!toAdd.length) {
      if (candidates.some((c) => isFreezeToDeathCompilation(c)) && !ftdPicksSorted.length) {
        setProgressText("「回合合集」须至少勾选一个回合才能加入队列。");
      }
      return;
    }
    addToQueue(toAdd);
    setSelectedClientClipUids(new Set());
    const skipped = candidates.length - toAdd.length;
    const skipHint =
      skipped > 0 ? `（已跳过 ${skipped} 条未满足条件的片段）` : "";
    setProgressText(`已加入录制队列 ${toAdd.length} 条（当前场次）${skipHint}`);
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
    setProgressText(`已将 ${toAdd.length} 条高光片段加入队列（跨场次）。`);
  }, [parsedMatches, addToQueue, queueItemMetaForPlayer, queuedClientClipUidsGlobal]);

  const persistWarmupDefaults = useCallback(async (obj) => {
    setSavedRecordWarmupDefaults(obj);
    try {
      await API.put("config", { default_record_warmup: obj });
    } catch {
      /* silent */
    }
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
          const groups = buildBatchGroupsFromQueue(queue, globalPacing);
          const { data } = await API.post("/record/batch", { groups, warmup, obs: obsConfig });
          const results = data.results ?? [];
          const ok = results.filter((r) => r.status === "recorded").length;
          const aborted = results.filter((r) => r.status === "aborted").length;
          if (aborted > 0) {
            setProgressText(
              `批量录制已结束：成功 ${ok}，中止 ${aborted}，其余 ${results.length - ok - aborted} 条；共 ${results.length} 个片段。`,
            );
          } else {
            setProgressText(`批量录制完成！成功 ${ok} / ${results.length} 个片段。`);
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
      provider: c.provider,
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

  return (
    <div className="relative flex h-screen overflow-hidden bg-cs2-bg-dark">
      {libraryLoadingOverlay && (
        <div className="absolute inset-0 z-[70] flex items-center justify-center bg-black/55 backdrop-blur-[1px]">
          <div className="flex items-center gap-3 rounded-lg border border-white/10 bg-cs2-bg-card px-4 py-3 shadow-2xl">
            <Loader2 className="h-5 w-5 animate-spin text-cs2-orange" />
            <p className="text-sm font-medium text-zinc-200">{libraryLoadingText}</p>
          </div>
        </div>
      )}
      <Sidebar
        aiMode={aiMode}
        onAiModeChange={handleAiModeChange}
        obsConfig={obsConfig}
        onObsConfigChange={setObsConfig}
        onPersistObs={persistObsConfig}
        obsPasswordPlaceholder={obsPasswordPlaceholder}
        onObsPasswordFocus={handleObsPasswordFocus}
        onObsPasswordBlur={handleObsPasswordBlur}
        llmConfig={llmConfig}
        onLlmConfigChange={setLlmConfig}
        llmKeySavedOnServer={llmKeySavedOnServer}
        onPersistLlm={persistLlmConfig}
        cs2Path={cs2Path}
        onCs2PathChange={setCs2Path}
        cs2FpsMax={cs2FpsMax}
        onCs2FpsMaxChange={setCs2FpsMax}
        demoWatchPaths={demoWatchPaths}
        onDemoWatchPathsChange={setDemoWatchPaths}
        onSaveConfig={handleSaveConfig}
        onDetectCs2={handleDetectCs2}
        onScanDemos={handleScanDemos}
        demoLibraryLoading={libraryLoading}
        expectedParsePlayersText={expectedParsePlayersText}
        onExpectedParsePlayersTextChange={setExpectedParsePlayersText}
        onSaveExpectedParsePlayers={handleSaveExpectedParsePlayers}
      />

      <main className="flex flex-1 flex-col overflow-hidden">
        {hasDemos && (
          <header className="flex shrink-0 items-center justify-between gap-3 border-b border-white/10 bg-cs2-bg-dark/90 px-4 py-2.5 backdrop-blur-md sm:px-5">
            <p className="min-w-0 truncate text-[11px] text-zinc-500">
              <span className="font-mono text-zinc-400">{uploadedDemos.length}</span> 个 Demo 已导入
            </p>
            <div className="flex shrink-0 items-center gap-2">
              <button
                type="button"
                onClick={() => setCommonParamsOpen(true)}
                disabled={batchRecording}
                className="flex items-center gap-1.5 rounded-md border border-cs2-border bg-cs2-bg-input px-2.5 py-1.5 text-[11px] font-semibold text-zinc-300 transition-colors hover:border-cs2-orange/45 hover:text-white disabled:opacity-40"
              >
                <SlidersHorizontal className="h-3.5 w-3.5" />
                常用参数管理
              </button>
              <button
                type="button"
                onClick={handleResetDemo}
                disabled={anyDemoParsing || batchRecording}
                className="flex items-center gap-1.5 rounded-md border border-cs2-border bg-cs2-bg-input px-2.5 py-1.5 text-[11px] font-semibold text-zinc-300 transition-colors hover:border-cs2-orange/45 hover:text-white disabled:opacity-40"
              >
                <RefreshCw className="h-3.5 w-3.5" />
                更换 Demo
              </button>
              <button
                type="button"
                onClick={() => setQueueDrawerOpen(true)}
                disabled={batchRecording}
                className="flex items-center gap-1.5 rounded-md border border-cs2-orange/45 bg-cs2-orange/10 px-2.5 py-1.5 text-[11px] font-bold text-cs2-orange transition-colors hover:border-cs2-orange hover:bg-cs2-orange/15 disabled:opacity-40"
              >
                <Package className="h-3.5 w-3.5" />
                录制队列
                <span className="rounded bg-cs2-orange/25 px-1.5 font-mono text-[10px] text-white tabular-nums">
                  {queue.length}
                </span>
              </button>
            </div>
          </header>
        )}

        <div className="flex-1 space-y-5 overflow-y-auto px-4 pb-6 pt-3 sm:px-5 sm:pt-4">
          {configBackupStatus?.restore_required ? (
            <section
              className="rounded-lg border border-amber-500/45 bg-amber-500/10 px-3 py-3 shadow-sm"
              role="status"
            >
              <div className="flex flex-wrap items-start gap-2">
                <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0 text-amber-400" aria-hidden />
                <div className="min-w-0 flex-1 space-y-1.5">
                  <p className="text-xs font-bold text-amber-100">检测到上次录制异常退出</p>
                  <p className="text-[11px] leading-relaxed text-amber-100/85">
                    上次录制过程中程序没有正常结束，玩家 CS2 配置可能尚未恢复。请先关闭 CS2，然后点击「一键恢复玩家配置」。
                  </p>
                  <div className="flex flex-wrap gap-2 pt-1">
                    <button
                      type="button"
                      className="rounded-md border border-amber-400/60 bg-amber-500/20 px-3 py-1.5 text-[11px] font-bold text-amber-50 hover:bg-amber-500/30"
                      onClick={() => void handleRestorePlayerConfig()}
                    >
                      一键恢复玩家配置
                    </button>
                    <button
                      type="button"
                      className="inline-flex items-center gap-1 rounded-md border border-white/15 bg-black/20 px-3 py-1.5 text-[11px] font-semibold text-zinc-200 hover:border-white/25"
                      onClick={() => void handleOpenConfigBackupDir()}
                    >
                      <FolderOpen className="h-3.5 w-3.5" aria-hidden />
                      打开备份目录
                    </button>
                  </div>
                </div>
              </div>
            </section>
          ) : configBackupStatus && configBackupStatus.restore_required === false ? (
            <p className="text-[10px] text-zinc-600">玩家配置状态：正常</p>
          ) : null}

          <section className="rounded-lg border border-white/10 bg-cs2-bg-card p-3">
            <div className="mb-2 flex items-center justify-between">
              <h3 className="text-xs font-semibold text-zinc-300">本地 Demo 库</h3>
              <div className="flex max-w-[min(100%,28rem)] flex-wrap items-center justify-end gap-1">
                <button
                  type="button"
                  disabled={libraryLoading}
                  className="inline-flex items-center gap-1 rounded border border-cs2-border bg-cs2-bg-input px-2 py-1 text-[10px] font-semibold hover:border-cs2-orange/50 disabled:opacity-50"
                  onClick={() => void handleScanDemos()}
                >
                  <FolderSync className={`h-3 w-3 ${libraryLoading ? "animate-spin" : ""}`} />
                  刷新
                </button>
                <button
                  type="button"
                  disabled={demoLibraryItems.length === 0}
                  className="rounded border border-cs2-border px-2 py-1 text-[10px] font-semibold text-zinc-400 hover:border-cs2-orange/50 hover:text-zinc-200 disabled:opacity-40"
                  onClick={selectLibraryPage}
                >
                  本页全选
                </button>
                <button
                  type="button"
                  disabled={libraryLoading || (libraryTotal != null && libraryTotal === 0)}
                  className="rounded border border-cs2-border px-2 py-1 text-[10px] font-semibold text-zinc-400 hover:border-cs2-orange/50 hover:text-zinc-200 disabled:opacity-40"
                  onClick={() => void selectAllLibraryDemos()}
                >
                  全选库内
                </button>
                <button
                  type="button"
                  disabled={selectedLibraryDemoIds.size === 0}
                  className="rounded border border-cs2-border px-2 py-1 text-[10px] font-semibold text-zinc-400 hover:border-cs2-orange/50 hover:text-zinc-200 disabled:opacity-40"
                  onClick={clearLibrarySelection}
                >
                  清空
                </button>
                <button
                  type="button"
                  disabled={selectedLibraryDemoIds.size === 0}
                  className="inline-flex items-center gap-1 rounded border border-emerald-500/40 bg-emerald-500/10 px-2 py-1 text-[10px] font-semibold text-emerald-400 hover:border-emerald-500/70 disabled:opacity-40"
                  onClick={() => void handleLoadSelectedLibraryDemos()}
                >
                  载入选中({selectedLibraryDemoIds.size})
                </button>
                <button
                  type="button"
                  disabled={selectedLibraryDemoIds.size === 0}
                  className="inline-flex items-center gap-1 rounded border border-cs2-orange/45 bg-cs2-orange/10 px-2 py-1 text-[10px] font-bold text-cs2-orange hover:border-cs2-orange/70 disabled:opacity-40"
                  onClick={() => setLibraryBatchModalOpen(true)}
                >
                  载入并解析…
                </button>
              </div>
            </div>
            <div className="mb-2 flex items-center gap-2 rounded border border-white/10 bg-cs2-bg-input/40 px-2 py-1.5">
              <Search className="h-3.5 w-3.5 shrink-0 text-zinc-500" aria-hidden />
              <input
                type="search"
                enterKeyHint="search"
                className="min-w-0 flex-1 bg-transparent text-[11px] text-zinc-200 outline-none placeholder:text-zinc-600"
                placeholder="按文件名或展示名搜索…"
                value={librarySearchInput}
                onChange={(e) => setLibrarySearchInput(e.target.value)}
                aria-label="搜索 Demo 名称"
              />
            </div>
            <details className="group mb-2 rounded border border-white/10 bg-cs2-bg-input/20">
              <summary className="flex cursor-pointer list-none items-center gap-1.5 px-2 py-1.5 text-[10px] font-semibold text-zinc-400 marker:content-none [&::-webkit-details-marker]:hidden hover:text-zinc-200">
                <SlidersHorizontal className="h-3 w-3 shrink-0" aria-hidden />
                高级筛选
                <ChevronDown className="ml-auto h-3 w-3 shrink-0 transition-transform group-open:rotate-180" aria-hidden />
              </summary>
              <div className="space-y-2 border-t border-white/10 px-2 py-2 text-[10px] text-zinc-300">
                <p className="leading-relaxed text-zinc-500">
                  玩家表现依赖库内玩家统计；点击「刷新」自动补全玩家信息，首次补全玩家信息时请稍等片刻。填写昵称关键词后才会按玩家表筛选；击杀 / 死亡 / 助攻 /
                  KD 仅在与昵称同时填写时生效。
                </p>
                <div className="grid grid-cols-2 gap-2">
                  <label className="flex flex-col gap-0.5">
                    <span className="text-zinc-500">地图</span>
                    <select
                      className="rounded border border-cs2-border bg-cs2-bg-input px-1.5 py-1 font-mono text-[10px] outline-none focus:border-cs2-orange/50"
                      value={libraryAdvFilters.mapName}
                      onChange={(e) =>
                        setLibraryAdvFilters((p) => ({ ...p, mapName: e.target.value }))
                      }
                    >
                      <option value="">全部地图</option>
                      {DEMO_LIBRARY_MAP_OPTIONS.map((m) => (
                        <option key={m} value={m}>
                          {m}
                        </option>
                      ))}
                    </select>
                  </label>
                  <label className="flex flex-col gap-0.5">
                    <span className="text-zinc-500">状态</span>
                    <select
                      className="rounded border border-cs2-border bg-cs2-bg-input px-1.5 py-1 text-[10px] outline-none focus:border-cs2-orange/50"
                      value={libraryAdvFilters.status}
                      onChange={(e) =>
                        setLibraryAdvFilters((p) => ({ ...p, status: e.target.value }))
                      }
                    >
                      <option value="all">全部状态</option>
                      {DEMO_LIBRARY_STATUS_FILTER_OPTIONS.map(({ value, label }) => (
                        <option key={value} value={value}>
                          {label}
                        </option>
                      ))}
                    </select>
                  </label>
                </div>
                <div className="space-y-2 rounded border border-white/5 bg-black/15 p-2">
                  <p className="text-[9px] font-semibold text-zinc-400">玩家表现</p>
                  <label className="flex flex-col gap-0.5">
                    <span className="text-zinc-500">昵称关键词</span>
                    <input
                      className="rounded border border-cs2-border bg-cs2-bg-input px-1.5 py-1 text-[10px] outline-none focus:border-cs2-orange/50"
                      value={libraryAdvFilters.playerQuery}
                      onChange={(e) =>
                        setLibraryAdvFilters((p) => ({ ...p, playerQuery: e.target.value }))
                      }
                      placeholder="先填昵称才会按玩家筛选；下方数值须与昵称同时填写才生效"
                    />
                  </label>
                  <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
                    <label className="flex flex-col gap-0.5">
                      <span className="text-zinc-500">击杀 ≥</span>
                      <input
                        inputMode="numeric"
                        disabled={!libraryAdvFilters.playerQuery.trim()}
                        className="rounded border border-cs2-border bg-cs2-bg-input px-1.5 py-1 font-mono text-[10px] outline-none focus:border-cs2-orange/50 disabled:cursor-not-allowed disabled:opacity-40"
                        value={libraryAdvFilters.minKills}
                        onChange={(e) =>
                          setLibraryAdvFilters((p) => ({ ...p, minKills: e.target.value }))
                        }
                      />
                    </label>
                    <label className="flex flex-col gap-0.5">
                      <span className="text-zinc-500">死亡 ≤</span>
                      <input
                        inputMode="numeric"
                        disabled={!libraryAdvFilters.playerQuery.trim()}
                        className="rounded border border-cs2-border bg-cs2-bg-input px-1.5 py-1 font-mono text-[10px] outline-none focus:border-cs2-orange/50 disabled:cursor-not-allowed disabled:opacity-40"
                        value={libraryAdvFilters.maxDeaths}
                        onChange={(e) =>
                          setLibraryAdvFilters((p) => ({ ...p, maxDeaths: e.target.value }))
                        }
                      />
                    </label>
                    <label className="flex flex-col gap-0.5">
                      <span className="text-zinc-500">助攻 ≥</span>
                      <input
                        inputMode="numeric"
                        disabled={!libraryAdvFilters.playerQuery.trim()}
                        className="rounded border border-cs2-border bg-cs2-bg-input px-1.5 py-1 font-mono text-[10px] outline-none focus:border-cs2-orange/50 disabled:cursor-not-allowed disabled:opacity-40"
                        value={libraryAdvFilters.minAssists}
                        onChange={(e) =>
                          setLibraryAdvFilters((p) => ({ ...p, minAssists: e.target.value }))
                        }
                      />
                    </label>
                    <label className="flex flex-col gap-0.5">
                      <span className="text-zinc-500">KD ≥</span>
                      <input
                        inputMode="decimal"
                        disabled={!libraryAdvFilters.playerQuery.trim()}
                        className="rounded border border-cs2-border bg-cs2-bg-input px-1.5 py-1 font-mono text-[10px] outline-none focus:border-cs2-orange/50 disabled:cursor-not-allowed disabled:opacity-40"
                        value={libraryAdvFilters.minKd}
                        onChange={(e) =>
                          setLibraryAdvFilters((p) => ({ ...p, minKd: e.target.value }))
                        }
                      />
                    </label>
                  </div>
                </div>
                <div className="flex flex-wrap items-center gap-2">
                  <button
                    type="button"
                    className="rounded border border-cs2-border px-2 py-1 text-[10px] font-semibold text-zinc-400 hover:border-cs2-orange/50 hover:text-zinc-200"
                    onClick={() =>
                      setLibraryAdvFilters({
                        mapName: "",
                        status: "all",
                        playerQuery: "",
                        minKills: "",
                        maxDeaths: "",
                        minAssists: "",
                        minKd: "",
                      })
                    }
                  >
                    清空筛选
                  </button>
                </div>
              </div>
            </details>
            <div className="space-y-1">
              {demoLibraryItems.length === 0 && !libraryLoading && (
                <p className="text-[11px] text-cs2-text-secondary">
                  {librarySearchQ
                    ? `没有名称包含「${librarySearchQ}」的 Demo。`
                    : hasLibraryAdvancedFilters
                      ? "当前筛选条件下没有匹配的 Demo。"
                      : "暂无数据，配置监听路径后会自动入库。"}
                </p>
              )}
              {demoLibraryItems.map((it) => (
                <div
                  key={it.id}
                  className="flex items-center justify-between rounded border border-white/10 bg-cs2-bg-input/50 px-2 py-1.5 text-[11px]"
                >
                  <div className="flex min-w-0 items-center gap-2">
                    <input
                      type="checkbox"
                      checked={selectedLibraryDemoIds.has(it.id)}
                      onChange={(e) => {
                        const checked = e.target.checked;
                        setSelectedLibraryDemoIds((prev) => {
                          const next = new Set(prev);
                          if (checked) next.add(it.id);
                          else next.delete(it.id);
                          return next;
                        });
                      }}
                    />
                    <div className="min-w-0">
                      <p className="truncate font-mono text-zinc-300">
                        {(it.display_name && String(it.display_name).trim()) || it.filename}
                      </p>
                      {it.display_name && String(it.display_name).trim() ? (
                        <p className="truncate text-[10px] text-zinc-500" title={it.path}>
                          文件: {it.filename}
                        </p>
                      ) : null}
                      <p className="text-[10px] text-cs2-text-secondary">{demoLibraryStatusLabel(it.status)}</p>
                    </div>
                  </div>
                  <div className="flex items-center gap-1">
                    <button
                      type="button"
                      className="rounded border border-cs2-border px-1.5 py-0.5 text-[10px] hover:border-cs2-orange/50"
                      title="仅改库中展示名"
                      onClick={() =>
                        setLibraryRename({
                          id: it.id,
                          draft: (it.display_name && String(it.display_name).trim()) || "",
                        })
                      }
                    >
                      <Pencil className="h-3 w-3" />
                    </button>
                    <button
                      type="button"
                      className="rounded border border-cs2-border px-1.5 py-0.5 text-[10px] hover:border-emerald-500/60"
                      onClick={() => void handleLoadDemoFromLibrary([it])}
                    >
                      选择
                    </button>
                    <button
                      type="button"
                      className="rounded border border-cs2-border px-1.5 py-0.5 text-[10px] hover:border-cs2-orange/50"
                      onClick={() => void handleReparseDemo(it.id)}
                    >
                      <RotateCw className="h-3 w-3" />
                    </button>
                    <button
                      type="button"
                      className="rounded border border-cs2-border px-1.5 py-0.5 text-[10px] hover:border-cs2-fail"
                      onClick={() =>
                        setLibraryDeletePrompt({
                          id: it.id,
                          label:
                            (it.display_name && String(it.display_name).trim()) || it.filename || `#${it.id}`,
                        })
                      }
                    >
                      <Trash2 className="h-3 w-3" />
                    </button>
                  </div>
                </div>
              ))}
            </div>
            <div className="mt-2 flex flex-wrap items-center justify-end gap-x-1 gap-y-1.5">
              <button
                type="button"
                disabled={libraryPage <= 1}
                className="rounded border border-cs2-border px-1.5 py-1 text-[10px] disabled:opacity-40"
                onClick={() => {
                  const next = Math.max(1, libraryPage - 1);
                  setLibraryPage(next);
                  void refreshDemoLibrary(next, { manageLoading: false });
                }}
              >
                <ChevronLeft className="h-3 w-3" />
              </button>
              <span className="px-2 text-[10px] text-zinc-500">
                {libraryTotalPages == null
                  ? `第 ${libraryPage} 页`
                  : `第 ${libraryPage} / ${libraryTotalPages} 页`}
              </span>
              <button
                type="button"
                disabled={!libraryHasNextPage}
                className="rounded border border-cs2-border px-1.5 py-1 text-[10px] disabled:opacity-40"
                onClick={() => {
                  const next = libraryPage + 1;
                  setLibraryPage(next);
                  void refreshDemoLibrary(next, { manageLoading: false });
                }}
              >
                <ChevronRight className="h-3 w-3" />
              </button>
              <form
                className="flex items-center gap-1 border-l border-white/10 pl-2"
                onSubmit={(e) => {
                  e.preventDefault();
                  handleLibraryPageJump();
                }}
              >
                <span className="text-[10px] text-zinc-600">跳至</span>
                <input
                  type="text"
                  inputMode="numeric"
                  className="w-9 rounded border border-cs2-border bg-cs2-bg-input px-1 py-0.5 text-center font-mono text-[10px] text-zinc-200 outline-none focus:border-cs2-orange/50"
                  value={libraryJumpDraft}
                  onChange={(e) => setLibraryJumpDraft(e.target.value.replace(/\D/g, "").slice(0, 5))}
                  placeholder="页"
                  aria-label="跳转页码"
                />
                <button
                  type="submit"
                  className="rounded border border-cs2-border px-1.5 py-1 text-[10px] font-semibold text-zinc-400 hover:border-cs2-orange/50 hover:text-zinc-200"
                >
                  跳转
                </button>
              </form>
            </div>
          </section>

          {libraryDeletePrompt ? (
            <div
              className="fixed inset-0 z-[100] flex items-center justify-center bg-black/55 px-4"
              role="dialog"
              aria-modal="true"
              aria-labelledby="library-delete-title"
              onClick={() => setLibraryDeletePrompt(null)}
            >
              <div
                className="w-full max-w-md rounded-lg border border-white/15 bg-cs2-bg-card p-4 shadow-xl"
                onClick={(e) => e.stopPropagation()}
              >
                <h4 id="library-delete-title" className="mb-2 text-xs font-semibold text-zinc-300">
                  从 Demo 库删除
                </h4>
                <p className="mb-3 font-mono text-[11px] text-zinc-400">{libraryDeletePrompt.label}</p>
                <p className="mb-3 text-[10px] leading-relaxed text-cs2-text-secondary">
                  仅移除本地库中的记录与解析缓存，不会删除磁盘上的 .dem 文件。请选择删除之后再次扫描时的行为：
                </p>
                <div className="flex flex-col gap-2">
                  <button
                    type="button"
                    className="rounded border border-emerald-500/40 bg-emerald-500/10 px-3 py-2 text-left text-[11px] leading-snug text-emerald-200/95 hover:bg-emerald-500/20"
                    onClick={() => void handleDeleteDemo(libraryDeletePrompt.id, "reimport")}
                  >
                    删除后再次扫描仍入库
                    <span className="mt-0.5 block text-[10px] font-normal text-zinc-500">
                      下次扫描会重新加入库中，入库时间为扫描时刻。
                    </span>
                  </button>
                  <button
                    type="button"
                    className="rounded border border-white/15 px-3 py-2 text-left text-[11px] leading-snug text-zinc-300 hover:bg-white/[0.06]"
                    onClick={() => void handleDeleteDemo(libraryDeletePrompt.id, "skip")}
                  >
                    删除后再次扫描不再入库
                    <span className="mt-0.5 block text-[10px] font-normal text-zinc-500">
                      之后目录监听与手动扫描都会跳过该路径；仅改文件名或移动文件可视为新路径再入库。
                    </span>
                  </button>
                </div>
                <div className="mt-4 flex justify-end">
                  <button
                    type="button"
                    className="rounded border border-cs2-border px-2 py-1 text-[11px] text-zinc-400 hover:text-zinc-200"
                    onClick={() => setLibraryDeletePrompt(null)}
                  >
                    取消
                  </button>
                </div>
              </div>
            </div>
          ) : null}

          {libraryRename ? (
            <div
              className="fixed inset-0 z-[100] flex items-center justify-center bg-black/55 px-4"
              role="dialog"
              aria-modal="true"
              aria-labelledby="library-rename-title"
              onClick={() => setLibraryRename(null)}
            >
              <div
                className="w-full max-w-sm rounded-lg border border-white/15 bg-cs2-bg-card p-4 shadow-xl"
                onClick={(e) => e.stopPropagation()}
              >
                <h4 id="library-rename-title" className="mb-2 text-xs font-semibold text-zinc-300">
                  Demo 展示名
                </h4>
                <p className="mb-2 text-[10px] leading-relaxed text-cs2-text-secondary">
                  仅保存在本地库中，不修改磁盘上的 .dem 文件名。留空并保存则恢复为文件名显示。
                </p>
                <input
                  type="text"
                  className="mb-3 w-full rounded border border-cs2-border bg-cs2-bg-input px-2 py-1.5 font-mono text-[11px] text-zinc-200 outline-none focus:border-cs2-orange/50"
                  value={libraryRename.draft}
                  onChange={(e) =>
                    setLibraryRename((prev) => (prev ? { ...prev, draft: e.target.value } : null))
                  }
                  maxLength={512}
                  autoFocus
                />
                <div className="flex justify-end gap-2">
                  <button
                    type="button"
                    className="rounded border border-cs2-border px-2 py-1 text-[11px] text-zinc-400 hover:text-zinc-200"
                    onClick={() => setLibraryRename(null)}
                  >
                    取消
                  </button>
                  <button
                    type="button"
                    className="rounded border border-cs2-orange/50 bg-cs2-orange/15 px-2 py-1 text-[11px] font-semibold text-cs2-orange hover:bg-cs2-orange/25"
                    onClick={() => void handleSaveLibraryRename()}
                  >
                    保存
                  </button>
                </div>
              </div>
            </div>
          ) : null}

          {!hasDemos && !parsing && <DemoUpload onUpload={handleUpload} />}
          {!hasDemos && parsing && (
            <div className="flex flex-col items-center justify-center rounded-xl border border-white/10 bg-cs2-bg-card py-16 text-center">
              <Loader2 className="h-9 w-9 animate-spin text-cs2-orange" aria-hidden />
              <p className="mt-4 text-sm font-medium text-zinc-300">正在处理 Demo…</p>
            </div>
          )}

          {hasDemos && (
            <div className="space-y-3">
              <div className="rounded-lg border border-white/10 bg-cs2-bg-card px-3 py-3">
                <div className="mb-2 flex flex-wrap items-center gap-2 text-[11px] text-cs2-text-secondary">
                  <span className="shrink-0 font-semibold text-zinc-400">当前场次</span>
                  <span className="truncate font-mono text-zinc-300" title={currentFilename}>
                    {currentFilename}
                  </span>
                  {currentParsed && (
                    <span className="rounded border border-emerald-500/30 bg-emerald-500/10 px-1.5 py-0 text-[10px] font-semibold text-emerald-400/90">
                      已解析
                    </span>
                  )}
                  {uploadedDemos.length > 1 && (
                    <span className="rounded border border-white/10 px-1.5 py-0 text-[10px] text-zinc-500">
                      共 {uploadedDemos.length} 个文件
                    </span>
                  )}
                </div>
                <MatchSwitcher
                  matches={matchTabsData}
                  currentIndex={currentMatchIndex}
                  onChange={setCurrentMatchIndex}
                  disabled={batchRecording}
                />
              </div>

              {players.length > 0 && (
                <div className="space-y-4">
                  {matchMeta && <MatchScoreboard matchMeta={matchMeta} />}
                  <PlayerSelect
                    players={players}
                    selected={selectedPlayersList}
                    onSelect={(name) =>
                      setSelectedPlayers((prev) => {
                        const cur = prev[currentMatchIndex] ?? [];
                        const next = cur.includes(name)
                          ? cur.filter((n) => n !== name)
                          : [...cur, name];
                        return { ...prev, [currentMatchIndex]: next };
                      })
                    }
                    onAnalyze={handleParse}
                    disabled={
                      batchRecording ||
                      parsing ||
                      Boolean(parsingByIndex[currentMatchIndex])
                    }
                  />
                </div>
              )}
            </div>
          )}

          {(anyDemoParsing || progressText || batchRecording) && (
            <ProgressBar
              text={progressText || (batchRecording ? "正在批量录制…" : "")}
              active={anyDemoParsing}
              batchRecording={batchRecording}
              onAbortBatch={handleAbortBatchRecording}
            />
          )}
          {(clips.length > 0 || parsedPlayerNames.length > 0) && currentParsed && (
            <ClipList
              clips={clips}
              targetPlayer={matchMeta?.target_player ?? ""}
              selectedIds={selectedClientClipUids}
              onToggle={handleToggleClip}
              aiMode={aiMode}
              queuedClientClipUids={queuedClientClipUidsForCurrentDemo}
              playerTabs={parsedPlayerNames}
              activePlayerTab={currentActivePlayer}
              onPlayerTabChange={(name) =>
                setActivePlayerTabs((prev) => ({ ...prev, [currentMatchIndex]: name }))
              }
              parsedPlayers={currentParsed?.players ?? {}}
              matchTotalRounds={roundMontageMaxRounds}
              freezeToDeathDraft={freezeToDeathDraft}
              onFreezeToDeathDraftChange={setFreezeToDeathDraft}
              roundMontagePickerDisabled={Boolean(
                parsing || parsingByIndex[currentMatchIndex] || batchRecording
              )}
            />
          )}
        </div>

        {clips.length > 0 && (
          <ActionBar
            selectedCount={selectedRegularCount}
            totalCount={regularSelectableTotal}
            hasSelection={selectedClientClipUids.size > 0}
            onSelectAll={handleSelectAll}
            onDeselectAll={handleDeselectAll}
            onAddSelectedToQueue={handleAddSelectedToQueue}
            onAddAllHighlightsAllMatches={handleAddAllHighlightsAllMatches}
            queueLength={queue.length}
            batchRecording={batchRecording}
            canAddAllHighlights={Boolean(
              parsedMatches?.some((pm) =>
                Object.values(pm?.players ?? {}).some((pd) =>
                  pd.clips?.some((c) => c.category === "highlight")
                )
              )
            )}
          />
        )}
      </main>

      <CommonParamsModal
        open={commonParamsOpen}
        onClose={() => setCommonParamsOpen(false)}
        batchRecording={batchRecording}
        savedWarmupDefaults={savedRecordWarmupDefaults}
        onPersistWarmupDefaults={persistWarmupDefaults}
      />

      <RecordingQueueDrawer
        open={queueDrawerOpen}
        onClose={() => setQueueDrawerOpen(false)}
        queue={queue}
        onRemove={removeFromQueue}
        onClear={clearQueue}
        onStartBatch={openBatchWarmup}
        batchRecording={batchRecording}
        onAbortBatch={handleAbortBatchRecording}
      />

      <RecordWarmupModal
        open={recordWarmupOpen}
        onClose={() => {
          setRecordWarmupOpen(false);
          setWarmupIntent(null);
        }}
        onConfirm={handleWarmupConfirm}
        onWarmupValidationError={(msg) => setRecordingBlockedMessage(msg)}
        defaultOverrides={savedRecordWarmupDefaults ?? undefined}
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
  );
}
