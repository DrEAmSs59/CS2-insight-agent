import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import axios from "axios";
import { useMontageStore } from "../stores/montageStore";
import MontageHistoryPanel from "./montage/MontageHistoryPanel";
import { Loader2 } from "lucide-react";
import {
  MontageWorkbenchToolbar,
  MontageOrchestrationTimeline,
  MontageMaterialPoolCard,
} from "./montage/MontageWorkbenchPanels";
import { MontageStyleConsole } from "./montage/MontageStyleConsole";
import {
  sortClipsByStrategy,
  ensureMp4Filename,
  stripMp4Extension,
  normalizeClipType,
  getClipTitle,
  getClipDurationSeconds,
  formatMontageEstimate,
  mapNameFromClip,
  getMontageTimelineVariant,
  isTimelineSourceClip,
} from "../utils/montageUtils";

const API = axios.create({ baseURL: "/api" });

const FILTER_TABS = [
  { id: "all", label: "全部" },
  { id: "highlight", label: "高光" },
  { id: "timeline", label: "时间线" },
  { id: "fail", label: "下饭" },
  { id: "compilation", label: "合集" },
  { id: "joined", label: "已加入" },
  { id: "unjoined", label: "未加入" },
];

const DEFAULT_REL_EXPORT_DIR = "exports/montage";

const TRANSITION_TYPES = [
  { id: "none", label: "无转场" },
  { id: "cut", label: "快切" },
  { id: "fade", label: "淡入淡出" },
  { id: "flash", label: "闪白" },
  { id: "dip_black", label: "黑场淡入淡出" },
  { id: "zoom", label: "轻微缩放" },
];

const DEFAULT_TRANSITION = { type: "cut", duration: 0.25 };

/** 全局一键类型 /「统一时长」使用的固定秒数（不再单独暴露滑条） */
const GLOBAL_TRANSITION_PRESET_SEC = 0.4;

const GLOBAL_TRANSITION_TEMPLATES = [
  { id: "esports", label: "竞技快切" },
  { id: "film", label: "电影感淡入淡出" },
  { id: "funny", label: "下饭搞笑" },
  { id: "clean", label: "无转场纯净版" },
];

const VALID_TRANSITION_TYPES = new Set(TRANSITION_TYPES.map((t) => t.id));

function transitionTypeLabel(type) {
  return TRANSITION_TYPES.find((t) => t.id === type)?.label || "快切";
}

function normalizeTransition(raw) {
  const type = VALID_TRANSITION_TYPES.has(raw?.type) ? raw.type : DEFAULT_TRANSITION.type;
  let duration = Number(raw?.duration);
  if (!Number.isFinite(duration)) duration = DEFAULT_TRANSITION.duration;
  if (type === "none") duration = 0;
  else duration = Math.min(1.5, Math.max(0, duration));
  return { type, duration };
}

function getEffectiveTransition(map, sourceClipId) {
  const key = String(sourceClipId);
  const raw = map?.[key];
  return raw ? normalizeTransition(raw) : { ...DEFAULT_TRANSITION };
}

function formatTransitionNodeLine(map, sourceClipId) {
  const tr = getEffectiveTransition(map, sourceClipId);
  if (tr.type === "none") return "无转场";
  const d = tr.duration;
  const ds = Number.isInteger(d) ? String(d) : String(Math.round(d * 100) / 100);
  return `${transitionTypeLabel(tr.type)} · ${ds}s`;
}

/** Only gaps between consecutive ordered clips (source = clip at index i). */
function buildTransitionsPayload(orderedIds, transitionByClipId) {
  const out = {};
  for (let i = 0; i < orderedIds.length - 1; i++) {
    const sid = orderedIds[i];
    const key = String(sid);
    out[key] = normalizeTransition(getEffectiveTransition(transitionByClipId, sid));
  }
  return out;
}

function hydrateTransitionsFromApi(raw) {
  if (!raw || typeof raw !== "object") return {};
  const out = {};
  for (const [k, v] of Object.entries(raw)) {
    if (v && typeof v === "object") out[String(k)] = normalizeTransition(v);
  }
  return out;
}

function pruneTransitionsToOrderedIds(prev, orderedIds) {
  const allowed = new Set(orderedIds.map((id) => String(id)));
  const next = {};
  for (const [k, v] of Object.entries(prev || {})) {
    if (allowed.has(k)) next[k] = v;
  }
  return next;
}

function buildGlobalTransitionStyleMap(styleId, orderedIds) {
  const next = {};
  const n = orderedIds.length;
  for (let i = 0; i < n - 1; i++) {
    const key = String(orderedIds[i]);
    if (styleId === "esports") {
      const useFlash = (i + 1) % 3 === 0;
      next[key] = useFlash ? { type: "flash", duration: 0.25 } : { type: "cut", duration: 0.15 };
    } else if (styleId === "film") {
      next[key] = { type: "fade", duration: 0.4 };
    } else if (styleId === "funny") {
      next[key] = { type: "dip_black", duration: 0.6 };
    } else if (styleId === "clean") {
      next[key] = { type: "none", duration: 0 };
    }
  }
  return next;
}

function buildTimestampMontageFilename() {
  const now = new Date();
  const y = now.getFullYear();
  const m = String(now.getMonth() + 1).padStart(2, "0");
  const d = String(now.getDate()).padStart(2, "0");
  const h = String(now.getHours()).padStart(2, "0");
  const min = String(now.getMinutes()).padStart(2, "0");
  return `montage_${y}${m}${d}_${h}${min}.mp4`;
}

function clipBasename(clip) {
  const p = clip?.output_path || "";
  if (!p) return "";
  const parts = String(p).split(/[/\\]/);
  return parts[parts.length - 1] || "";
}

function dirnamePath(p) {
  const s = String(p || "");
  const i = Math.max(s.lastIndexOf("/"), s.lastIndexOf("\\"));
  return i >= 0 ? s.slice(0, i) : "";
}

function joinPathSegments(base, ...segments) {
  if (!base) return segments.join("/");
  const sep = String(base).includes("\\") ? "\\" : "/";
  let out = String(base).replace(/[/\\]+$/, "");
  for (const seg of segments) {
    const t = String(seg).replace(/^[/\\]+/, "");
    if (t) out += sep + t;
  }
  return out;
}

/** Lowercase blob for weak template / filter matching (tolerates missing API fields). */
function clipWeakBlob(clip) {
  if (!clip || typeof clip !== "object") return "";
  return [
    clip.clip_id,
    clipBasename(clip),
    clip.demo_filename,
    clip.timeline_source,
    clip.category,
    clip.compilation_kind,
    clip.clip_type,
    clip.type,
    Array.isArray(clip.tags) ? clip.tags.join(" ") : clip.tags,
  ]
    .filter(Boolean)
    .join(" ")
    .toLowerCase();
}

