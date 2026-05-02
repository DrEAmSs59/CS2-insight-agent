/** Montage workbench helpers — all functions tolerate missing fields. */

export const MONTAGE_THEMES = [
  {
    id: "highlight",
    name: "高光合集",
    description: "优先选择击杀、高评分和精彩操作片段",
  },
  {
    id: "funny_death",
    name: "下饭处刑合集",
    description: "优先选择下饭、梗死亡和节目效果片段",
  },
  {
    id: "contrast",
    name: "反差合集",
    description: "先放下饭片段，最后用高光片段收尾",
  },
  {
    id: "custom",
    name: "自定义合集",
    description: "手动选择片段和顺序",
  },
];

export function themeLabel(themeId) {
  const t = MONTAGE_THEMES.find((x) => x.id === themeId);
  return t?.name || "自定义合集";
}

/** Returns one of: 高光 | 下饭 | 梗死亡 | 击杀 | 普通片段 */
export function normalizeClipType(clip) {
  if (!clip || typeof clip !== "object") return "普通片段";
  const raw = (
    clip.clip_type ||
    clip.type ||
    clip.category ||
    clip.tag ||
    (Array.isArray(clip.tags) ? clip.tags[0] : "") ||
    ""
  )
    .toString()
    .toLowerCase();

  if (raw.includes("highlight") || raw.includes("高光")) return "高光";
  if (raw.includes("death") || raw.includes("死亡") || raw.includes("下饭") || raw.includes("funny")) return "下饭";
  if (raw.includes("meme") || raw.includes("梗")) return "梗死亡";
  if (raw.includes("kill") || raw.includes("击杀")) return "击杀";
  return "普通片段";
}

export function getClipTitle(clip) {
  if (!clip || typeof clip !== "object") return "未命名片段";
  const t =
    clip.title ||
    clip.clip_title ||
    clip.name ||
    (typeof clip.label === "string" ? clip.label : null);
  if (t && String(t).trim()) return String(t).trim();
  const p = clip.output_path || clip.path || "";
  if (typeof p === "string" && p.trim()) {
    const base = p.split(/[/\\]/).pop() || p;
    return base.replace(/\.[^.]+$/, "") || base || "未命名片段";
  }
  return clip.clip_id ? `片段 ${clip.clip_id}` : "未命名片段";
}

export function getClipDurationSeconds(clip) {
  if (!clip || typeof clip !== "object") return null;
  const keys = ["duration_sec", "duration", "length_sec", "length"];
  for (const k of keys) {
    const v = clip[k];
    if (v == null) continue;
    const n = Number(v);
    if (Number.isFinite(n) && n >= 0) return n;
  }
  return null;
}

export function formatDuration(seconds) {
  if (seconds == null || !Number.isFinite(Number(seconds))) return "未知";
  const s = Math.max(0, Math.floor(Number(seconds)));
  const m = Math.floor(s / 60);
  const r = s % 60;
  return `${String(m).padStart(2, "0")}:${String(r).padStart(2, "0")}`;
}

/** Header / timeline: empty montage shows 00:00; clips with no duration data show 未知 */
export function formatMontageEstimate(totalKnownSeconds, clipCount) {
  const n = Number(clipCount) || 0;
  if (n <= 0) return formatDuration(0);
  if (totalKnownSeconds > 0) return formatDuration(totalKnownSeconds);
  return "未知";
}

export function getClipScore(clip) {
  if (!clip || typeof clip !== "object") return null;
  const keys = ["score", "rating", "highlight_score", "funny_score", "ai_score"];
  for (const k of keys) {
    const v = clip[k];
    if (v == null) continue;
    const n = Number(v);
    if (Number.isFinite(n)) return n;
  }
  return null;
}

export function getClipComment(clip) {
  if (!clip || typeof clip !== "object") return "";
  const keys = [
    "ai_comment",
    "ai_commentary",
    "comment",
    "commentary",
    "ai_review",
    "review",
    "ai_meme_montage_commentary",
  ];
  for (const k of keys) {
    const v = clip[k];
    if (v != null && String(v).trim()) return String(v).trim();
  }
  return "";
}

function clipSearchBlob(clip) {
  if (!clip || typeof clip !== "object") return "";
  const parts = [
    clip.output_path,
    clip.demo_path,
    clip.demo_filename,
    clip.player_name,
    clip.clip_id,
    getClipTitle(clip),
    getClipComment(clip),
    clip.clip_type,
    clip.type,
    clip.category,
    clip.tag,
    Array.isArray(clip.tags) ? clip.tags.join(" ") : "",
  ];
  return parts.filter(Boolean).join(" ").toLowerCase();
}

export function isClipMatchedBySearch(clip, keyword) {
  const k = (keyword || "").trim().toLowerCase();
  if (!k) return true;
  return clipSearchBlob(clip).includes(k);
}

/** Map / round / player subtitle line */
export function getClipMetaLine(clip) {
  if (!clip || typeof clip !== "object") return "";
  const mapName =
    (clip.map && String(clip.map).trim()) ||
    (clip.demo_map && String(clip.demo_map).trim()) ||
    (clip.demo_filename && String(clip.demo_filename).replace(/\.[^.]+$/, "").trim()) ||
    "";
  const round =
    clip.round != null
      ? `R${clip.round}`
      : clip.round_num != null
        ? `R${clip.round_num}`
        : "";
  const tick = clip.tick != null ? `tick ${clip.tick}` : "";
  const parts = [];
  if (mapName) parts.push(mapName);
  if (round) parts.push(round);
  else if (tick) parts.push(tick);
  const player = clip.player_name && String(clip.player_name).trim();
  if (player) parts.push(player);
  return parts.join(" · ");
}

