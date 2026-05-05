import { Fragment, useCallback, useEffect, useMemo, useRef, useState } from "react";
import axios from "axios";
import {
  X,
  Clapperboard,
  Loader2,
  ChevronUp,
  ChevronDown,
  Trash2,
  Copy,
  CheckCircle2,
  FolderOpen,
  GripVertical,
  Save,
} from "lucide-react";
import MontageThemeSelector from "./montage/MontageThemeSelector";
import { CLIP_CATEGORY_CONFIG } from "./ClipCard";
import { describeTag } from "../utils/tagDescriptions";
import {
  MONTAGE_THEMES,
  themeLabel,
  sortClipsByStrategy,
  ensureMp4Filename,
  stripMp4Extension,
  normalizeClipType,
  getClipTitle,
  getClipDurationSeconds,
  formatMontageEstimate,
  buildShareText,
} from "../utils/montageUtils";

const API = axios.create({ baseURL: "/api" });

const FILTER_TABS = [
  { id: "all", label: "全部" },
  { id: "highlight", label: "高光" },
  { id: "fail", label: "下饭" },
  { id: "compilation", label: "合集" },
  { id: "joined", label: "已加入" },
  { id: "unjoined", label: "未加入" },
];

const SORT_OPTIONS = [
  { id: "timeline", label: "按时间线" },
  { id: "score", label: "按评分" },
  { id: "funny_first", label: "下饭优先" },
  { id: "highlight_last", label: "高光压轴" },
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

const TRANSITION_DURATION_PRESETS = [0.15, 0.25, 0.4, 0.6, 1.0];

const DEFAULT_TRANSITION = { type: "cut", duration: 0.25 };

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
  return fn.includes(k) || idStr.includes(k);
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

function pickIdsByTemplate(items, templateId) {
  const matchers = {
    highlight: (c) => {
      if (c.category === "highlight") return true;
      const b = clipWeakBlob(c);
      if (/\bhighlight\b|高光/.test(b)) return true;
      if (normalizeClipType(c) === "高光") return true;
      const fn = clipBasename(c);
      const km = fn.match(/(\d+)k/i);
      if (km) {
        const n = parseInt(km[1], 10);
        if (n >= 3 && n < 48) return true;
      }
      return false;
    },
    fail: (c) => {
      if (c.category === "fail" || c.category === "meme_death") return true;
      const b = clipWeakBlob(c);
      if (normalizeClipType(c) === "下饭" || normalizeClipType(c) === "梗死亡") return true;
      if (/\bfail\b|下饭|meme_death|meme|funny|death\b|1d|电击/.test(b)) return true;
      if (/[_-]1d[_-]/i.test(clipBasename(c))) return true;
      return false;
    },
    all_kills: (c) => {
      if (c.category === "compilation" && c.compilation_kind === "all_kills") return true;
      const b = clipWeakBlob(c);
      if (b.includes("all_kills") || b.includes("全部击杀")) return true;
      const fn = clipBasename(c);
      const mk = fn.match(/(\d+)k/i);
      if (mk && parseInt(mk[1], 10) >= 10) return true;
      return false;
    },
    nemesis: (c) => {
      if (c.category === "compilation" && c.compilation_kind === "nemesis_deaths") return true;
      const b = clipWeakBlob(c);
      if (b.includes("nemesis_deaths") || b.includes("nemesis") || b.includes("本命") || b.includes("苦主")) return true;
      const fn = clipBasename(c);
      if (/_\d+d_/i.test(fn)) return true;
      return false;
    },
  };
  const fn = matchers[templateId];
  if (!fn) return [];
  return items.filter(fn).map((c) => c.id);
}

function typeBadgeClass(t) {
  if (t === "高光") return "bg-amber-500/20 text-amber-200 ring-amber-500/40";
  if (t === "下饭") return "bg-orange-500/20 text-orange-200 ring-orange-500/40";
  if (t === "梗死亡") return "bg-fuchsia-500/20 text-fuchsia-200 ring-fuchsia-500/40";
  if (t === "合集") return "bg-violet-500/20 text-violet-200 ring-violet-500/45";
  if (t === "击杀") return "bg-emerald-500/20 text-emerald-200 ring-emerald-500/40";
  return "bg-zinc-500/15 text-zinc-400 ring-white/10";
}

const KILL_COUNT_TAG_LABELS_MONTAGE = new Set(["双杀", "三杀", "四杀", "五杀 (ACE)"]);

function namesDifferMontage(a, b) {
  const s = (v) => String(v ?? "").trim();
  return s(a) !== "" && s(a) !== s(b);
}

function recordedClipCategoryKey(clip) {
  const c = clip?.category;
  if (c && CLIP_CATEGORY_CONFIG[c]) return c;
  return null;
}

function recordedClipBadgeLabel(clip) {
  const key = recordedClipCategoryKey(clip);
  if (key) return CLIP_CATEGORY_CONFIG[key].label;
  return normalizeClipType(clip);
}

function recordedClipBadgeClass(clip) {
  const key = recordedClipCategoryKey(clip);
  if (key) {
    const cfg = CLIP_CATEGORY_CONFIG[key];
    return `${cfg.bgColor} ${cfg.color} ring-1 ${cfg.borderColor}`;
  }
  return typeBadgeClass(normalizeClipType(clip));
}

function recordedClipContextTagClass(clip) {
  const key = recordedClipCategoryKey(clip);
  if (key) {
    const cfg = CLIP_CATEGORY_CONFIG[key];
    return `${cfg.bgColor} ${cfg.color}`;
  }
  const t = normalizeClipType(clip);
  if (t === "高光") return "bg-amber-500/20 text-amber-200";
  if (t === "下饭") return "bg-orange-500/20 text-orange-200";
  if (t === "梗死亡") return "bg-fuchsia-500/20 text-fuchsia-200";
  if (t === "合集") return "bg-violet-500/20 text-violet-200";
  if (t === "击杀") return "bg-emerald-500/20 text-emerald-200";
  return "bg-zinc-500/15 text-zinc-400";
}

function humanizeExportError(err) {
  const s = String(err || "").trim();
  if (!s) return "导出失败，请稍后重试。";
  if (s.includes("recorded_clip_ids") || s.includes("不能为空")) return "请先从左侧素材库加入至少一个片段。";
  return s;
}

function PathField({ label, hint, value, onChange, onClear, placeholder }) {
  return (
    <div className="space-y-1">
      <div className="flex items-baseline justify-between gap-2">
        <span className="text-[11px] font-medium text-zinc-300">{label}</span>
        {value ? (
          <button type="button" onClick={onClear} className="text-[10px] text-zinc-500 hover:text-zinc-300">
            清空
          </button>
        ) : null}
      </div>
      {hint ? <p className="text-[10px] leading-relaxed text-zinc-500">{hint}</p> : null}
      <input
        value={value}
        onChange={(e) => onChange(e.target.value)}
        placeholder={placeholder}
        className="w-full rounded border border-white/10 bg-black/50 px-2 py-2 font-mono text-[11px] text-zinc-200 placeholder:text-zinc-600"
      />
    </div>
  );
}

function formatSecondsDraft(sec) {
  if (!Number.isFinite(sec) || sec < 0) return "";
  const r = Math.round(sec * 1000) / 1000;
  if (Number.isInteger(r)) return String(r);
  return String(r).replace(/(\.\d*?)0+$/, "$1").replace(/\.$/, "");
}

function TransitionDurationSecondsInput({ clipId, transitionByClipId, patchTransition }) {
  const eff = getEffectiveTransition(transitionByClipId, clipId);
  const disabled = eff.type === "none";
  const [draft, setDraft] = useState("");

  useEffect(() => {
    if (disabled) {
      setDraft("");
      return;
    }
    setDraft(formatSecondsDraft(eff.duration));
  }, [clipId, disabled, eff.duration, eff.type]);

  const apply = useCallback(() => {
    if (disabled) return;
    const raw = String(draft).replace(",", ".").trim();
    if (raw === "") {
      setDraft(formatSecondsDraft(eff.duration));
      return;
    }
    const n = parseFloat(raw);
    if (!Number.isFinite(n) || n < 0) {
      setDraft(formatSecondsDraft(eff.duration));
      return;
    }
    patchTransition(clipId, { duration: n });
  }, [clipId, disabled, draft, eff.duration, patchTransition]);

  return (
    <div className="mt-2 space-y-1">
      <p className="text-[10px] font-medium text-zinc-400">自定义时长</p>
      <div className="flex flex-wrap items-center gap-2">
        <div className="flex min-w-0 items-center gap-1.5">
          <input
            type="text"
            inputMode="decimal"
            disabled={disabled}
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            onBlur={apply}
            onKeyDown={(e) => {
              if (e.key === "Enter") {
                e.preventDefault();
                apply();
              }
            }}
            className="w-28 rounded border border-white/10 bg-black/50 px-2 py-1 font-mono text-[10px] text-zinc-200 outline-none placeholder:text-zinc-600 focus:border-cs2-orange/45 disabled:cursor-not-allowed disabled:opacity-40"
            placeholder="秒"
            aria-label="转场时长（秒）"
          />
          <span className="shrink-0 text-[10px] text-zinc-500">s</span>
        </div>
        <p className="min-w-0 flex-1 text-[9px] leading-snug text-zinc-600">
          精确到小数；导出时会按相邻片段长度与编码上限自动截断。
        </p>
      </div>
    </div>
  );
}

export default function MontageWorkbenchDrawer({ open, onClose }) {
  const [loading, setLoading] = useState(false);
  const [items, setItems] = useState([]);
  const [orderedIds, setOrderedIds] = useState([]);
  const [bgmPath, setBgmPath] = useState("");
  const [introPath, setIntroPath] = useState("");
  const [outroPath, setOutroPath] = useState("");
  const [outputFilename, setOutputFilename] = useState(() => buildTimestampMontageFilename());
  const [outputDir, setOutputDir] = useState("");
  const [exporting, setExporting] = useState(false);
  const [lastExport, setLastExport] = useState(null);
  const [projectId, setProjectId] = useState(null);
  const [draftName, setDraftName] = useState("");
  const [selectedThemeId, setSelectedThemeId] = useState("custom");
  const [radarOverlayEnabled, setRadarOverlayEnabled] = useState(false);
  const [filterKey, setFilterKey] = useState("all");
  const [searchQ, setSearchQ] = useState("");
  const [toast, setToast] = useState(null);
  const [savingDraft, setSavingDraft] = useState(false);
  const [dragId, setDragId] = useState(null);
  const [transitionByClipId, setTransitionByClipId] = useState({});
  const [editingTransitionSourceId, setEditingTransitionSourceId] = useState(null);
  const [deleteClipPrompt, setDeleteClipPrompt] = useState(null);
  const toastTimer = useRef(null);

  const showToast = useCallback((msg) => {
    if (toastTimer.current) clearTimeout(toastTimer.current);
    setToast(msg);
    toastTimer.current = setTimeout(() => {
      setToast(null);
      toastTimer.current = null;
    }, 3200);
  }, []);

  const loadClips = useCallback(async () => {
    setLoading(true);
    try {
      const { data } = await API.get("/recorded-clips", { params: { limit: 500, offset: 0 } });
      setItems(data.items || []);
    } catch {
      setItems([]);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    if (!open) return;
    void loadClips();
  }, [open, loadClips]);

  useEffect(() => {
    if (!open) {
      setEditingTransitionSourceId(null);
      setDeleteClipPrompt(null);
    }
  }, [open]);

  const byId = useMemo(() => {
    const m = new Map();
    for (const it of items) m.set(it.id, it);
    return m;
  }, [items]);

  const orderedIdSet = useMemo(() => new Set(orderedIds), [orderedIds]);

  const orderedClips = useMemo(() => orderedIds.map((id) => byId.get(id)).filter(Boolean), [orderedIds, byId]);

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
    if (added > 0) showToast(`已加入 ${added} 个新片段（当前筛选共 ${filteredLibrary.length} 条）`);
    else showToast("当前筛选中的片段均已加入时间线");
  }, [filteredLibrary, showToast]);

  const removeFromSequence = useCallback((id) => {
    setOrderedIds((prev) => prev.filter((x) => x !== id));
    setTransitionByClipId((prev) => {
      const next = { ...prev };
      delete next[String(id)];
      return next;
    });
    setEditingTransitionSourceId((cur) => (cur === id ? null : cur));
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
      setEditingTransitionSourceId((cur) => (cur === clip.id ? null : cur));
      setItems((prev) => prev.filter((x) => x.id !== clip.id));
      setDeleteClipPrompt(null);
      showToast("已删除片段");
    } catch (e) {
      const detail = e.response?.data?.detail;
      showToast(typeof detail === "string" ? detail : e.message || "删除失败");
    }
  }, [deleteClipPrompt, showToast]);

  const move = useCallback((id, dir) => {
    setOrderedIds((prev) => {
      const i = prev.indexOf(id);
      if (i < 0) return prev;
      const j = i + dir;
      if (j < 0 || j >= prev.length) return prev;
      const next = [...prev];
      [next[i], next[j]] = [next[j], next[i]];
      return next;
    });
  }, []);

  const handleSort = useCallback(
    (strategy) => {
      const clips = orderedIds.map((id) => byId.get(id)).filter(Boolean);
      const sorted = sortClipsByStrategy(clips, strategy);
      setOrderedIds(sorted.map((c) => c.id));
    },
    [orderedIds, byId],
  );

  const applyTemplate = useCallback(
    (templateId, label) => {
      const ids = pickIdsByTemplate(items, templateId);
      if (!ids.length) {
        showToast(`没有匹配到「${label}」的片段，可尝试手动筛选或检查文件名。`);
        return;
      }
      setOrderedIds(ids);
      setTransitionByClipId((prev) => pruneTransitionsToOrderedIds(prev, ids));
      setEditingTransitionSourceId(null);
      showToast(`已应用「${label}」：${ids.length} 个片段已加入时间线`);
    },
    [items, showToast],
  );

  const applyGlobalTransitionTemplate = useCallback(
    (styleId, label) => {
      if (orderedIds.length < 2) {
        showToast("至少需要 2 个片段才能设置转场");
        return;
      }
      setTransitionByClipId((prev) => {
        const cleared = { ...prev };
        for (const id of orderedIds) delete cleared[String(id)];
        return { ...cleared, ...buildGlobalTransitionStyleMap(styleId, orderedIds) };
      });
      setEditingTransitionSourceId(null);
      showToast(`已应用「${label}」`);
    },
    [orderedIds, showToast],
  );

  const onSelectTheme = useCallback((id) => {
    setSelectedThemeId(id);
  }, []);

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
        intro_path: introPath.trim() || null,
        outro_path: outroPath.trim() || null,
        output_filename: ensureMp4Filename(outputFilename.trim()) || "montage_export.mp4",
        transitions: transitionsPayload,
        radar_overlay: {
          enabled: radarOverlayEnabled,
        },
      });
      setProjectId(data.id);
      if (data?.body?.transitions && typeof data.body.transitions === "object") {
        setTransitionByClipId(hydrateTransitionsFromApi(data.body.transitions));
      }
      setRadarOverlayEnabled(Boolean(data?.body?.radar_overlay?.enabled));
      showToast("草稿已保存");
    } catch (e) {
      showToast(e.response?.data?.detail || e.message || "保存失败");
    } finally {
      setSavingDraft(false);
    }
  }, [projectId, draftName, outputFilename, orderedIds, bgmPath, introPath, outroPath, showToast, transitionsPayload, radarOverlayEnabled]);

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
        intro_path: introPath.trim() || null,
        outro_path: outroPath.trim() || null,
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
      setLastExport({ ok: false, err: humanizeExportError(detail || e.message) });
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
    introPath,
    outroPath,
    effectiveOutputDir,
    outputFilename,
    selectedThemeId,
    radarOverlayEnabled,
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
    setEditingTransitionSourceId(null);
  }, []);

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

  const onDropOnItem = useCallback((e, targetId) => {
    e.preventDefault();
    const raw = e.dataTransfer.getData("text/plain");
    const draggedId = Number(raw);
    if (!Number.isFinite(draggedId) || draggedId === targetId) return;
    setOrderedIds((prev) => {
      const next = prev.filter((x) => x !== draggedId);
      const ti = next.indexOf(targetId);
      if (ti < 0) return [...next, draggedId];
      next.splice(ti, 0, draggedId);
      return next;
    });
    setDragId(null);
  }, []);

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
  const knownDurTimeline = orderedClips.reduce((acc, c) => {
    const d = getClipDurationSeconds(c);
    return d != null ? acc + d : acc;
  }, 0);

  if (!open) return null;

  const exportOk = lastExport?.ok && lastExport.output_path;
  const exportDirForButton = exportOk ? dirnamePath(lastExport.output_path) : "";

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
      <div className="flex h-full w-[min(1320px,98vw)] flex-col border-l border-white/10 bg-cs2-bg-card shadow-2xl">
        <div className="flex shrink-0 flex-wrap items-center justify-between gap-3 border-b border-white/10 px-4 py-3">
          <div className="flex min-w-0 flex-1 flex-wrap items-center gap-3">
            <div className="flex items-center gap-2">
              <Clapperboard className="h-4 w-4 shrink-0 text-cs2-orange" />
              <h2 id="montage-title" className="text-sm font-bold text-white">
                合辑工作台
              </h2>
            </div>
            <span className="hidden h-4 w-px bg-white/15 sm:block" aria-hidden />
            <p className="text-[11px] text-zinc-400">
              主题：<span className="font-medium text-cs2-orange">{themeLabel(selectedThemeId)}</span>
            </p>
          </div>
          <button
            type="button"
            onClick={onClose}
            className="rounded-md p-1.5 text-zinc-500 hover:bg-white/[0.06] hover:text-zinc-300"
            aria-label="关闭"
          >
            <X className="h-4 w-4" />
          </button>
        </div>

        {toast ? (
          <div className="border-b border-emerald-500/30 bg-emerald-950/40 px-4 py-2 text-center text-[11px] text-emerald-200">
            {toast}
          </div>
        ) : null}

        <div className="flex min-h-0 flex-1 flex-col overflow-hidden">
          <div className="grid min-h-0 flex-1 grid-cols-1 gap-0 border-b border-white/10 lg:grid-cols-12">
            {/* 左侧素材库 */}
            <aside className="flex min-h-0 flex-col border-white/10 lg:col-span-3 lg:border-r">
              <div className="shrink-0 border-b border-white/10 px-3 py-2.5">
                <p className="text-[10px] font-semibold uppercase tracking-wide text-zinc-500">素材库</p>
                <p className="mt-0.5 text-[10px] text-zinc-600">已录片段 · 筛选后加入时间线</p>
              </div>
              <div className="shrink-0 space-y-2 px-3 py-2">
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
                  placeholder="按文件名或 clip_id 搜索…"
                  className="w-full rounded border border-white/10 bg-black/40 px-2.5 py-1.5 text-[11px] text-zinc-200 placeholder:text-zinc-600"
                />
                <button
                  type="button"
                  onClick={addFilteredToSequence}
                  disabled={filteredLibrary.length === 0}
                  className="w-full rounded-lg border border-cs2-orange/40 bg-cs2-orange/10 py-1.5 text-[11px] font-semibold text-cs2-orange hover:bg-cs2-orange/20 disabled:cursor-not-allowed disabled:opacity-35"
                >
                  加入当前筛选结果
                </button>
              </div>
              <div className="min-h-0 flex-1 overflow-y-auto px-3 pb-3">
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
                  <ul className="space-y-2">
                    {filteredLibrary.map((clip) => {
                      const added = orderedIdSet.has(clip.id);
                      const badgeLabel = recordedClipBadgeLabel(clip);
                      const badgeCls = recordedClipBadgeClass(clip);
                      const fn = clipBasename(clip) || getClipTitle(clip);
                      const dur = getClipDurationSeconds(clip);
                      const durLabel = dur != null ? `${dur.toFixed(1)}s` : "未知";
                      const cid = clip.clip_id != null ? String(clip.clip_id) : "—";
                      const hasScore = clip.score_own != null && clip.score_opp != null;
                      const victimsList = Array.isArray(clip.victims) ? clip.victims.filter(Boolean) : [];
                      const killCountInTags =
                        Array.isArray(clip.context_tags) && clip.context_tags.some((t) => KILL_COUNT_TAG_LABELS_MONTAGE.has(t));
                      const showVictimsBadge =
                        clip.category === "highlight" && clip.kill_count !== 5 && victimsList.length > 0;
                      const showKillerBadge =
                        clip.category === "fail" && namesDifferMontage(clip.killer_name, clip.player_name);
                      const aiScore =
                        clip.ai_score != null && clip.ai_score !== "" && Number.isFinite(Number(clip.ai_score))
                          ? Math.round(Number(clip.ai_score))
                          : null;
                      return (
                        <li
                          key={clip.id}
                          className="rounded-lg border border-white/10 bg-black/40 p-2.5 shadow-inner ring-1 ring-white/[0.03]"
                        >
                          <div className="flex items-start justify-between gap-2">
                            <div className="min-w-0 flex-1">
                              <div className="flex flex-wrap items-center gap-1.5">
                                <span
                                  className={`inline-flex rounded px-1.5 py-0.5 text-[9px] font-semibold ${badgeCls}`}
                                >
                                  {badgeLabel}
                                </span>
                                <span className="font-mono text-[9px] text-zinc-500">#{clip.id}</span>
                                {aiScore != null ? (
                                  <span className="rounded border border-amber-500/30 bg-amber-950/25 px-1.5 py-0.5 font-mono text-[9px] font-bold text-amber-200/90">
                                    AI {aiScore}
                                  </span>
                                ) : null}
                              </div>
                              <p className="mt-1 truncate text-[11px] font-medium text-zinc-200" title={fn}>
                                {fn}
                              </p>
                              <p className="mt-0.5 font-mono text-[10px] text-zinc-500">clip_id: {cid}</p>
                              {clip.category !== "compilation" && (clip.round != null || hasScore || clip.round_won != null) ? (
                                <div className="mt-1.5 flex flex-wrap items-center gap-1.5">
                                  {clip.round != null ? (
                                    <span className="font-mono text-[10px] font-bold text-cs2-orange">第 {clip.round} 回合</span>
                                  ) : null}
                                  {clip.round_won != null ? (
                                    <span
                                      className={`rounded px-1 py-0.5 text-[9px] font-bold ${
                                        clip.round_won
                                          ? "bg-emerald-500/20 text-emerald-400"
                                          : "bg-rose-500/20 text-rose-400"
                                      }`}
                                    >
                                      {clip.round_won ? "胜" : "败"}
                                    </span>
                                  ) : null}
                                  {hasScore ? (
                                    <span className="inline-flex items-center gap-0.5 rounded border border-white/10 bg-black/35 px-1.5 py-0.5 font-mono text-[9px] font-semibold tabular-nums">
                                      <span className="text-emerald-400">{clip.score_own}</span>
                                      <span className="text-zinc-500">:</span>
                                      <span className="text-rose-400">{clip.score_opp}</span>
                                    </span>
                                  ) : null}
                                  {clip.kill_count > 0 && !killCountInTags ? (
                                    <span className="rounded bg-black/40 px-1.5 py-0.5 text-[9px] font-bold text-zinc-200">
                                      {clip.kill_count} 杀
                                    </span>
                                  ) : null}
                                </div>
                              ) : null}
                            </div>
                            <div className="flex shrink-0 items-start gap-1">
                              <button
                                type="button"
                                disabled={added}
                                onClick={() => addToSequence(clip.id)}
                                className={`rounded-md border px-2 py-1 text-[10px] font-semibold ${
                                  added
                                    ? "cursor-default border-emerald-500/35 bg-emerald-950/30 text-emerald-300"
                                    : "border-cs2-orange/45 bg-cs2-orange/10 text-cs2-orange hover:bg-cs2-orange/20"
                                }`}
                              >
                                {added ? "已加入 ✓" : "加入"}
                              </button>
                              <button
                                type="button"
                                onClick={() => setDeleteClipPrompt(clip)}
                                className="rounded-md border border-white/10 p-1.5 text-zinc-500 hover:border-red-500/40 hover:bg-red-950/35 hover:text-red-300"
                                title="从素材库删除（含本地录像文件）"
                                aria-label="从素材库删除"
                              >
                                <Trash2 className="h-3.5 w-3.5" />
                              </button>
                            </div>
                          </div>
                          {Array.isArray(clip.context_tags) && clip.context_tags.length > 0 ? (
                            <div className="mt-1.5 w-full min-w-0 flex flex-wrap content-start gap-1.5">
                              {clip.context_tags.map((tag) => {
                                const desc = describeTag(tag);
                                return (
                                  <span
                                    key={tag}
                                    title={desc || undefined}
                                    className={`rounded px-1.5 py-0.5 text-[9px] font-bold ${recordedClipContextTagClass(clip)} ${desc ? "cursor-help" : ""}`}
                                  >
                                    {tag}
                                  </span>
                                );
                              })}
                            </div>
                          ) : null}
                          {clip.weapon_used ? (
                            <div className="mt-1 w-full min-w-0 flex flex-wrap gap-1.5">
                              {String(clip.weapon_used)
                                .split(" / ")
                                .map((w) => w.trim())
                                .filter(Boolean)
                                .map((w) => (
                                  <span
                                    key={w}
                                    className="rounded bg-black/40 px-1.5 py-0.5 font-mono text-[9px] text-zinc-400"
                                  >
                                    {w}
                                  </span>
                                ))}
                            </div>
                          ) : null}
                          {showKillerBadge ? (
                            <p className="mt-1 text-[9px] font-bold text-rose-300/90">💀 击杀者: {clip.killer_name}</p>
                          ) : null}
                          {showVictimsBadge ? (
                            <p className="mt-0.5 text-[9px] font-bold text-emerald-400/90">🎯 击杀: {victimsList.join(", ")}</p>
                          ) : null}
                          <p className="mt-1.5 text-[10px] text-zinc-500">
                            时长 <span className="font-mono text-zinc-400">{durLabel}</span>
                          </p>
                          {clip.demo_filename ? (
                            <p className="mt-0.5 truncate font-mono text-[9px] text-zinc-600" title={clip.demo_filename}>
                              Demo · {clip.demo_filename}
                            </p>
                          ) : null}
                          {clip.player_name ? (
                            <p className="text-[9px] text-zinc-600">视角 {clip.player_name}</p>
                          ) : null}
                        </li>
                      );
                    })}
                  </ul>
                )}
              </div>
            </aside>

            {/* 中间时间线 */}
            <section className="flex min-h-0 flex-col border-white/10 lg:col-span-5 lg:border-r">
              <div className="shrink-0 border-b border-white/10 px-3 py-2.5">
                <p className="text-[10px] font-semibold uppercase tracking-wide text-zinc-500">合辑时间线</p>
                <p className="mt-0.5 text-[10px] text-zinc-600">拖拽排序 · 右侧为导出设置</p>
              </div>
              <div className="shrink-0 space-y-2 border-b border-white/10 px-3 py-2">
                <p className="text-[10px] font-medium text-zinc-400">快捷生成模板</p>
                <div className="flex flex-wrap gap-1.5">
                  <button
                    type="button"
                    onClick={() => applyTemplate("highlight", "一键高光合集")}
                    className="rounded-md border border-white/10 bg-black/35 px-2 py-1 text-[10px] text-zinc-200 hover:border-cs2-orange/40"
                  >
                    一键高光合集
                  </button>
                  <button
                    type="button"
                    onClick={() => applyTemplate("fail", "一键下饭合集")}
                    className="rounded-md border border-white/10 bg-black/35 px-2 py-1 text-[10px] text-zinc-200 hover:border-cs2-orange/40"
                  >
                    一键下饭合集
                  </button>
                  <button
                    type="button"
                    onClick={() => applyTemplate("all_kills", "一键全部击杀合集")}
                    className="rounded-md border border-white/10 bg-black/35 px-2 py-1 text-[10px] text-zinc-200 hover:border-cs2-orange/40"
                  >
                    一键全部击杀合集
                  </button>
                  <button
                    type="button"
                    onClick={() => applyTemplate("nemesis", "一键本命苦主合集")}
                    className="rounded-md border border-white/10 bg-black/35 px-2 py-1 text-[10px] text-zinc-200 hover:border-cs2-orange/40"
                  >
                    一键本命苦主合集
                  </button>
                </div>
              </div>
              <div className="shrink-0 px-3 py-2">
                <p className="text-[11px] font-semibold text-zinc-200">
                  已加入 {orderedClips.length} 个片段 · 预计 {formatMontageEstimate(knownDurTimeline, orderedClips.length)}
                </p>
                {unknownDurationHint ? (
                  <p className="mt-1 text-[10px] text-amber-200/80">{unknownDurationHint}</p>
                ) : null}
                <div className="mt-2 flex flex-wrap gap-1.5">
                  {SORT_OPTIONS.map((s) => (
                    <button
                      key={s.id}
                      type="button"
                      onClick={() => handleSort(s.id)}
                      className="rounded border border-white/10 bg-black/40 px-2 py-0.5 text-[10px] text-zinc-400 hover:border-cs2-orange/35 hover:text-zinc-200"
                    >
                      {s.label}
                    </button>
                  ))}
                </div>
              </div>
              <div className="min-h-0 flex-1 overflow-y-auto px-3 pb-3">
                {orderedClips.length === 0 ? (
                  <div className="rounded-lg border border-dashed border-white/15 bg-black/30 px-3 py-10 text-center text-[11px] leading-relaxed text-zinc-500">
                    <p className="font-medium text-zinc-400">时间线为空</p>
                    <p className="mt-2">从左侧素材库加入片段，或使用一键生成模板。</p>
                  </div>
                ) : (
                  <ul className="space-y-2">
                    {orderedClips.map((clip, idx) => {
                      const fn = clipBasename(clip) || getClipTitle(clip);
                      const dur = getClipDurationSeconds(clip);
                      const durLabel = dur != null ? `${dur.toFixed(1)}s` : "未知";
                      const dragging = dragId === clip.id;
                      const nextClip = orderedClips[idx + 1];
                      const tLine = formatTransitionNodeLine(transitionByClipId, clip.id);
                      const seqBadge = recordedClipBadgeLabel(clip);
                      const seqBadgeCls = recordedClipBadgeClass(clip);
                      const seqHasScore = clip.score_own != null && clip.score_opp != null;
                      const seqAi =
                        clip.ai_score != null && clip.ai_score !== "" && Number.isFinite(Number(clip.ai_score))
                          ? Math.round(Number(clip.ai_score))
                          : null;
                      const tagOverflow =
                        Array.isArray(clip.context_tags) && clip.context_tags.length > 10
                          ? clip.context_tags.length - 10
                          : 0;
                      return (
                        <Fragment key={clip.id}>
                          <li
                            draggable
                            onDragStart={(e) => onDragStart(e, clip.id)}
                            onDragEnd={onDragEnd}
                            onDragOver={onDragOverItem}
                            onDrop={(e) => onDropOnItem(e, clip.id)}
                            className={`rounded-lg border border-white/[0.08] bg-black/40 px-2 py-2 text-[11px] ${
                              dragging ? "border-cs2-orange/50 ring-1 ring-cs2-orange/25" : ""
                            }`}
                          >
                            <div className="flex items-start gap-2">
                              <div
                                className="mt-0.5 cursor-grab text-zinc-600 active:cursor-grabbing"
                                title="拖拽排序"
                              >
                                <GripVertical className="h-4 w-4" />
                              </div>
                              <span className="w-7 shrink-0 pt-0.5 font-mono text-[10px] text-zinc-500">
                                {String(idx + 1).padStart(2, "0")}
                              </span>
                              <div className="min-w-0 flex-1">
                                <div className="flex min-w-0 items-start gap-2">
                                  <span
                                    className={`mt-0.5 inline-flex shrink-0 rounded px-1.5 py-0.5 text-[9px] font-semibold ${seqBadgeCls}`}
                                  >
                                    {seqBadge}
                                  </span>
                                  <p className="min-w-0 flex-1 truncate font-medium leading-snug text-zinc-200" title={fn}>
                                    {fn}
                                  </p>
                                </div>
                                <div className="mt-0.5 flex flex-wrap items-center gap-x-2 gap-y-0.5 text-[10px] text-zinc-500">
                                  <span>
                                    时长 <span className="font-mono tabular-nums text-zinc-400">{durLabel}</span>
                                  </span>
                                  {clip.category !== "compilation" && clip.round != null ? (
                                    <span className="font-mono font-semibold text-cs2-orange/90">第 {clip.round} 回合</span>
                                  ) : null}
                                  {seqHasScore ? (
                                    <span className="inline-flex items-center gap-0.5 font-mono tabular-nums">
                                      <span className="text-emerald-400/90">{clip.score_own}</span>
                                      <span className="text-zinc-600">:</span>
                                      <span className="text-rose-400/90">{clip.score_opp}</span>
                                    </span>
                                  ) : null}
                                  {seqAi != null ? (
                                    <span className="font-mono text-[10px] text-amber-200/85">AI {seqAi}</span>
                                  ) : null}
                                </div>
                                {Array.isArray(clip.context_tags) && clip.context_tags.length > 0 ? (
                                  <div className="mt-1 flex min-w-0 flex-wrap gap-1">
                                    {clip.context_tags.slice(0, 10).map((tag) => {
                                      const td = describeTag(tag);
                                      return (
                                        <span
                                          key={tag}
                                          title={td || undefined}
                                          className={`rounded px-1.5 py-0.5 text-[9px] font-bold ${recordedClipContextTagClass(clip)} ${td ? "cursor-help" : ""}`}
                                        >
                                          {tag}
                                        </span>
                                      );
                                    })}
                                    {tagOverflow > 0 ? (
                                      <span className="self-center text-[9px] text-zinc-600">+{tagOverflow}</span>
                                    ) : null}
                                  </div>
                                ) : null}
                              </div>
                              <div className="flex shrink-0 flex-col gap-0.5">
                                <button
                                  type="button"
                                  className="rounded p-1 text-zinc-500 hover:bg-white/[0.06] hover:text-white"
                                  onClick={() => move(clip.id, -1)}
                                  aria-label="上移"
                                >
                                  <ChevronUp className="h-4 w-4" />
                                </button>
                                <button
                                  type="button"
                                  className="rounded p-1 text-zinc-500 hover:bg-white/[0.06] hover:text-white"
                                  onClick={() => move(clip.id, 1)}
                                  aria-label="下移"
                                >
                                  <ChevronDown className="h-4 w-4" />
                                </button>
                                <button
                                  type="button"
                                  className="rounded p-1 text-zinc-500 hover:bg-red-400/80 hover:text-white"
                                  onClick={() => removeFromSequence(clip.id)}
                                  aria-label="移除"
                                >
                                  <Trash2 className="h-4 w-4" />
                                </button>
                              </div>
                            </div>
                          </li>
                          {nextClip ? (
                            <li key={`t-${clip.id}`} className="list-none py-0.5 pl-2">
                              <div className="flex flex-col items-stretch gap-1 pl-7">
                                <div className="flex items-center gap-2">
                                  <div className="h-4 w-px shrink-0 bg-gradient-to-b from-white/25 to-white/10" />
                                  <button
                                    type="button"
                                    onClick={() =>
                                      setEditingTransitionSourceId((cur) => (cur === clip.id ? null : clip.id))
                                    }
                                    className={`min-w-0 flex-1 rounded-md border px-2 py-1.5 text-left transition-colors ${
                                      editingTransitionSourceId === clip.id
                                        ? "border-cs2-orange/55 bg-cs2-orange/15"
                                        : "border-white/10 bg-black/35 hover:border-cs2-orange/35"
                                    }`}
                                  >
                                    <p className="text-[9px] font-medium uppercase tracking-wide text-zinc-500">
                                      转场 → {clipBasename(nextClip) || `#${nextClip.id}`}
                                    </p>
                                    <p className="truncate text-[10px] font-semibold text-cs2-orange">{tLine}</p>
                                  </button>
                                </div>
                                {editingTransitionSourceId === clip.id ? (
                                  <div className="ml-2 rounded-lg border border-cs2-orange/35 bg-zinc-950/90 p-2 shadow-lg ring-1 ring-black/30">
                                    <p className="text-[10px] font-medium text-zinc-400">转场类型</p>
                                    <div className="mt-1 flex flex-wrap gap-1">
                                      {TRANSITION_TYPES.map((opt) => {
                                        const active = getEffectiveTransition(transitionByClipId, clip.id).type === opt.id;
                                        return (
                                          <button
                                            key={opt.id}
                                            type="button"
                                            onClick={() => {
                                              if (opt.id === "none") {
                                                patchTransition(clip.id, { type: "none", duration: 0 });
                                              } else {
                                                patchTransition(clip.id, { type: opt.id });
                                              }
                                            }}
                                            className={`rounded border px-1.5 py-0.5 text-[9px] font-medium ${
                                              active
                                                ? "border-cs2-orange/60 bg-cs2-orange/20 text-cs2-orange"
                                                : "border-white/10 bg-black/40 text-zinc-400 hover:border-white/25"
                                            }`}
                                          >
                                            {opt.label}
                                          </button>
                                        );
                                      })}
                                    </div>
                                    <p className="mt-2 text-[10px] font-medium text-zinc-400">时长</p>
                                    <div className="mt-1 flex flex-wrap gap-1">
                                      {TRANSITION_DURATION_PRESETS.map((sec) => {
                                        const eff = getEffectiveTransition(transitionByClipId, clip.id);
                                        const disabled = eff.type === "none";
                                        const active = !disabled && Math.abs(eff.duration - sec) < 0.02;
                                        return (
                                          <button
                                            key={sec}
                                            type="button"
                                            disabled={disabled}
                                            onClick={() => patchTransition(clip.id, { duration: sec })}
                                            className={`rounded border px-1.5 py-0.5 font-mono text-[9px] ${
                                              disabled
                                                ? "cursor-not-allowed border-white/5 text-zinc-600"
                                                : active
                                                  ? "border-cs2-orange/60 bg-cs2-orange/20 text-cs2-orange"
                                                  : "border-white/10 bg-black/40 text-zinc-400 hover:border-white/25"
                                            }`}
                                          >
                                            {sec}s
                                          </button>
                                        );
                                      })}
                                    </div>
                                    <TransitionDurationSecondsInput
                                      clipId={clip.id}
                                      transitionByClipId={transitionByClipId}
                                      patchTransition={patchTransition}
                                    />
                                    <button
                                      type="button"
                                      onClick={() => setEditingTransitionSourceId(null)}
                                      className="mt-2 w-full rounded border border-white/12 bg-white/[0.06] py-1 text-[10px] font-semibold text-zinc-300 hover:border-cs2-orange/35"
                                    >
                                      完成
                                    </button>
                                  </div>
                                ) : null}
                              </div>
                            </li>
                          ) : null}
                        </Fragment>
                      );
                    })}
                  </ul>
                )}
              </div>
            </section>

            {/* 右侧导出设置 */}
            <aside className="flex min-h-0 flex-col overflow-y-auto lg:col-span-4">
              <div className="border-b border-white/10 px-3 py-2.5">
                <p className="text-[10px] font-semibold uppercase tracking-wide text-zinc-500">导出设置</p>
              </div>
              <div className="space-y-4 px-3 py-3">
                <MontageThemeSelector themes={MONTAGE_THEMES} selectedThemeId={selectedThemeId} onSelectTheme={onSelectTheme} />

                <div className="rounded-xl border border-white/10 bg-black/30 p-3">
                  <div className="flex items-start justify-between gap-3">
                    <div>
                      <div className="text-sm font-semibold text-zinc-100">后期雷达覆盖</div>
                      <div className="mt-1 text-xs leading-relaxed text-zinc-500">
                        导出时基于 Demo 坐标生成右上角 POV 小地图，仅显示自己和队友，不显示敌人。
                      </div>
                    </div>

                    <button
                      type="button"
                      onClick={() => setRadarOverlayEnabled((prev) => !prev)}
                      className={
                        radarOverlayEnabled
                          ? "rounded-lg bg-cs2-orange px-3 py-1.5 text-xs font-semibold text-black"
                          : "rounded-lg border border-white/10 bg-zinc-900 px-3 py-1.5 text-xs text-zinc-300"
                      }
                    >
                      {radarOverlayEnabled ? "已开启" : "关闭"}
                    </button>
                  </div>
                </div>

                <div className="rounded-lg border border-white/10 bg-black/25 p-3">
                  <p className="text-[11px] font-semibold text-zinc-200">转场风格</p>
                  <p className="mt-0.5 text-[10px] leading-relaxed text-zinc-500">
                    一键应用到当前时间线上所有相邻片段之间（转场挂在「前一个片段」上，排序时跟随片段 id）。
                  </p>
                  <div className="mt-2 flex flex-wrap gap-1.5">
                    {GLOBAL_TRANSITION_TEMPLATES.map((tpl) => (
                      <button
                        key={tpl.id}
                        type="button"
                        onClick={() => applyGlobalTransitionTemplate(tpl.id, tpl.label)}
                        disabled={orderedIds.length < 2}
                        className="rounded-md border border-white/10 bg-black/40 px-2 py-1 text-[10px] font-medium text-zinc-200 hover:border-cs2-orange/45 hover:text-white disabled:cursor-not-allowed disabled:opacity-35"
                      >
                        {tpl.label}
                      </button>
                    ))}
                  </div>
                </div>

                {exporting ? (
                  <div className="rounded-lg border border-amber-500/35 bg-amber-950/30 px-3 py-2 text-[11px] text-amber-100">
                    正在导出合辑，请不要关闭程序…
                  </div>
                ) : null}

                <div className="space-y-1">
                  <span className="text-[11px] font-medium text-zinc-300">草稿名称</span>
                  <p className="text-[10px] text-zinc-500">保存草稿时使用；留空则与输出文件名同步。</p>
                  <input
                    value={draftName}
                    onChange={(e) => setDraftName(e.target.value)}
                    placeholder={stripMp4Extension(outputFilename) || "与输出文件名同步"}
                    className="w-full rounded border border-white/10 bg-black/50 px-2 py-2 text-[11px] text-zinc-200"
                  />
                </div>

                <PathField
                  label="背景音乐（可选）"
                  hint="本地音频文件路径；留空则无 BGM。"
                  value={bgmPath}
                  onChange={setBgmPath}
                  onClear={() => setBgmPath("")}
                  placeholder="例如 D:\Music\bgm.mp3"
                />
                <PathField
                  label="片头视频（可选）"
                  hint="建议 3–5 秒，需为本地可访问的视频文件。"
                  value={introPath}
                  onChange={setIntroPath}
                  onClear={() => setIntroPath("")}
                  placeholder="例如 D:\Videos\intro.mp4"
                />
                <PathField
                  label="片尾视频（可选）"
                  hint="片尾 Logo 或口播提示等。"
                  value={outroPath}
                  onChange={setOutroPath}
                  onClear={() => setOutroPath("")}
                  placeholder="例如 D:\Videos\outro.mp4"
                />

                <div className="space-y-1">
                  <span className="text-[11px] font-medium text-zinc-300">输出文件名</span>
                  <p className="text-[10px] text-zinc-500">默认带时间戳；可改为任意名称（自动补 .mp4）。</p>
                  <input
                    value={outputFilename}
                    onChange={(e) => setOutputFilename(e.target.value)}
                    className="w-full rounded border border-white/10 bg-black/50 px-2 py-2 font-mono text-[11px] text-zinc-200"
                    placeholder={buildTimestampMontageFilename()}
                  />
                </div>

                <div className="space-y-1">
                  <span className="text-[11px] font-medium text-zinc-300">输出目录</span>
                  <p className="text-[10px] text-zinc-500">
                    可留空：将使用已录片段所在目录下的「{DEFAULT_REL_EXPORT_DIR}」。也可填写本机任意文件夹路径。
                  </p>
                  <div className="flex gap-2">
                    <input
                      value={outputDir}
                      onChange={(e) => setOutputDir(e.target.value)}
                      placeholder="留空则用片段目录下的 exports/montage"
                      className="min-w-0 flex-1 rounded border border-white/10 bg-black/50 px-2 py-2 font-mono text-[11px] text-zinc-200"
                    />
                    {outputDir ? (
                      <button
                        type="button"
                        onClick={() => setOutputDir("")}
                        className="shrink-0 rounded border border-white/10 px-2 py-2 text-[10px] text-zinc-500 hover:text-zinc-300"
                      >
                        <X className="h-4 w-4" />
                      </button>
                    ) : null}
                  </div>
                  {!outputDir.trim() && effectiveOutputDir ? (
                    <p className="text-[10px] text-zinc-600">
                      当前将导出至：<span className="break-all font-mono text-zinc-500">{effectiveOutputDir}</span>
                    </p>
                  ) : null}
                </div>

                {exportOk ? (
                  <div className="rounded-lg border border-emerald-500/35 bg-emerald-950/25 p-3 text-[11px] text-emerald-100">
                    <div className="flex items-center gap-2 font-semibold text-emerald-200">
                      <CheckCircle2 className="h-4 w-4 shrink-0" />
                      导出完成
                    </div>
                    <p className="mt-2 text-[10px] text-zinc-400">输出路径</p>
                    <p className="mt-1 break-all font-mono text-[10px] text-zinc-200">{lastExport.output_path}</p>
                    <div className="mt-3 flex flex-wrap gap-2">
                      <button
                        type="button"
                        onClick={() => void copyText(lastExport.output_path)}
                        className="inline-flex items-center gap-1.5 rounded-md border border-emerald-500/40 bg-emerald-900/30 px-2.5 py-1.5 text-[10px] font-medium hover:bg-emerald-900/50"
                      >
                        <Copy className="h-3.5 w-3.5" />
                        复制路径
                      </button>
                      <button
                        type="button"
                        onClick={() => void copyText(buildShareText({ themeId: selectedThemeId, clipCount: orderedIds.length, durationText, outputPath: lastExport.output_path }))}
                        className="inline-flex items-center gap-1.5 rounded-md border border-white/15 bg-black/30 px-2.5 py-1.5 text-[10px] font-medium text-zinc-200 hover:border-cs2-orange/40"
                      >
                        <Copy className="h-3.5 w-3.5" />
                        复制群聊文案
                      </button>
                      {exportDirForButton ? (
                        <button
                          type="button"
                          onClick={() => void copyText(exportDirForButton)}
                          className="inline-flex items-center gap-1.5 rounded-md border border-white/15 bg-black/30 px-2.5 py-1.5 text-[10px] font-medium text-zinc-200 hover:border-cs2-orange/40"
                          title="复制上级文件夹路径，在资源管理器地址栏粘贴打开"
                        >
                          <FolderOpen className="h-3.5 w-3.5" />
                          复制文件夹路径
                        </button>
                      ) : null}
                    </div>
                    <p className="mt-2 text-[10px] text-zinc-600">
                      在资源管理器中 Win+E，地址栏粘贴「复制文件夹路径」即可定位到输出目录。
                    </p>
                  </div>
                ) : null}

                {lastExport && !lastExport.ok ? (
                  <div className="rounded-lg border border-red-500/40 bg-red-950/30 px-3 py-2 text-[11px] text-red-100">
                    导出失败：{String(lastExport.err)}
                  </div>
                ) : null}
              </div>
            </aside>
          </div>

          {/* 底部主操作栏 */}
          <footer className="shrink-0 border-t border-white/10 bg-black/40 px-4 py-3 backdrop-blur-sm">
            <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
              <div className="flex flex-wrap items-center gap-x-4 gap-y-1 text-[11px] text-zinc-400">
                <span>
                  已选 <span className="font-semibold text-cs2-orange">{orderedIds.length}</span> 个片段
                </span>
                <span className="hidden h-3 w-px bg-white/15 sm:inline" aria-hidden />
                <span>
                  预计总时长{" "}
                  <span className="font-mono text-zinc-200">
                    {formatMontageEstimate(totalKnownSeconds, orderedIds.length)}
                  </span>
                </span>
              </div>
              <div className="flex flex-wrap items-center gap-2">
                <button
                  type="button"
                  onClick={clearTimeline}
                  disabled={!orderedIds.length}
                  className="rounded-lg border border-white/12 bg-white/[0.04] px-3 py-2 text-[11px] font-semibold text-zinc-300 hover:border-white/25 disabled:opacity-35"
                >
                  清空
                </button>
                <button
                  type="button"
                  disabled={savingDraft}
                  onClick={() => void saveDraft()}
                  className="inline-flex items-center justify-center gap-2 rounded-lg border border-white/15 bg-white/[0.06] px-3 py-2 text-[11px] font-semibold text-zinc-200 hover:border-cs2-orange/40 disabled:opacity-50"
                >
                  {savingDraft ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Save className="h-3.5 w-3.5" />}
                  保存草稿
                </button>
                <button
                  type="button"
                  disabled={exporting}
                  onClick={() => void runExport()}
                  className="inline-flex items-center justify-center gap-2 rounded-lg border border-cs2-orange/55 bg-cs2-orange/20 px-4 py-2 text-[12px] font-bold text-cs2-orange hover:bg-cs2-orange/30 disabled:opacity-40"
                >
                  {exporting ? <Loader2 className="h-4 w-4 animate-spin" /> : <Clapperboard className="h-4 w-4" />}
                  导出合辑
                </button>
              </div>
            </div>
          </footer>
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
    </div>
  );
}