function librarySearchMatch(clip, q) {
  const k = (q || "").trim().toLowerCase();
  if (!k) return true;
  const idStr = clip?.clip_id != null ? String(clip.clip_id).toLowerCase() : "";
  const fn = clipBasename(clip).toLowerCase();
  const player = String(clip?.player_name || "").toLowerCase();
  const map = String(mapNameFromClip(clip) || "").toLowerCase();
  const tags = Array.isArray(clip?.context_tags) ? clip.context_tags.join(" ").toLowerCase() : "";
  return fn.includes(k) || idStr.includes(k) || player.includes(k) || map.includes(k) || tags.includes(k);
}

function clipMatchesLibraryFilter(clip, filterKey, orderedIdSet) {
  if (!clip || typeof clip !== "object") return false;
  const id = clip.id;
  if (filterKey === "joined") return orderedIdSet.has(id);
  if (filterKey === "unjoined") return !orderedIdSet.has(id);
  if (filterKey === "all") return true;
  const t = normalizeClipType(clip);
  const b = clipWeakBlob(clip);
  const fn = clipBasename(clip);
  if (filterKey === "highlight") {
    if (isTimelineSourceClip(clip)) return false;
    if (clip.category === "highlight") return true;
    if (t === "高光") return true;
    if (/\bhighlight\b|高光/.test(b)) return true;
    const km = fn.match(/(\d+)k/i);
    if (km) {
      const n = parseInt(km[1], 10);
      if (n >= 3 && n < 48) return true;
    }
    return false;
  }
  if (filterKey === "timeline") {
    return isTimelineSourceClip(clip);
  }
  if (filterKey === "fail") {
    if (clip.category === "fail" || clip.category === "meme_death") return true;
    if (t === "下饭" || t === "梗死亡") return true;
    if (/\bfail\b|下饭|meme_death|meme|funny|1d|电击/.test(b)) return true;
    if (/[_-]1d[_-]/i.test(fn)) return true;
    return false;
  }
  if (filterKey === "compilation") {
    if (clip.category === "compilation") return true;
    if (b.includes("compilation") || b.includes("合集")) return true;
    if (/_\d+d_/i.test(fn)) return true;
    const mk = fn.match(/(\d+)k/i);
    if (mk && parseInt(mk[1], 10) >= 10) return true;
    return false;
  }
  return true;
}

function humanizeExportError(err) {
  const s = String(err || "").trim();
  if (!s) return "导出失败，请稍后重试。";
  if (s.includes("recorded_clip_ids") || s.includes("不能为空")) return "请先从左侧素材库加入至少一个片段。";
  return s;
}

