/** Montage workbench helpers — all functions tolerate missing fields. */

import { isFreezeToDeathCompilation } from "./freezeToDeathRoundFilter";

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

/** 是否来自解析页「按回合时间线」入队（与 clip.category 独立，用于 UI / 合辑筛选） */
export function isTimelineSourceClip(clip) {
  if (!clip || typeof clip !== "object") return false;
  const s = String(clip.timeline_source || "").trim();
  return s === "round_timeline_event" || s === "round_timeline_round";
}

/** 解析页「整回合」入队：固定 tick 窗口，不支持剪辑节奏微调与回看视角 */
export function isRoundTimelineRoundClip(clip) {
  return String(clip?.timeline_source || "").trim() === "round_timeline_round";
}

/** 仅「整回合时间线」与「回合死亡合集」锁定单条剪辑节奏与回看；时间线单事件可改节奏 */
export function isClipPacingAndPovLocked(clip) {
  if (!clip || typeof clip !== "object") return false;
  return isRoundTimelineRoundClip(clip) || isFreezeToDeathCompilation(clip);
}

/**
 * 与 ClipCard CLIP_CATEGORY_CONFIG 一致：高光绿、下饭红、合集黄、时间线青、坐牢紫。
 * @param {Record<string, unknown>} clip
 */
export function queueBlockBadgeClass(clip) {
  if (!clip || typeof clip !== "object") return "border-white/15 bg-zinc-900/80 text-zinc-100";
  if (isTimelineSourceClip(clip)) {
    return "border-cyan-500/45 bg-cyan-950/55 text-cyan-100";
  }
  const cat = String(clip.category || "").toLowerCase();
  if (cat === "fail") return "border-cs2-fail/30 bg-cs2-fail/10 text-cs2-fail";
  if (cat === "meme_death") return "border-fuchsia-500/35 bg-fuchsia-500/10 text-fuchsia-300";
  if (cat === "compilation") return "border-cs2-compilation/35 bg-cs2-compilation/10 text-cs2-compilation";
  if (cat === "highlight") return "border-cs2-highlight/30 bg-cs2-highlight/10 text-cs2-highlight";
  return "border-white/15 bg-zinc-900/80 text-zinc-100";
}

export const MONTAGE_NEUTRAL_TYPE_BADGE_CLASS =
  "bg-zinc-500/15 text-zinc-400 ring-1 ring-white/10";

/** @param {string} tag `normalizeClipType` 返回值 */
export function montageTypeTagBadgeClass(tag) {
  switch (tag) {
    case "高光":
    case "击杀":
      return "bg-cs2-highlight/10 text-cs2-highlight ring-1 ring-cs2-highlight/35";
    case "下饭":
      return "bg-cs2-fail/10 text-cs2-fail ring-1 ring-cs2-fail/35";
    case "梗死亡":
      return "bg-fuchsia-500/15 text-fuchsia-200 ring-1 ring-fuchsia-500/40";
    case "合集":
      return "bg-cs2-compilation/10 text-cs2-compilation ring-1 ring-cs2-compilation/40";
    case "时间线":
      return "bg-cyan-500/15 text-cyan-100 ring-1 ring-cyan-500/35";
    default:
      return MONTAGE_NEUTRAL_TYPE_BADGE_CLASS;
  }
}

/** Returns one of: 高光 | 下饭 | 梗死亡 | 击杀 | 合集 | 时间线 | 普通片段 */
export function normalizeClipType(clip) {
  if (!clip || typeof clip !== "object") return "普通片段";
  if (isTimelineSourceClip(clip)) return "时间线";
  const cat = String(clip.category || "").trim().toLowerCase();
  if (cat === "highlight") return "高光";
  if (cat === "fail") return "下饭";
  if (cat === "meme_death") return "梗死亡";
  if (cat === "compilation") return "合集";
  const raw = (
    clip.clip_type ||
    clip.type ||
    clip.tag ||
    (Array.isArray(clip.tags) ? clip.tags[0] : "") ||
    ""
  )
    .toString()
    .toLowerCase();

  if (raw.includes("highlight") || raw.includes("高光")) return "高光";
  if (raw.includes("death") || raw.includes("死亡") || raw.includes("下饭") || raw.includes("funny")) return "下饭";
  if (raw.includes("meme") || raw.includes("梗")) return "梗死亡";
  if (raw.includes("compilation") || raw.includes("合集")) return "合集";
  if (raw.includes("kill") || raw.includes("击杀")) return "击杀";
  return "普通片段";
}