const TIMELINE_KEYS = [
  ["round", (a, b) => _numCmp(a?.round, b?.round)],
  ["round_num", (a, b) => _numCmp(a?.round_num, b?.round_num)],
  ["tick", (a, b) => _numCmp(a?.tick, b?.tick)],
  ["start_tick", (a, b) => _numCmp(a?.start_tick, b?.start_tick)],
  ["created_at", (a, b) => _strCmp(a?.created_at, b?.created_at)],
  ["id", (a, b) => _numCmp(a?.id, b?.id)],
];

function _numCmp(x, y) {
  const nx = x != null && Number.isFinite(Number(x)) ? Number(x) : null;
  const ny = y != null && Number.isFinite(Number(y)) ? Number(y) : null;
  if (nx == null && ny == null) return 0;
  if (nx == null) return 1;
  if (ny == null) return -1;
  return nx - ny;
}

function _strCmp(x, y) {
  const sx = x != null ? String(x) : "";
  const sy = y != null ? String(y) : "";
  return sx.localeCompare(sy);
}

function compareTimeline(a, b) {
  for (const [, cmp] of TIMELINE_KEYS) {
    const d = cmp(a, b);
    if (d !== 0) return d;
  }
  return _numCmp(a?.id, b?.id);
}

function typeRankForFunnyFirst(t) {
  const order = ["下饭", "梗死亡", "普通片段", "高光", "击杀"];
  const i = order.indexOf(t);
  return i >= 0 ? i : 99;
}

/** strategies: timeline | score | funny_first | highlight_last */
export function sortClipsByStrategy(clipsInOrder, strategy) {
  if (!Array.isArray(clipsInOrder) || clipsInOrder.length === 0) return [];
  const indexed = clipsInOrder.map((c, i) => ({ c, i }));

  if (strategy === "timeline") {
    return [...indexed].sort((a, b) => compareTimeline(a.c, b.c) || a.i - b.i).map((x) => x.c);
  }

  if (strategy === "score") {
    return [...indexed].sort((a, b) => {
      const sa = getClipScore(a.c);
      const sb = getClipScore(b.c);
      const ha = sa != null;
      const hb = sb != null;
      if (ha && hb && sa !== sb) return sb - sa;
      if (ha && !hb) return -1;
      if (!ha && hb) return 1;
      return a.i - b.i;
    }).map((x) => x.c);
  }

  if (strategy === "funny_first") {
    return [...indexed].sort((a, b) => {
      const ra = typeRankForFunnyFirst(normalizeClipType(a.c));
      const rb = typeRankForFunnyFirst(normalizeClipType(b.c));
      if (ra !== rb) return ra - rb;
      return a.i - b.i;
    }).map((x) => x.c);
  }

  if (strategy === "highlight_last") {
    return [...indexed].sort((a, b) => {
      const ta = normalizeClipType(a.c);
      const tb = normalizeClipType(b.c);
      const la = ta === "高光" ? 1 : 0;
      const lb = tb === "高光" ? 1 : 0;
      if (la !== lb) return la - lb;
      return a.i - b.i;
    }).map((x) => x.c);
  }

  return [...clipsInOrder];
}

export function buildDefaultExportName(themeId) {
  const now = new Date();
  const date = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}-${String(now.getDate()).padStart(2, "0")}`;

  const themeNameMap = {
    highlight: "高光合集",
    funny_death: "下饭处刑合集",
    contrast: "反差合集",
    custom: "自定义合集",
  };

  return `CS2-${themeNameMap[themeId] || "合辑"}-${date}`;
}

export function buildShareText({ themeId, clipCount, durationText, outputPath }) {
  const themeTextMap = {
    highlight: "AI 帮我从 CS2 Demo 里剪了一个高光合集",
    funny_death: "AI 帮我从 CS2 Demo 里剪了一个下饭处刑合集",
    contrast: "AI 帮我从 CS2 Demo 里剪了一个高光和下饭反差合集",
    custom: "AI 帮我从 CS2 Demo 里剪了一个自定义合集",
  };

  const title = themeTextMap[themeId] || themeTextMap.custom;
  const n = Number(clipCount) || 0;
  const dur = durationText || "未知";
  const path = outputPath || "";
  return `${title}，共 ${n} 个片段，时长约 ${dur}。\n视频路径：${path}`;
}

export function ensureMp4Filename(name) {
  const s = (name || "").trim();
  if (!s) return "";
  if (/\.mp4$/i.test(s)) return s;
  return `${s}.mp4`;
}

export function stripMp4Extension(name) {
  return String(name || "").replace(/\.mp4$/i, "").trim();
}

/** Filter key: all | type tag | joined | unjoined */
export function clipMatchesFilter(clip, filterKey, orderedIdSet) {
  if (!clip || typeof clip !== "object") return false;
  const id = clip.id;
  if (filterKey === "joined") return orderedIdSet.has(id);
  if (filterKey === "unjoined") return !orderedIdSet.has(id);
  if (filterKey === "all") return true;
  const t = normalizeClipType(clip);
  if (filterKey === "高光") return t === "高光";
  if (filterKey === "下饭") return t === "下饭";
  if (filterKey === "梗死亡") return t === "梗死亡";
  if (filterKey === "击杀") return t === "击杀";
  if (filterKey === "普通片段") return t === "普通片段";
  return true;
}
