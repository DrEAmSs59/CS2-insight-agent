import { formatMontageApiError } from "../../utils/formatMontageApiError.js";
import { isTimelineSourceClip, mapNameFromClip, normalizeClipType } from "../../utils/montageUtils";

const FILTER_TABS = [
  { id: "all", labelKey: "montage.filterAll" },
  { id: "highlight", labelKey: "montage.filterHighlight" },
  { id: "timeline", labelKey: "montage.filterTimeline" },
  { id: "fail", labelKey: "montage.filterFail" },
  { id: "compilation", labelKey: "montage.filterCompilation" },
  { id: "joined", labelKey: "montage.filterJoined" },
  { id: "unjoined", labelKey: "montage.filterUnjoined" },
];

const DEFAULT_REL_EXPORT_DIR = "exports/montage";

const TRANSITION_TYPES = [
  { id: "none", labelKey: "montage.transitionNone" },
  { id: "cut", labelKey: "montage.transitionCut" },
  { id: "fade", labelKey: "montage.transitionFade" },
  { id: "flash", labelKey: "montage.transitionFlash" },
  { id: "dip_black", labelKey: "montage.transitionDipBlack" },
  { id: "zoom", labelKey: "montage.transitionZoom" },
];

const DEFAULT_TRANSITION = { type: "cut", duration: 0.25 };

/** 全局一键类型 /「统一时长」使用的固定秒数（不再单独暴露滑条） */
const GLOBAL_TRANSITION_PRESET_SEC = 0.4;

const GLOBAL_TRANSITION_TEMPLATES = [
  { id: "esports", labelKey: "montage.templateEsports" },
  { id: "film", labelKey: "montage.templateFilm" },
  { id: "funny", labelKey: "montage.templateFunny" },
  { id: "clean", labelKey: "montage.templateClean" },
];

const VALID_TRANSITION_TYPES = new Set(TRANSITION_TYPES.map((t) => t.id));

function transitionTypeLabel(type, t) {
  const found = TRANSITION_TYPES.find((tr) => tr.id === type);
  return found ? t(found.labelKey) : t("montage.transitionCut");
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

function formatTransitionNodeLine(map, sourceClipId, t) {
  const tr = getEffectiveTransition(map, sourceClipId);
  if (tr.type === "none") return t("montage.transitionNone");
  const d = tr.duration;
  const ds = Number.isInteger(d) ? String(d) : String(Math.round(d * 100) / 100);
  return `${transitionTypeLabel(tr.type, t)} · ${ds}s`;
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

function montageToastFromError(e, t) {
  return formatMontageApiError(e, t, t("montage.exportErrorGeneric"));
}

const FFMPEG_GATE_IDLE = {
  loading: true,
  blocked: false,
  subtitle: "",
  message: "",
  framemeldAvailable: false,
};

export { DEFAULT_REL_EXPORT_DIR, DEFAULT_TRANSITION, FFMPEG_GATE_IDLE, FILTER_TABS, GLOBAL_TRANSITION_PRESET_SEC, GLOBAL_TRANSITION_TEMPLATES, TRANSITION_TYPES, buildGlobalTransitionStyleMap, buildTimestampMontageFilename, buildTransitionsPayload, clipBasename, clipMatchesLibraryFilter, clipWeakBlob, dirnamePath, formatTransitionNodeLine, getEffectiveTransition, hydrateTransitionsFromApi, joinPathSegments, librarySearchMatch, montageToastFromError, normalizeTransition, pruneTransitionsToOrderedIds, transitionTypeLabel };