export function getClipTitle(clip) {
  if (!clip || typeof clip !== "object") return "未命名片段";
  if (isTimelineSourceClip(clip)) {
    if (String(clip.timeline_source || "").trim() === "round_timeline_round") {
      return "整回合时间线";
    }
    const kind = String(clip.timeline_record_kind || "").trim();
    if (kind === "death") return "时间线死亡";
    if (kind === "kill") return "时间线击杀";
    return "时间线片段";
  }
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

/** 合集 compilation_kind → 简短中文（仅 UI） */
export const COMPILATION_KIND_ZH = {
  rival_kills: "亲儿子喂饭",
  all_kills: "全部击杀",
  nemesis_deaths: "本命苦主",
  all_deaths: "全部死亡",
  freeze_to_death: "回合死亡合集",
};

export function humanizeCompilationKind(kind) {
  if (kind == null || kind === "") return "";
  const k = String(kind);
  return COMPILATION_KIND_ZH[k] || k;
}

/** 队列/检查器展示用：无标题时避免只显示 `片段 c_xxx` 技术 id。 */
export function friendlyClipTitleForQueue(clip) {
  if (!clip || typeof clip !== "object") return "未命名片段";
  const raw = getClipTitle(clip);
  if (typeof raw !== "string" || !/^片段\s+c_[a-f0-9]{6,}$/i.test(raw.trim())) {
    return raw;
  }
  const tags = Array.isArray(clip.context_tags) ? clip.context_tags : [];
  for (const t of tags) {
    if (typeof t === "string" && t.trim()) return t.trim();
  }
  const map = String(clip.map_name || clip.map || "").trim();
  const cat = String(clip.category || "");
  const kind = String(clip.compilation_kind || "");
  const typeBase =
    cat === "highlight"
      ? "高光片段"
      : cat === "fail"
        ? "下饭片段"
        : cat === "meme_death"
          ? "梗死亡片段"
          : cat === "compilation"
            ? kind
              ? `合集 · ${humanizeCompilationKind(kind)}`
              : "合集片段"
            : "片段";
  return map ? `${typeBase} · ${map}` : typeBase;
}

/**
 * 高光 / 下饭：一行展示「击杀了谁 / 被谁击杀」与武器（与解析字段 weapon_used、victims、killer_name 对齐）。
 * @param {Record<string, unknown>} clip
 */
export function formatClipCombatSummaryLine(clip) {
  if (!clip || typeof clip !== "object") return "";
  const cat = String(clip.category || "").trim().toLowerCase();
  const rawW = String(clip.weapon_used || "").trim();
  const weapons = rawW
    ? rawW
        .split(" / ")
        .map((x) => String(x).trim())
        .filter(Boolean)
    : [];

  if (cat === "highlight") {
    const victims = Array.isArray(clip.victims)
      ? clip.victims.map((v) => String(v ?? "").trim()).filter(Boolean)
      : [];
    const parts = [];
    if (victims.length) parts.push(`击杀 ${victims.join("、")}`);
    if (weapons.length) parts.push(weapons.join(" / "));
    return parts.join(" · ");
  }
  if (cat === "fail") {
    const killer = String(clip.killer_name || "").trim();
    const parts = [];
    if (killer) parts.push(`击杀者 ${killer}`);
    if (weapons.length) parts.push(weapons.join(" / "));
    else if (rawW) parts.push(rawW);
    return parts.join(" · ");
  }
  return "";
}

/** CS2 录像 tickrate（与后端 demo_parser.TICK_RATE 一致，用于粗算时长） */
export const DEMO_TICK_RATE = 64;

export function getClipDurationSeconds(clip) {
  if (!clip || typeof clip !== "object") return null;
  const keys = ["duration_sec", "duration", "length_sec", "length"];
  for (const k of keys) {
    const v = clip[k];
    if (v == null) continue;
    const n = Number(v);
    if (Number.isFinite(n) && n >= 0) return n;
  }
  const st = Number(clip.start_tick);
  const et = Number(clip.end_tick);
  if (Number.isFinite(st) && Number.isFinite(et) && et > st) {
    return (et - st) / DEMO_TICK_RATE;
  }
  return null;
}

/**
 * 亲儿子喂饭 / 全部击杀：按 source_ticks 累加各段跨度（秒）。
 * @param {Record<string, unknown>} clip
 */
export function getCompilationSourceTicksSpanSeconds(clip) {
  const raw = clip?.source_ticks;
  if (!Array.isArray(raw) || raw.length === 0) return null;
  const kind = String(clip?.compilation_kind || "");
  if (kind !== "rival_kills" && kind !== "all_kills") return null;
  let sum = 0;
  for (const p of raw) {
    if (!Array.isArray(p) || p.length < 2) continue;
    const a = Number(p[0]);
    const b = Number(p[1]);
    if (Number.isFinite(a) && Number.isFinite(b) && b > a) sum += (b - a) / DEMO_TICK_RATE;
  }
  return sum > 0 ? sum : null;
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
  const order = ["下饭", "梗死亡", "普通片段", "时间线", "高光", "击杀"];
  const i = order.indexOf(t);
  return i >= 0 ? i : 99;
}

/** strategies: timeline | score | funny_first | highlight_first | highlight_last | random | rhythm */
export function sortClipsByStrategy(clipsInOrder, strategy) {
  if (!Array.isArray(clipsInOrder) || clipsInOrder.length === 0) return [];
  const indexed = clipsInOrder.map((c, i) => ({ c, i }));

  if (strategy === "random") {
    const shuffled = [...indexed];
    for (let i = shuffled.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [shuffled[i], shuffled[j]] = [shuffled[j], shuffled[i]];
    }
    return shuffled.map((x) => x.c);
  }

  if (strategy === "rhythm") {
    const hl = indexed.filter(({ c }) => c.category === "highlight").map((x) => x.c);
    const fd = indexed.filter(({ c }) => c.category === "fail" || c.category === "meme_death").map((x) => x.c);
    const comp = indexed.filter(({ c }) => c.category === "compilation").map((x) => x.c);
    const rest = indexed
      .filter(
        ({ c }) =>
          c.category !== "highlight" &&
          c.category !== "fail" &&
          c.category !== "meme_death" &&
          c.category !== "compilation",
      )
      .map((x) => x.c);
    const qs = [hl, fd, comp, rest].filter((q) => q.length > 0);
    const out = [];
    while (qs.some((q) => q.length)) {
      for (const q of qs) {
        if (q.length) out.push(q.shift());
      }
    }
    return out;
  }

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
      const la = ta === "高光" ? 2 : ta === "时间线" ? 1 : 0;
      const lb = tb === "高光" ? 2 : tb === "时间线" ? 1 : 0;
      if (la !== lb) return la - lb;
      return a.i - b.i;
    }).map((x) => x.c);
  }

  if (strategy === "highlight_first") {
    return [...indexed].sort((a, b) => {
      const ta = normalizeClipType(a.c);
      const tb = normalizeClipType(b.c);
      const ha = ta === "高光" ? 2 : ta === "时间线" ? 1 : 0;
      const hb = tb === "高光" ? 2 : tb === "时间线" ? 1 : 0;
      if (ha !== hb) return hb - ha;
      return a.i - b.i;
    }).map((x) => x.c);
  }

  return [...clipsInOrder];
}