export default function MontageWorkbenchDrawer({ open, onClose, layout = "drawer" }) {
  const isPage = layout === "page";
  const [loading, setLoading] = useState(false);
  const [items, setItems] = useState([]);
  const [orderedIds, setOrderedIds] = useState([]);
  const [bgmPath, setBgmPath] = useState("");
  const [bgmStartSec, setBgmStartSec] = useState(0);
  const [introPath, setIntroPath] = useState("");
  const [introDuration, setIntroDuration] = useState(3);
  const [outroPath, setOutroPath] = useState("");
  const [outroDuration, setOutroDuration] = useState(3);
  const [outputFilename, setOutputFilename] = useState(() => buildTimestampMontageFilename());
  const [outputDir, setOutputDir] = useState("");
  const exporting = useMontageStore((s) => s.exporting);
  const setExporting = useMontageStore((s) => s.setExporting);
  const lastExport = useMontageStore((s) => s.lastExport);
  const setLastExport = useMontageStore((s) => s.setLastExport);
  const markExportRead = useMontageStore((s) => s.markExportRead);
  const [projectId, setProjectId] = useState(null);
  const [draftName, setDraftName] = useState("");
  const [selectedThemeId, setSelectedThemeId] = useState("custom");
  const [radarOverlayEnabled, setRadarOverlayEnabled] = useState(false);
  const [bgmVolume, setBgmVolume] = useState(70);
  const [filterKey, setFilterKey] = useState("all");
  const [searchQ, setSearchQ] = useState("");
  const [toast, setToast] = useState(null);
  const [savingDraft, setSavingDraft] = useState(false);
  const [dragId, setDragId] = useState(null);
  const [transitionByClipId, setTransitionByClipId] = useState({});
  const [historyOpen, setHistoryOpen] = useState(false);
  const [deleteClipPrompt, setDeleteClipPrompt] = useState(null);
  const [batchDeleteLibraryPrompt, setBatchDeleteLibraryPrompt] = useState(null);
  const [librarySelectedIds, setLibrarySelectedIds] = useState(() => new Set());
  const [selectedTimelineClipId, setSelectedTimelineClipId] = useState(null);
  const [timelineMultiSelectedIds, setTimelineMultiSelectedIds] = useState(() => new Set());
  const [transitionEdgeSourceId, setTransitionEdgeSourceId] = useState(null);
  const [draftDirty, setDraftDirty] = useState(false);
  const [lastDraftSavedAt, setLastDraftSavedAt] = useState(null);
  const draftDirtyBoot = useRef(true);

  const toastTimer = useRef(null);

  const showToast = useCallback((msg) => {
    if (toastTimer.current) clearTimeout(toastTimer.current);
    setToast(msg);
    toastTimer.current = setTimeout(() => {
      setToast(null);
      toastTimer.current = null;
    }, 3200);
  }, []);

  const pickFile = useCallback(async (fileType, onResult) => {
    try {
      const { data } = await API.post("/file-picker", { file_type: fileType });
      if (data?.path) onResult(data.path);
    } catch (e) {
      const detail = e.response?.data?.detail;
      showToast(typeof detail === "string" ? detail : "文件选择器不可用（仅 Windows）");
    }
  }, [showToast]);

  const loadClips = useCallback(async () => {
    setLoading(true);
    try {
      const { data } = await API.get("/recorded-clips", { params: { limit: 500, offset: 0 } });
      setItems(data.items || []);
    } catch {
      setItems([]);
      showToast("片段列表加载失败，请重试");
    } finally {
      setLoading(false);
    }
  }, [showToast]);

  useEffect(() => {
    if (!open && !isPage) return;
    void loadClips();
  }, [open, loadClips, isPage]);

  useEffect(() => {
    if (!open && !isPage) return;
    if (!lastExport?.unread || exporting) return;
    if (lastExport.ok) {
      showToast("合辑导出已完成");
    } else if (lastExport.err) {
      showToast(lastExport.err);
    }
    markExportRead();
  }, [open, isPage, lastExport, exporting, showToast, markExportRead]);

  useEffect(() => {
    if (!open && !isPage) {
      setDeleteClipPrompt(null);
      setBatchDeleteLibraryPrompt(null);
    }
  }, [open, isPage]);

  useEffect(() => {
    if (selectedTimelineClipId != null && !orderedIds.includes(selectedTimelineClipId)) {
      setSelectedTimelineClipId(null);
    }
    setTimelineMultiSelectedIds((prev) => {
      const next = new Set(prev);
      let changed = false;
      for (const id of prev) {
        if (!orderedIds.includes(id)) {
          next.delete(id);
          changed = true;
        }
      }
      return changed ? next : prev;
    });
  }, [orderedIds, selectedTimelineClipId]);

  useEffect(() => {
    if (transitionEdgeSourceId == null) return;
    const idx = orderedIds.indexOf(transitionEdgeSourceId);
    if (idx < 0 || idx >= orderedIds.length - 1) {
      setTransitionEdgeSourceId(null);
    }
  }, [orderedIds, transitionEdgeSourceId]);

  useEffect(() => {
    if (draftDirtyBoot.current) {
      draftDirtyBoot.current = false;
      return;
    }
    setDraftDirty(true);
  }, [
    orderedIds,
    transitionByClipId,
    bgmPath,
    bgmStartSec,
    introPath,
    introDuration,
    outroPath,
    outroDuration,
    outputFilename,
    outputDir,
    radarOverlayEnabled,
    selectedThemeId,
    draftName,
    bgmVolume,
  ]);

  const byId = useMemo(() => {
    const m = new Map();
    for (const it of items) m.set(it.id, it);
    return m;
  }, [items]);

  const orderedIdSet = useMemo(() => new Set(orderedIds), [orderedIds]);

  const orderedClips = useMemo(() => orderedIds.map((id) => byId.get(id)).filter(Boolean), [orderedIds, byId]);

  // 雷达叠层：仅当时间轴含 POV HUD 录制片段（入库 pov_hud_enabled）时才允许开启
  const hasPovClips = useMemo(
    () => orderedClips.some((c) => c?.pov_hud_enabled === true),
    [orderedClips],
  );

  useEffect(() => {
    if (!hasPovClips && radarOverlayEnabled) setRadarOverlayEnabled(false);
  }, [hasPovClips, radarOverlayEnabled]);

  const unknownDurationHint = useMemo(() => {
    if (orderedClips.length === 0) return null;
    const anyUnknown = orderedClips.some((c) => getClipDurationSeconds(c) == null);
    return anyUnknown ? "部分片段时长未知，导出时以后端为准" : null;
  }, [orderedClips]);

  const totalKnownSeconds = useMemo(() => {
    let s = 0;
    for (const c of orderedClips) {
      const d = getClipDurationSeconds(c);
      if (d != null) s += d;
    }
    return s;
  }, [orderedClips]);

  const filteredLibrary = useMemo(() => {
    return items.filter((clip) => {
      if (!clipMatchesLibraryFilter(clip, filterKey, orderedIdSet)) return false;
      return librarySearchMatch(clip, searchQ);
    });
  }, [items, filterKey, searchQ, orderedIdSet]);

  const transitionsPayload = useMemo(
    () => buildTransitionsPayload(orderedIds, transitionByClipId),
    [orderedIds, transitionByClipId],
  );

  const orderedIdsAsStrings = useMemo(() => orderedIds.map(String), [orderedIds]);

  const effectiveOutputDir = useMemo(() => {
    const trimmed = outputDir.trim();
    if (trimmed) return trimmed.replace(/[/\\]+$/, "");
    const firstPath = orderedClips.find((c) => c?.output_path)?.output_path || items.find((c) => c?.output_path)?.output_path;
    if (firstPath) {
      const base = dirnamePath(firstPath);
      return joinPathSegments(base, ...DEFAULT_REL_EXPORT_DIR.split("/"));
    }
    return "";
  }, [outputDir, orderedClips, items]);

  const addToSequence = useCallback((id) => {
    setOrderedIds((prev) => (prev.includes(id) ? prev : [...prev, id]));
  }, []);

  const addFilteredToSequence = useCallback(() => {
    let added = 0;
    setOrderedIds((prev) => {
      const set = new Set(prev);
      for (const c of filteredLibrary) {
        if (!set.has(c.id)) added += 1;
        set.add(c.id);
      }
      return Array.from(set);
    });
    if (added > 0) showToast(`已加入 ${added} 个新片段到编排（当前筛选共 ${filteredLibrary.length} 条）`);
    else showToast("当前筛选中的片段均已加入编排时间线");
  }, [filteredLibrary, showToast]);

  const removeFromSequence = useCallback((id) => {
    setOrderedIds((prev) => prev.filter((x) => x !== id));
    setTransitionByClipId((prev) => {
      const next = { ...prev };
      delete next[String(id)];
      return next;
    });
    setTimelineMultiSelectedIds((prev) => {
      if (!prev.has(id)) return prev;
      const next = new Set(prev);
      next.delete(id);
      return next;
    });
  }, []);

  const confirmDeleteLibraryClip = useCallback(async () => {
    const clip = deleteClipPrompt;
    if (!clip) return;
    try {
      await API.delete(`/recorded-clips/${clip.id}`);
      setOrderedIds((prev) => prev.filter((x) => x !== clip.id));
      setTransitionByClipId((prev) => {
        const next = { ...prev };
        delete next[String(clip.id)];
        return next;
      });
      setItems((prev) => prev.filter((x) => x.id !== clip.id));
      setLibrarySelectedIds((prev) => {
        if (!prev.has(clip.id)) return prev;
        const next = new Set(prev);
        next.delete(clip.id);
        return next;
      });
      setTimelineMultiSelectedIds((prev) => {
        if (!prev.has(clip.id)) return prev;
        const next = new Set(prev);
        next.delete(clip.id);
        return next;
      });
      setDeleteClipPrompt(null);
      showToast("已删除片段");
    } catch (e) {
      const detail = e.response?.data?.detail;
      showToast(typeof detail === "string" ? detail : e.message || "删除失败");
    }
  }, [deleteClipPrompt, showToast]);

  const openBatchDeleteLibraryPrompt = useCallback(() => {
    const clips = items.filter((c) => librarySelectedIds.has(c.id));
    if (!clips.length) {
      showToast("没有可删除的选中项");
      return;
    }
    setDeleteClipPrompt(null);
    setBatchDeleteLibraryPrompt(clips);
  }, [items, librarySelectedIds, showToast]);

  const confirmBatchDeleteLibraryClips = useCallback(async () => {
    const clips = batchDeleteLibraryPrompt;
    if (!clips?.length) return;
    const ids = clips.map((c) => c.id);
    try {
      const { data } = await API.post("/recorded-clips/batch-delete", { ids });
      const deletedList = Array.isArray(data?.deleted) ? data.deleted : [];
      const deletedIds = new Set(deletedList.map((d) => d.id));
      const notFound = Array.isArray(data?.not_found) ? data.not_found : [];
      setOrderedIds((prev) => prev.filter((id) => !deletedIds.has(id)));
      setTransitionByClipId((prev) => {
        const next = { ...prev };
        for (const id of deletedIds) delete next[String(id)];
        return next;
      });
      setItems((prev) => prev.filter((x) => !deletedIds.has(x.id)));
      setLibrarySelectedIds((prev) => {
        const next = new Set(prev);
        for (const id of deletedIds) next.delete(id);
        return next;
      });
      setTimelineMultiSelectedIds((prev) => {
        const next = new Set(prev);
        for (const id of deletedIds) next.delete(id);
        return next;
      });
      setBatchDeleteLibraryPrompt(null);
      const n = deletedIds.size;
      if (notFound.length) {
        showToast(`已删除 ${n} 条；另有 ${notFound.length} 条已不存在或已删`);
      } else {
        showToast(`已删除 ${n} 条素材`);
      }
    } catch (e) {
      const detail = e.response?.data?.detail;
      showToast(typeof detail === "string" ? detail : e.message || "批量删除失败");
    }
  }, [batchDeleteLibraryPrompt, showToast]);

  const handleSort = useCallback(
    (strategy) => {
      const clips = orderedIds.map((id) => byId.get(id)).filter(Boolean);
      const sorted = sortClipsByStrategy(clips, strategy);
      setOrderedIds(sorted.map((c) => c.id));
    },
    [orderedIds, byId],
  );

  const applyGlobalTransitionTemplate = useCallback(
    (styleId, label) => {
      if (orderedIds.length < 2) {
        showToast("至少需要 2 个片段才能设置转场");
        return;
      }
      const built = buildGlobalTransitionStyleMap(styleId, orderedIds);
      setTransitionByClipId((prev) => {
        const cleared = { ...prev };
        for (const id of orderedIds) delete cleared[String(id)];
        return { ...cleared, ...built };
      });
      showToast(`已应用「${label}」`);
    },
    [orderedIds, showToast],
  );

  const applyGlobalTransitionType = useCallback(
    (type) => {
      if (orderedIds.length < 2) {
        showToast("至少需要 2 个片段才能设置转场");
        return;
      }
      const dur = type === "none" ? 0 : Math.min(1.5, GLOBAL_TRANSITION_PRESET_SEC);
      setTransitionByClipId((prev) => {
        const cleared = { ...prev };
        for (const id of orderedIds) delete cleared[String(id)];
        const next = { ...cleared };
        for (let i = 0; i < orderedIds.length - 1; i++) {
          const key = String(orderedIds[i]);
          next[key] = normalizeTransition({ type, duration: dur });
        }
        return next;
      });
      showToast(`已全局应用「${transitionTypeLabel(type)}」`);
    },
    [orderedIds, showToast],
  );

  const applyGlobalDurationToAll = useCallback(() => {
    if (orderedIds.length < 2) {
      showToast("至少需要 2 个片段");
      return;
    }
    const sec = Math.min(1.5, GLOBAL_TRANSITION_PRESET_SEC);
    setTransitionByClipId((prev) => {
      const next = { ...prev };
      for (let i = 0; i < orderedIds.length - 1; i++) {
        const id = orderedIds[i];
        const cur = getEffectiveTransition(prev, id);
        if (cur.type === "none") continue;
        next[String(id)] = normalizeTransition({ ...cur, duration: sec });
      }
      return next;
    });
    showToast("已统一时长（跳过「无转场」衔接）");
  }, [orderedIds, showToast]);

  const applyRandomTransitions = useCallback(() => {
    if (orderedIds.length < 2) {
      showToast("至少需要 2 个片段");
      return;
    }
    const pool = ["cut", "fade", "flash", "dip_black", "zoom"];
    setTransitionByClipId((prev) => {
      const next = { ...prev };
      for (let i = 0; i < orderedIds.length - 1; i++) {
        const id = orderedIds[i];
        const type = pool[Math.floor(Math.random() * pool.length)];
        const duration = Math.round((0.12 + Math.random() * 0.38) * 1000) / 1000;
        next[String(id)] = normalizeTransition({ type, duration });
      }
      return next;
    });
    showToast("已为每条连接随机分配转场");
  }, [orderedIds, showToast]);

  const applyKillTypeTransitions = useCallback(() => {
    if (orderedIds.length < 2) {
      showToast("至少需要 2 个片段");
      return;
    }
    setTransitionByClipId((prev) => {
      const next = { ...prev };
      for (let i = 0; i < orderedIds.length - 1; i++) {
        const id = orderedIds[i];
        const clip = byId.get(id);
        const v = getMontageTimelineVariant(clip);
        let type = "cut";
        let duration = 0.2;
        if (v === "fail") {
          type = "dip_black";
          duration = 0.45;
        } else if (v === "ace" || v === "multikill") {
          type = "flash";
          duration = 0.22;
        } else if (v === "highlight") {
          type = "fade";
          duration = 0.35;
        } else if (v === "timeline") {
          type = "cut";
          duration = 0.22;
        } else if (v === "compilation") {
          type = "zoom";
          duration = 0.3;
        } else {
          type = "fade";
          duration = 0.28;
        }
        next[String(id)] = normalizeTransition({ type, duration });
      }
      return next;
    });
    showToast("已按片段类型生成转场节奏");
  }, [orderedIds, byId, showToast]);

  const validateExport = useCallback(() => {
    if (orderedIds.length < 1) {
      return "请先从左侧素材库加入至少一个片段。";
    }
    const name = outputFilename.trim();
    if (!name) {
      return "请填写输出文件名。";
    }
    if (!effectiveOutputDir) {
      return "无法确定导出目录：请先加入至少一个已录片段（将使用其所在磁盘下的 exports/montage），或手动填写输出目录。";
    }
    return null;
  }, [orderedIds.length, outputFilename, effectiveOutputDir]);

  const saveDraft = useCallback(async () => {
    const effectiveName =
      draftName.trim() || stripMp4Extension(outputFilename).trim() || outputFilename.trim();
    if (!effectiveName) {
      showToast("请填写草稿名称，或先填写输出文件名。");
      return;
    }
    setSavingDraft(true);
    try {
      const { data } = await API.post("/montage/projects", {
        project_id: projectId,
        name: effectiveName,
        recorded_clip_ids: orderedIds,
        bgm_path: bgmPath.trim() || null,
        bgm_start_sec: bgmStartSec > 0 ? bgmStartSec : undefined,
        intro_path: introPath.trim() || null,
        intro_image_duration: introDuration !== 3 ? introDuration : undefined,
        outro_path: outroPath.trim() || null,
        outro_image_duration: outroDuration !== 3 ? outroDuration : undefined,
        output_filename: ensureMp4Filename(outputFilename.trim()) || "montage_export.mp4",
        transitions: transitionsPayload,
        radar_overlay: {
          enabled: radarOverlayEnabled,
        },
        theme_id: selectedThemeId,
        bgm_volume: bgmVolume / 100,
      });
      setProjectId(data.id);
      if (data?.body?.transitions && typeof data.body.transitions === "object") {
        setTransitionByClipId(hydrateTransitionsFromApi(data.body.transitions));
      }
      if (data?.body?.theme_id != null && String(data.body.theme_id).trim()) {
        setSelectedThemeId(String(data.body.theme_id).trim());
      }
      const bv = data?.body?.bgm_volume;
      if (bv != null && Number.isFinite(Number(bv))) {
        setBgmVolume(Math.round(Number(bv) * 100));
      }
      const ro = data?.body?.radar_overlay;
      if (ro && typeof ro === "object") {
        setRadarOverlayEnabled(Boolean(ro.enabled));
      }
      setDraftDirty(false);
      setLastDraftSavedAt(Date.now());
      showToast("草稿已保存");
    } catch (e) {
      showToast(e.response?.data?.detail || e.message || "保存失败");
    } finally {
      setSavingDraft(false);
    }
  }, [
    projectId,
    draftName,
    outputFilename,
    orderedIds,
    bgmPath,
    bgmStartSec,
    introPath,
    introDuration,
    outroPath,
    outroDuration,
    showToast,
    transitionsPayload,
    radarOverlayEnabled,
    selectedThemeId,
    bgmVolume,
  ]);

  const runExport = useCallback(async () => {
    const err = validateExport();
    if (err) {
      showToast(err);
      return;
    }
    const dir = effectiveOutputDir;
    const fn = ensureMp4Filename(outputFilename.trim());
    const sep = dir.includes("\\") ? "\\" : "/";
    const outPath = dir.replace(/[/\\]+$/, "") + sep + fn;
    setExporting(true);
    setLastExport(null);
    try {
      const { data } = await API.post("/montage/export", {
        project_id: projectId,
        recorded_clip_ids: orderedIds.length ? orderedIds : undefined,
        ordered_ids: orderedIdsAsStrings,
        transitions: transitionsPayload,
        bgm_path: bgmPath.trim() || null,
        ...(bgmPath.trim() ? { bgm_volume: bgmVolume / 100 } : {}),
        ...(bgmPath.trim() && bgmStartSec > 0 ? { bgm_start_sec: bgmStartSec } : {}),
        intro_path: introPath.trim() || null,
        ...(introPath.trim() ? { intro_image_duration: introDuration } : {}),
        outro_path: outroPath.trim() || null,
        ...(outroPath.trim() ? { outro_image_duration: outroDuration } : {}),
        output_path: outPath,
        theme_id: selectedThemeId,
        radar_overlay: {
          enabled: radarOverlayEnabled,
        },
      });
      setLastExport({ ok: true, ...data });
      showToast("合辑导出完成");
    } catch (e) {
      const detail = e.response?.data?.detail;
      const errMsg = humanizeExportError(detail || e.message);
      setLastExport({ ok: false, err: errMsg });
      showToast(errMsg);
    } finally {
      setExporting(false);
    }
  }, [
    validateExport,
    projectId,
    orderedIds,
    orderedIdsAsStrings,
    transitionsPayload,
    bgmPath,
    bgmStartSec,
    introPath,
    introDuration,
    outroPath,
    outroDuration,
    effectiveOutputDir,
    outputFilename,
    selectedThemeId,
    radarOverlayEnabled,
    bgmVolume,
    showToast,
  ]);

  const copyText = useCallback(
    async (text) => {
      try {
        await navigator.clipboard.writeText(text);
        showToast("已复制到剪贴板");
      } catch {
        showToast("复制失败，请手动选择文本复制。");
      }
    },
    [showToast],
  );

  const clearTimeline = useCallback(() => {
    setOrderedIds([]);
    setTransitionByClipId({});
    setSelectedTimelineClipId(null);
    setTimelineMultiSelectedIds(new Set());
    setTransitionEdgeSourceId(null);
  }, []);

  const removeTimelineMulti = useCallback(() => {
    if (timelineMultiSelectedIds.size === 0) return;
    const drop = new Set(timelineMultiSelectedIds);
    setOrderedIds((prev) => prev.filter((id) => !drop.has(id)));
    setTransitionByClipId((prev) => {
      const next = { ...prev };
      for (const id of drop) delete next[String(id)];
      return next;
    });
    setTimelineMultiSelectedIds(new Set());
  }, [timelineMultiSelectedIds]);

  const onOrchestrationRowClick = useCallback((e, id) => {
    setTransitionEdgeSourceId(null);
    if (e.ctrlKey || e.metaKey) {
      setTimelineMultiSelectedIds((prev) => {
        const next = new Set(prev);
        if (next.has(id)) next.delete(id);
        else next.add(id);
        return next;
      });
      setSelectedTimelineClipId(id);
      return;
    }
    setTimelineMultiSelectedIds((prev) => {
      if (prev.size === 1 && prev.has(id)) return new Set();
      return new Set([id]);
    });
    setSelectedTimelineClipId((prev) => (prev === id ? null : id));
  }, []);

  const shiftTimelineSelection = useCallback(
    (delta) => {
      setOrderedIds((prev) => {
        const sel = timelineMultiSelectedIds;
        if (sel.size === 0) return prev;
        const indices = prev.map((id, i) => (sel.has(id) ? i : -1)).filter((i) => i >= 0);
        if (!indices.length) return prev;
        const sortedIdx = [...indices].sort((a, b) => a - b);
        const contiguous = sortedIdx.every((v, j, arr) => j === 0 || v === arr[j - 1] + 1);
        if (!contiguous) {
          queueMicrotask(() => showToast("批量移动请选中时间线上连续的片段"));
          return prev;
        }
        const blockStart = sortedIdx[0];
        const blockLen = sortedIdx.length;
        const blockEnd = sortedIdx[sortedIdx.length - 1];
        if (delta < 0 && blockStart === 0) return prev;
        if (delta > 0 && blockEnd >= prev.length - 1) return prev;
        const block = prev.slice(blockStart, blockStart + blockLen);
        const without = [...prev.slice(0, blockStart), ...prev.slice(blockStart + blockLen)];
        if (delta < 0) {
          const insertAt = blockStart - 1;
          return [...without.slice(0, insertAt), ...block, ...without.slice(insertAt)];
        }
        const insertAt = blockStart;
        return [...without.slice(0, insertAt), ...block, ...without.slice(insertAt)];
      });
    },
    [timelineMultiSelectedIds, showToast],
  );

  const onDragStart = useCallback((e, id) => {
    setDragId(id);
    e.dataTransfer.setData("text/plain", String(id));
    e.dataTransfer.effectAllowed = "move";
  }, []);

  const onDragEnd = useCallback(() => setDragId(null), []);

  const onDragOverItem = useCallback((e) => {
    e.preventDefault();
    e.dataTransfer.dropEffect = "move";
  }, []);

  /** Timeline rail / canvas drop: library → insert; timeline → reorder */
  const onTimelineCanvasDrop = useCallback((draggedId, targetId) => {
    if (!Number.isFinite(draggedId)) return;
    const onTimeline = orderedIds.includes(draggedId);
    if (!onTimeline) {
      setOrderedIds((prev) => {
        if (prev.includes(draggedId)) return prev;
        if (targetId == null) return [...prev, draggedId];
        const next = [...prev];
        const ti = next.indexOf(targetId);
        if (ti < 0) return [...prev, draggedId];
        next.splice(ti, 0, draggedId);
        return next;
      });
      setDragId(null);
      showToast("已加入时间线");
      return;
    }
    if (draggedId === targetId) return;
    setOrderedIds((prev) => {
      const next = prev.filter((x) => x !== draggedId);
      if (targetId == null) return [...next, draggedId];
      const ti = next.indexOf(targetId);
      if (ti < 0) return [...next, draggedId];
      next.splice(ti, 0, draggedId);
      return next;
    });
    setDragId(null);
  }, [orderedIds, showToast]);

  const patchTransition = useCallback((sourceClipId, patch) => {
    setTransitionByClipId((prev) => ({
      ...prev,
      [String(sourceClipId)]: normalizeTransition({
        ...getEffectiveTransition(prev, sourceClipId),
        ...patch,
      }),
    }));
  }, []);

  const durationText = formatMontageEstimate(totalKnownSeconds, orderedIds.length);

  const exportReady = useMemo(() => {
    if (orderedIds.length < 1) return false;
    if (!String(outputFilename || "").trim()) return false;
    if (!effectiveOutputDir) return false;
    return true;
  }, [orderedIds.length, outputFilename, effectiveOutputDir]);

  const fullOutputPathPreview = useMemo(() => {
    const dir = effectiveOutputDir;
    const fn = ensureMp4Filename(String(outputFilename || "").trim());
    if (!dir || !fn) return "";
    const sep = String(dir).includes("\\") ? "\\" : "/";
    return String(dir).replace(/[/\\]+$/, "") + sep + fn;
  }, [effectiveOutputDir, outputFilename]);

  const displayMontageTitle = useMemo(
    () => draftName.trim() || stripMp4Extension(outputFilename).trim() || "未命名合辑",
    [draftName, outputFilename],
  );

  const autosaveStatusLabel = useMemo(() => {
    if (draftDirty) return "改动未保存";
    if (lastDraftSavedAt) {
      try {
        return `草稿已保存 · ${new Date(lastDraftSavedAt).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}`;
      } catch {
        return "草稿已保存";
      }
    }
    return "自动保存就绪";
  }, [draftDirty, lastDraftSavedAt]);

  const libraryPoolStats = useMemo(() => {
    let known = 0;
    let sum = 0;
    for (const c of filteredLibrary) {
      const d = getClipDurationSeconds(c);
      if (d != null) {
        sum += d;
        known += 1;
      }
    }
    const n = filteredLibrary.length;
    return {
      count: n,
      totalLabel: formatMontageEstimate(sum, n),
      avgLabel: known > 0 ? `${(sum / known).toFixed(1)}s` : "—",
    };
  }, [filteredLibrary]);

  const onLibraryCardMultiClick = useCallback((e, id) => {
    if (e.ctrlKey || e.metaKey) {
      setLibrarySelectedIds((prev) => {
        const next = new Set(prev);
        if (next.has(id)) next.delete(id);
        else next.add(id);
        return next;
      });
      return;
    }
    setLibrarySelectedIds((prev) => {
      if (prev.size === 1 && prev.has(id)) return new Set();
      return new Set([id]);
    });
    setSelectedTimelineClipId(null);
  }, []);

  const selectAllFilteredLibrary = useCallback(() => {
    if (filteredLibrary.length === 0) return;
    setLibrarySelectedIds(new Set(filteredLibrary.map((c) => c.id)));
    setSelectedTimelineClipId(null);
  }, [filteredLibrary]);

  const addSelectionToTimeline = useCallback(() => {
    const ids = librarySelectedIds.size > 0 ? [...librarySelectedIds] : [];
    if (!ids.length) {
      showToast("请先选中多条素材（Ctrl / ⌘ 点选，或点「全选当前列表」），再点「批量加入编排」");
      return;
    }
    let added = 0;
    setOrderedIds((prev) => {
      const s = new Set(prev);
      for (const id of ids) {
        if (!s.has(id)) added += 1;
        s.add(id);
      }
      return Array.from(s);
    });
    showToast(added ? `已将 ${added} 条素材加入中间编排时间线` : "所选素材已在编排时间线中");
  }, [librarySelectedIds, showToast]);

  if (!open && !isPage) return null;

  const exportOk = lastExport?.ok && lastExport.output_path;
  const exportDirForButton = exportOk ? dirnamePath(lastExport.output_path) : "";

  const shellClass = isPage
    ? "flex h-full min-h-0 w-full flex-col overflow-hidden rounded-lg border border-white/[0.08]"
    : "flex h-full w-[min(1680px,99vw)] flex-col border-l border-white/10 bg-cs2-bg-card shadow-2xl";

  const inner = (
    <>
    <div className={shellClass}>
        <MontageWorkbenchToolbar
          isPage={isPage}
          montageTitle={displayMontageTitle}
          subtitle="电竞高光素材编排台"
          autosaveLabel={autosaveStatusLabel}
          onClose={onClose}
          onAutoSort={() => handleSort("highlight_first")}
          onTimelineSort={() => handleSort("timeline")}
          onRhythmSort={() => handleSort("rhythm")}
          onRandomSort={() => handleSort("random")}
          onSaveDraft={() => void saveDraft()}
          savingDraft={savingDraft}
          onHistory={() => setHistoryOpen(true)}
        />
        <MontageHistoryPanel open={historyOpen} onClose={() => setHistoryOpen(false)} />

        {toast ? (
          <div className="border-b border-emerald-500/30 bg-emerald-950/40 px-4 py-2 text-center text-[11px] text-emerald-200">
            {toast}
          </div>
        ) : null}

        <div className="flex min-h-0 flex-1 flex-col overflow-hidden">
          <div className="grid min-h-0 flex-1 grid-cols-1 gap-0 xl:grid-cols-[minmax(320px,380px)_minmax(0,1fr)_minmax(380px,440px)]">
            {/* 左侧素材池 */}
            <aside className="flex min-h-0 flex-col border-white/10 bg-black/20 xl:border-r">
              <div className="shrink-0 border-b border-white/10 px-3 py-2">
                <div className="flex items-baseline justify-between gap-2">
                  <p className="text-[10px] font-semibold uppercase tracking-wide text-zinc-500">素材池</p>
                  {librarySelectedIds.size > 0 ? (
                    <span className="rounded-full border border-cs2-orange/40 bg-cs2-orange/12 px-2 py-0.5 text-[10px] font-bold text-cs2-orange">
                      已选 {librarySelectedIds.size}
                    </span>
                  ) : (
                    <span className="text-[10px] text-zinc-600">多选</span>
                  )}
                </div>
                <p className="mt-1.5 rounded-md border border-white/[0.06] bg-black/25 px-2 py-1.5 text-[10px] leading-snug text-zinc-400">
                  <span className="font-semibold text-zinc-300">批量编排：</span>
                  按住键盘 <kbd className="rounded border border-white/15 bg-black/40 px-1 font-mono text-[9px]">Ctrl</kbd>{" "}
                  或 <kbd className="rounded border border-white/15 bg-black/40 px-1 font-mono text-[9px]">⌘</kbd>{" "}
                  不放，依次点击多条素材；也可点下方「全选当前列表」后批量加入或删除。
                </p>
                <div className="mt-1.5 grid grid-cols-3 gap-1 text-[10px] text-zinc-500">
                  <div className="rounded border border-white/[0.06] bg-black/30 px-1.5 py-1 text-center">
                    <div className="font-mono text-zinc-300">{libraryPoolStats.count}</div>
                    <div className="text-[9px] text-zinc-600">条</div>
                  </div>
                  <div className="rounded border border-white/[0.06] bg-black/30 px-1.5 py-1 text-center">
                    <div className="font-mono text-zinc-300">{libraryPoolStats.totalLabel}</div>
                    <div className="text-[9px] text-zinc-600">总时长</div>
                  </div>
                  <div className="rounded border border-white/[0.06] bg-black/30 px-1.5 py-1 text-center">
                    <div className="font-mono text-zinc-300">{libraryPoolStats.avgLabel}</div>
                    <div className="text-[9px] text-zinc-600">均值</div>
                  </div>
                </div>
              </div>
              <div className="shrink-0 space-y-2 border-b border-white/10 px-3 py-2">
                <div className="flex flex-wrap gap-1">
                  {FILTER_TABS.map((f) => (
                    <button
                      key={f.id}
                      type="button"
                      onClick={() => setFilterKey(f.id)}
                      className={`rounded-full border px-2 py-0.5 text-[10px] font-medium ${
                        filterKey === f.id
                          ? "border-cs2-orange/50 bg-cs2-orange/15 text-cs2-orange"
                          : "border-white/10 bg-black/30 text-zinc-400 hover:border-white/20"
                      }`}
                    >
                      {f.label}
                    </button>
                  ))}
                </div>
                <input
                  value={searchQ}
                  onChange={(e) => setSearchQ(e.target.value)}
                  placeholder="搜索玩家 / 地图 / 文件名…"
                  className="w-full rounded border border-white/10 bg-black/40 px-2.5 py-1.5 text-[11px] text-zinc-200 placeholder:text-zinc-600"
                />
                <div className="flex flex-col gap-1.5">
                  <button
                    type="button"
                    onClick={selectAllFilteredLibrary}
                    disabled={filteredLibrary.length === 0}
                    className="w-full rounded-md border border-white/12 bg-white/[0.04] py-1.5 text-[10px] font-semibold text-zinc-300 hover:border-white/22 disabled:opacity-35"
                  >
                    全选当前列表 ({filteredLibrary.length})
                  </button>
                  <div className="grid grid-cols-2 gap-1.5">
                    <button
                      type="button"
                      onClick={addFilteredToSequence}
                      disabled={filteredLibrary.length === 0}
                      className="rounded-md border border-white/12 bg-white/[0.04] py-1.5 text-[10px] font-semibold text-zinc-300 hover:border-cs2-orange/35 disabled:opacity-35"
                    >
                      筛选全部加入编排
                    </button>
                    <button
                      type="button"
                      onClick={addSelectionToTimeline}
                      disabled={librarySelectedIds.size === 0}
                      className="rounded-md border border-cs2-orange/35 bg-cs2-orange/10 py-1.5 text-[10px] font-semibold text-cs2-orange hover:bg-cs2-orange/18 disabled:opacity-35"
                    >
                      批量加入编排 ({librarySelectedIds.size})
                    </button>
                  </div>
                  <button
                    type="button"
                    onClick={openBatchDeleteLibraryPrompt}
                    disabled={librarySelectedIds.size === 0}
                    className="rounded-md border border-red-500/35 bg-red-950/25 py-1.5 text-[10px] font-semibold text-red-200/95 hover:border-red-500/50 hover:bg-red-950/40 disabled:opacity-35"
                  >
                    批量删除选中 ({librarySelectedIds.size})
                  </button>
                </div>
              </div>
              <div className="min-h-0 flex-1 overflow-y-auto px-2 pb-3 pt-2">
                {loading ? (
                  <div className="flex items-center gap-2 py-10 text-xs text-zinc-400">
                    <Loader2 className="h-4 w-4 animate-spin" />
                    加载中…
                  </div>
                ) : items.length === 0 ? (
                  <p className="rounded-lg border border-white/10 bg-black/30 px-3 py-6 text-[11px] text-zinc-500">
                    暂无入库片段。完成 OBS 录制成功后会自动出现在此列表。
                  </p>
                ) : filteredLibrary.length === 0 ? (
                  <p className="text-[11px] text-zinc-500">没有符合筛选或搜索条件的片段。</p>
                ) : (
                  <ul className="flex flex-col gap-1.5">
                    {filteredLibrary.map((clip, idx) => (
                      <MontageMaterialPoolCard
                        key={clip.id}
                        index={idx + 1}
                        clip={clip}
                        added={orderedIdSet.has(clip.id)}
                        selected={librarySelectedIds.has(clip.id)}
                        onAdd={addToSequence}
                        onDelete={(c) => {
                          setBatchDeleteLibraryPrompt(null);
                          setDeleteClipPrompt(c);
                        }}
                        onDragStart={onDragStart}
                        onDragEnd={onDragEnd}
                        onClickMulti={onLibraryCardMultiClick}
                      />
                    ))}
                  </ul>
                )}
              </div>
            </aside>

            {/* 中间：合集结构（编排主线） */}
            <section className="flex min-h-0 flex-1 flex-col gap-2 overflow-hidden border-white/10 bg-[#0a0a0f] px-3 py-3 xl:border-r">
              {unknownDurationHint ? (
                <p className="shrink-0 text-[10px] text-amber-200/80">{unknownDurationHint}</p>
              ) : null}
              <MontageOrchestrationTimeline
                clips={orderedClips}
                primarySelectedId={selectedTimelineClipId}
                multiSelectedIds={timelineMultiSelectedIds}
                onRowPointerDown={onOrchestrationRowClick}
                dragId={dragId}
                onDragStart={onDragStart}
                onDragEnd={onDragEnd}
                onDragOver={onDragOverItem}
                onDropOnRow={onTimelineCanvasDrop}
                onRemoveOne={removeFromSequence}
                transitionByClipId={transitionByClipId}
                formatTransitionLine={(map, id) => formatTransitionNodeLine(map, id)}
                transitionEdgeSourceId={transitionEdgeSourceId}
                onTransitionEdgeFocusChange={setTransitionEdgeSourceId}
                getEffectiveTransition={getEffectiveTransition}
                patchTransition={patchTransition}
                transitionTypeOptions={TRANSITION_TYPES}
                onApplyGlobalTransitionType={applyGlobalTransitionType}
                onApplyGlobalDurationToAll={applyGlobalDurationToAll}
                onApplyRandomTransitions={applyRandomTransitions}
                onApplyKillTypeTransitions={applyKillTypeTransitions}
                globalTransitionTemplates={GLOBAL_TRANSITION_TEMPLATES}
                onApplyGlobalTemplate={applyGlobalTransitionTemplate}
                onBulkRemove={removeTimelineMulti}
                multiCount={timelineMultiSelectedIds.size}
                onBulkMoveUp={() => shiftTimelineSelection(-1)}
                onBulkMoveDown={() => shiftTimelineSelection(1)}
                onClearTimeline={clearTimeline}
                timelineClipCount={orderedIds.length}
              />
            </section>

            {/* 右侧：合辑成片控制台 */}
            <div className="flex min-h-0 min-w-0 flex-col overflow-hidden border-white/10 xl:border-l xl:bg-black/15">
              <MontageStyleConsole
                bgmPath={bgmPath}
                onBgmPathChange={setBgmPath}
                onBgmClear={() => setBgmPath("")}
                bgmVolume={bgmVolume}
                onBgmVolumeChange={setBgmVolume}
                bgmStartSec={bgmStartSec}
                onBgmStartSecChange={setBgmStartSec}
                introPath={introPath}
                onIntroPathChange={setIntroPath}
                onIntroClear={() => setIntroPath("")}
                introDuration={introDuration}
                onIntroDurationChange={setIntroDuration}
                outroPath={outroPath}
                onOutroPathChange={setOutroPath}
                onOutroClear={() => setOutroPath("")}
                outroDuration={outroDuration}
                onOutroDurationChange={setOutroDuration}
                onMediaDropHint={showToast}
                onFilePick={pickFile}
                radarOverlayEnabled={radarOverlayEnabled}
                onRadarOverlayEnabledChange={setRadarOverlayEnabled}
                hasPovClips={hasPovClips}
                clipCount={orderedIds.length}
                durationText={durationText}
                resolutionLabel="跟随源素材 · MP4"
                exporting={exporting}
                onExport={() => void runExport()}
                onSaveDraft={() => void saveDraft()}
                savingDraft={savingDraft}
                exportReady={exportReady}
                fullOutputPathPreview={fullOutputPathPreview}
                outputFilename={outputFilename}
                onOutputFilenameChange={setOutputFilename}
                defaultFilenamePlaceholder={buildTimestampMontageFilename()}
                draftName={draftName}
                onDraftNameChange={setDraftName}
                draftNamePlaceholder={stripMp4Extension(outputFilename) || "与输出文件名同步"}
                outputDir={outputDir}
                onOutputDirChange={setOutputDir}
                onOutputDirClear={() => setOutputDir("")}
                effectiveOutputDirHint={!outputDir.trim() && effectiveOutputDir ? effectiveOutputDir : ""}
                exportingBanner={exporting}
                exportOk={exportOk}
                lastExport={lastExport}
                exportDirForButton={exportDirForButton}
                onCopyText={copyText}
                onDismissExportSuccess={() => setLastExport(null)}
              />
            </div>

          </div>
        </div>
      </div>
      {deleteClipPrompt ? (
        <div
          className="fixed inset-0 z-[120] flex items-center justify-center bg-black/60 px-4"
          role="dialog"
          aria-modal="true"
          aria-labelledby="montage-delete-clip-title"
          onClick={() => setDeleteClipPrompt(null)}
        >
          <div
            className="w-full max-w-md rounded-lg border border-white/15 bg-cs2-bg-card p-4 shadow-xl"
            onClick={(e) => e.stopPropagation()}
          >
            <h4 id="montage-delete-clip-title" className="mb-2 text-xs font-semibold text-zinc-200">
              从素材库删除
            </h4>
            <p className="mb-1 font-mono text-[11px] text-zinc-300">
              {clipBasename(deleteClipPrompt) || getClipTitle(deleteClipPrompt)}
            </p>
            <p className="mb-3 text-[10px] leading-relaxed text-cs2-text-secondary">
              将同时删除磁盘上的录像文件，且不可恢复。若该片段已加入合辑时间线，也会从时间线中移除。
            </p>
            {deleteClipPrompt.output_path ? (
              <p className="mb-3 break-all font-mono text-[10px] text-zinc-500" title={String(deleteClipPrompt.output_path)}>
                {String(deleteClipPrompt.output_path)}
              </p>
            ) : null}
            <div className="mt-2 flex flex-wrap justify-end gap-2">
              <button
                type="button"
                className="rounded border border-cs2-border px-3 py-1.5 text-[11px] text-zinc-400 hover:border-white/25 hover:text-zinc-200"
                onClick={() => setDeleteClipPrompt(null)}
              >
                取消
              </button>
              <button
                type="button"
                className="rounded border border-red-500/45 bg-red-950/40 px-3 py-1.5 text-[11px] font-semibold text-red-200 hover:bg-red-950/60"
                onClick={() => void confirmDeleteLibraryClip()}
              >
                确认删除
              </button>
            </div>
          </div>
        </div>
      ) : null}
      {batchDeleteLibraryPrompt?.length ? (
        <div
          className="fixed inset-0 z-[120] flex items-center justify-center bg-black/60 px-4"
          role="dialog"
          aria-modal="true"
          aria-labelledby="montage-batch-delete-title"
          onClick={() => setBatchDeleteLibraryPrompt(null)}
        >
          <div
            className="w-full max-w-md rounded-lg border border-white/15 bg-cs2-bg-card p-4 shadow-xl"
            onClick={(e) => e.stopPropagation()}
          >
            <h4 id="montage-batch-delete-title" className="mb-2 text-xs font-semibold text-zinc-200">
              批量从素材库删除
            </h4>
            <p className="mb-2 text-[10px] leading-relaxed text-cs2-text-secondary">
              将删除 <span className="font-semibold text-cs2-orange">{batchDeleteLibraryPrompt.length}</span>{" "}
              条素材，并同时删除磁盘上的录像文件，且不可恢复。已在合辑时间线中的片段也会一并移除。
            </p>
            <ul className="mb-3 max-h-40 overflow-y-auto rounded border border-white/[0.08] bg-black/30 px-2 py-1.5 font-mono text-[10px] text-zinc-400">
              {batchDeleteLibraryPrompt.map((c) => (
                <li key={c.id} className="truncate py-0.5" title={clipBasename(c) || getClipTitle(c)}>
                  {clipBasename(c) || getClipTitle(c)}
                </li>
              ))}
            </ul>
            <div className="mt-2 flex flex-wrap justify-end gap-2">
              <button
                type="button"
                className="rounded border border-cs2-border px-3 py-1.5 text-[11px] text-zinc-400 hover:border-white/25 hover:text-zinc-200"
                onClick={() => setBatchDeleteLibraryPrompt(null)}
              >
                取消
              </button>
              <button
                type="button"
                className="rounded border border-red-500/45 bg-red-950/40 px-3 py-1.5 text-[11px] font-semibold text-red-200 hover:bg-red-950/60"
                onClick={() => void confirmBatchDeleteLibraryClips()}
              >
                确认删除全部
              </button>
            </div>
          </div>
        </div>
      ) : null}
    </>
  );

  if (isPage) {
    return (
      <div className="flex h-full min-h-0 w-full flex-col overflow-hidden px-4 pb-4 pt-3 sm:px-5">
        {inner}
      </div>
    );
  }

  return (
    <div
      className="fixed inset-0 z-[110] flex justify-end bg-black/55 backdrop-blur-[1px]"
      role="dialog"
      aria-modal="true"
      aria-labelledby="montage-title"
      onClick={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      {inner}
    </div>
  );
}