/** 素材池第二行：Demo、回合、击杀/死亡对象、武器 */
export function getMontageClipFactLine(clip) {
  if (!clip || typeof clip !== "object") return "";
  const demo =
    (clip.demo_filename && String(clip.demo_filename).replace(/\.(dem|mp4)$/i, "").trim()) ||
    (clip.demo_path && String(clip.demo_path).split(/[/\\]/).pop()?.replace(/\.dem$/i, "").trim()) ||
    "";
  const rnd = clip.round != null && Number.isFinite(Number(clip.round)) ? `第${clip.round}回合` : "";
  const w = (clip.weapon_used && String(clip.weapon_used).split(" / ")[0]?.trim()) || "";
  const cat = String(clip.category || "").toLowerCase();
  const victims = Array.isArray(clip.victims) ? clip.victims.map((v) => String(v || "").trim()).filter(Boolean) : [];
  const kc = Number(clip.kill_count);
  let action = "";
  if (cat === "fail") {
    const killer = String(clip.killer_name || "").trim();
    action = killer ? `被 ${killer} 击杀` : "死亡";
  } else if (victims.length) {
    const kPart = Number.isFinite(kc) && kc > 0 ? `${kc}杀 · ` : "";
    action = `${kPart}${victims.join("、")}`;
  } else if (Number.isFinite(kc) && kc > 0) {
    action = `${kc}杀`;
  }
  const parts = [demo, rnd, action, w].filter(Boolean);
  return parts.join(" · ");
}

export function getMontageTimelineVariant(clip) {
  if (!clip || typeof clip !== "object") return "neutral";
  if (isTimelineSourceClip(clip)) return "timeline";
  const cat = String(clip.category || "").toLowerCase();
  if (cat === "fail" || cat === "meme_death") return "fail";
  if (cat === "compilation") return "compilation";
  const tags = Array.isArray(clip.context_tags) ? clip.context_tags : [];
  if (tags.some((t) => String(t).includes("ACE") || String(t).includes("五杀"))) return "ace";
  const kc = Number(clip.kill_count);
  if (Number.isFinite(kc) && kc >= 5) return "ace";
  if (Number.isFinite(kc) && kc >= 3) return "multikill";
  if (cat === "highlight") return "highlight";
  if (clip.player_name && String(clip.player_name).trim()) return "pov";
  return "neutral";
}

/** 0–1 强度：用于节奏可视化（ACE / 多杀偏高，下饭偏低；时长略加权）。 */
export function getClipPacingIntensity(clip, maxDurSeconds) {
  const v = getMontageTimelineVariant(clip);
  let base = 0.34;
  if (v === "ace") base = 1;
  else if (v === "multikill") base = 0.84;
  else if (v === "highlight") base = 0.62;
  else if (v === "timeline") base = 0.55;
  else if (v === "compilation") base = 0.52;
  else if (v === "pov") base = 0.46;
  else if (v === "fail") base = 0.36;
  const dur = getClipDurationSeconds(clip);
  let durBoost = 1;
  if (dur != null && Number.isFinite(maxDurSeconds) && maxDurSeconds > 0.01) {
    durBoost = 0.62 + 0.38 * Math.min(1, dur / maxDurSeconds);
  }
  return Math.min(1, base * durBoost);
}

export function mapNameFromClip(clip) {
  if (!clip || typeof clip !== "object") return "";
  const m =
    (clip.map_name && String(clip.map_name).trim()) ||
    (clip.map && String(clip.map).trim()) ||
    (clip.demo_map && String(clip.demo_map).trim()) ||
    "";
  if (m) return m;
  const df = clip.demo_filename && String(clip.demo_filename).replace(/\.[^.]+$/, "").trim();
  return df || "";
}

/** 编排时间线徽标：时间线 | 高光 | 下饭 | 合集 */
export function getMontageBlockShortLabel(clip) {
  if (!clip || typeof clip !== "object") return "高光";
  if (isTimelineSourceClip(clip)) return "时间线";
  const cat = String(clip.category || "").toLowerCase();
  if (cat === "compilation") return "合集";
  if (cat === "fail" || cat === "meme_death") return "下饭";
  return "高光";
}

/** 回合比分：优先 CS2 双方 CT/T；否则回退为解析侧 己方/对方。 */
export function getMontageScorePair(clip) {
  if (!clip || typeof clip !== "object") return null;
  const ct = clip.score_ct;
  const st = clip.score_t != null ? clip.score_t : clip.score_st;
  if (ct != null && st != null && Number.isFinite(Number(ct)) && Number.isFinite(Number(st))) {
    return { leftLabel: "CT", left: Number(ct), rightLabel: "T", right: Number(st) };
  }
  const o = clip.score_own;
  const p = clip.score_opp;
  if (o != null && p != null && Number.isFinite(Number(o)) && Number.isFinite(Number(p))) {
    return { leftLabel: "己", left: Number(o), rightLabel: "敌", right: Number(p) };
  }
  return null;
}

/** 地图名右侧小圆点用色（与具体地图名弱关联，仅作视觉区分） */
export function mapNameAccentDotClass(mapName) {
  const s = String(mapName || "");
  let h = 0;
  for (let i = 0; i < s.length; i += 1) h = (h * 33 + s.charCodeAt(i)) >>> 0;
  const palette = [
    "bg-sky-400",
    "bg-emerald-400",
    "bg-amber-400",
    "bg-fuchsia-400",
    "bg-cyan-400",
    "bg-rose-400",
    "bg-violet-400",
  ];
  return palette[h % palette.length];
}

/** 受害者/击杀者 POV 段 tooltip：逐段玩家名 */
export function getVictimPovSegmentsTooltip(clip) {
  const segs = Array.isArray(clip?.victim_pov_segments) ? clip.victim_pov_segments : [];
  if (segs.length === 0) return "";
  return segs
    .map((s) => {
      const n = String(s?.player_name || "").trim();
      if (!n) return "";
      const t = String(s?.perspective_type || "").toLowerCase();
      if (t === "victim") return `${n}（受害者）`;
      if (t === "killer") return `${n}（击杀者）`;
      return n;
    })
    .filter(Boolean)
    .join("、");
}

/** 入库录像卡片：回放视角中文；优先落库字段 recording_perspective + victim_pov_segments */
export function getRecordedClipPerspectiveZh(clip) {
  if (!clip || typeof clip !== "object") return "观战视角";
  const rp = String(clip.recording_perspective || "").trim();
  const fromEnum = {
    pov_hud: "POV HUD 视角",
    player_follow: "玩家视角",
    spectator: "观战视角",
  }[rp];

  const segs = Array.isArray(clip.victim_pov_segments) ? clip.victim_pov_segments : [];
  const nVictim = segs.filter((s) => String(s?.perspective_type || "").toLowerCase() === "victim").length;
  const victimSuffix = nVictim > 0 ? `含 ${nVictim} 段受害者视角` : "";

  if (fromEnum) {
    return victimSuffix ? `${fromEnum} · ${victimSuffix}` : fromEnum;
  }

  const pn = String(clip.player_name || "").trim();
  const pnNorm = pn.toLowerCase();
  const killer = String(clip.killer_name || "").trim();
  const killerNorm = killer.toLowerCase();
  const victims = Array.isArray(clip.victims) ? clip.victims : [];
  const hasVictimNames = victims.some((v) => String(v || "").trim());
  const cat = String(clip.category || "").toLowerCase();

  const matchesVictim = pnNorm && victims.some((v) => String(v || "").trim().toLowerCase() === pnNorm);
  const matchesKiller = pnNorm && killerNorm && pnNorm === killerNorm;

  let legacy = "";
  if (matchesVictim && matchesKiller) legacy = "含受害者与击杀者视角";
  else if (matchesVictim) legacy = "受害者视角";
  else if (matchesKiller) legacy = "击杀者视角";
  else if (Array.isArray(clip.record_segments) && clip.record_segments.length > 1) legacy = "含受害者视角";
  else if ((cat === "highlight" || cat === "compilation") && hasVictimNames) legacy = "含受害者视角";
  else if (pn) legacy = "玩家视角";
  else legacy = "观战视角";

  return victimSuffix ? `${legacy} · ${victimSuffix}` : legacy;
}

/** 不含「含 N 段受害者视角」后缀，便于与独立受害者 chip 并排展示 */
export function getRecordedClipPerspectivePrimaryZh(clip) {
  const full = getRecordedClipPerspectiveZh(clip);
  const idx = full.indexOf(" · 含 ");
  if (idx >= 0) return full.slice(0, idx).trim();
  return full;
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
  if (filterKey === "合集") return t === "合集";
  if (filterKey === "击杀") return t === "击杀";
  if (filterKey === "普通片段") return t === "普通片段";
  if (filterKey === "时间线") return t === "时间线";
  return true;
}
