/** Montage workbench helpers — all functions tolerate missing fields. */

import { isFreezeToDeathCompilation } from "./freezeToDeathRoundFilter";
import { weaponUsedTokens } from "../i18n/weaponNames.js";

/** 移除字符串中的 emoji 及变体选择符，避免在部分环境下渲染为方块。 */
export function stripTagEmoji(str) {
  if (typeof str !== "string") return str;
  return str
    .replace(/[\p{Emoji_Presentation}\p{Extended_Pictographic}]/gu, "")
    .replace(/️/gu, "")
    .trim();
}

/**
 * Theme metadata for MONTAGE_THEMES.
 * `nameKey`/`descKey` are i18n keys; callers resolve via t().
 * `exportToken` is the stable ASCII string used in export filenames (locale-independent).
 */
export const MONTAGE_THEMES = [
  {
    id: "highlight",
    nameKey: "montage.themeHighlightName",
    descKey: "montage.themeHighlightDesc",
    exportToken: "Highlights",
  },
  {
    id: "funny_death",
    nameKey: "montage.themeFunnyDeathName",
    descKey: "montage.themeFunnyDeathDesc",
    exportToken: "FunnyDeaths",
  },
  {
    id: "contrast",
    nameKey: "montage.themeContrastName",
    descKey: "montage.themeContrastDesc",
    exportToken: "Contrast",
  },
  {
    id: "custom",
    nameKey: "montage.themeCustomName",
    descKey: "montage.themeCustomDesc",
    exportToken: "Custom",
  },
];

/** Return a resolved-name list suitable for MontageThemeSelector. */
export function getThemesForSelector(t) {
  return MONTAGE_THEMES.map((th) => ({
    id: th.id,
    name: t(th.nameKey),
    description: t(th.descKey),
    exportToken: th.exportToken,
  }));
}

/** Return the translated label for a theme id. Accepts `t` from useT(). */
export function themeLabel(themeId, t) {
  const th = MONTAGE_THEMES.find((x) => x.id === themeId);
  return th ? t(th.nameKey) : t("montage.themeCustomName");
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
  if (!clip || typeof clip !== "object") return "border-cs2-border bg-zinc-900/80 text-cs2-text-primary";
  if (isTimelineSourceClip(clip)) {
    return "border-cyan-500/45 bg-cs2-cyan-surface text-cyan-100";
  }
  const cat = String(clip.category || "").toLowerCase();
  if (cat === "fail") return "border-cs2-fail/30 bg-cs2-fail/10 text-cs2-fail";
  if (cat === "meme_death") return "border-fuchsia-500/35 bg-fuchsia-500/10 text-fuchsia-300";
  if (cat === "compilation") return "border-cs2-compilation/35 bg-cs2-compilation/10 text-cs2-compilation";
  if (cat === "highlight") return "border-cs2-highlight/30 bg-cs2-highlight/10 text-cs2-highlight";
  return "border-cs2-border bg-zinc-900/80 text-cs2-text-primary";
}

export const MONTAGE_NEUTRAL_TYPE_BADGE_CLASS =
  "bg-zinc-500/15 text-cs2-text-secondary ring-1 ring-white/10";

/** @param {string} tag `normalizeClipType` 返回值 */
export function montageTypeTagBadgeClass(tag) {
  switch (tag) {
    case "高光":
    case "击杀":
      return "bg-cs2-highlight/10 text-cs2-highlight ring-1 ring-cs2-highlight/35";
    case "下饭":
      return "bg-cs2-fail/10 text-cs2-fail ring-1 ring-cs2-fail/35";
    case "梗死亡":
      return "bg-fuchsia-500/15 text-cs2-fuchsia-on-surface ring-1 ring-fuchsia-500/40";
    case "合集":
    case "击杀合集":
    case "死亡合集":
    case "回合合集":
      return "bg-cs2-compilation/10 text-cs2-compilation ring-1 ring-cs2-compilation/40";
    case "时间线":
    case "时间线击杀":
    case "时间线死亡":
    case "时间线整回合":
      return "bg-cyan-500/15 text-cyan-100 ring-1 ring-cyan-500/35";
    default:
      return MONTAGE_NEUTRAL_TYPE_BADGE_CLASS;
  }
}

/**
 * Maps the stable type tag returned by `normalizeClipType` to an i18n key.
 * Use in components: `t(clipTypeI18nKey(normalizeClipType(clip)))`.
 * @param {string} tag — one of normalizeClipType's return values
 * @returns {string} — montage.clipType* i18n key
 */
export function clipTypeI18nKey(tag) {
  const MAP = {
    "高光": "montage.clipTypeHighlight",
    "下饭": "montage.clipTypeFail",
    "梗死亡": "montage.clipTypeMemeDeath",
    "击杀": "montage.clipTypeKill",
    "合集": "montage.clipTypeCompilation",
    "击杀合集": "montage.clipTypeKillCompilation",
    "死亡合集": "montage.clipTypeDeathCompilation",
    "回合合集": "montage.clipTypeRoundCompilation",
    "时间线": "montage.clipTypeTimeline",
    "时间线击杀": "montage.clipTypeTimelineKill",
    "时间线死亡": "montage.clipTypeTimelineDeath",
    "时间线整回合": "montage.clipTypeTimelineRound",
    "普通片段": "montage.clipTypeNormal",
  };
  return MAP[tag] || "montage.clipTypeNormal";
}

/** Returns one of: 高光 | 下饭 | 梗死亡 | 击杀 | 合集 | 击杀合集 | 死亡合集 | 回合合集 | 时间线 | 时间线击杀 | 时间线死亡 | 时间线整回合 | 普通片段 */
export function normalizeClipType(clip) {
  if (!clip || typeof clip !== "object") return "普通片段";

  // workbench_clip_kind / recording_request_type take priority for V3 clips
  const wck = String(clip.workbench_clip_kind || clip.recording_request_type || "").trim();
  if (wck === "timeline_kill") return "时间线击杀";
  if (wck === "timeline_death") return "时间线死亡";
  if (wck === "timeline_round") return "时间线整回合";
  if (wck === "kill_compilation") return "击杀合集";
  if (wck === "death_compilation") return "死亡合集";
  if (wck === "round_compilation") return "回合合集";
  if (wck === "highlight") return "高光";
  if (wck === "fail") return "下饭";

  // Legacy: timeline_source/timeline_record_kind
  if (isTimelineSourceClip(clip)) {
    const kind = String(clip.timeline_record_kind || "").trim();
    if (kind === "kill") return "时间线击杀";
    if (kind === "death") return "时间线死亡";
    if (kind === "round") return "时间线整回合";
    return "时间线";
  }

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

/**
 * Returns the display title for a clip.
 * Accepts `t` from useT() to translate fallback strings.
 * @param {Record<string, unknown>} clip
 * @param {Function} t — translation function from useT()
 */
export function getClipTitle(clip, t) {
  if (!clip || typeof clip !== "object") return t("montage.clipTitleUnnamed");
  if (isTimelineSourceClip(clip)) {
    if (String(clip.timeline_source || "").trim() === "round_timeline_round") {
      return t("montage.clipTitleTimelineRound");
    }
    const kind = String(clip.timeline_record_kind || "").trim();
    if (kind === "death") return t("montage.clipTypeTimelineDeath");
    if (kind === "kill") return t("montage.clipTypeTimelineKill");
    return t("montage.clipTitleTimelineSegment");
  }
  const raw =
    clip.title ||
    clip.clip_title ||
    clip.name ||
    (typeof clip.label === "string" ? clip.label : null);
  if (raw && String(raw).trim()) return String(raw).trim();
  const p = clip.output_path || clip.path || "";
  if (typeof p === "string" && p.trim()) {
    const base = p.split(/[/\\]/).pop() || p;
    return base.replace(/\.[^.]+$/, "") || base || t("montage.clipTitleUnnamed");
  }
  return clip.clip_id ? t("montage.clipTitleFragment", { id: clip.clip_id }) : t("montage.clipTitleUnnamed");
}

/**
 * Stable ASCII token used in export filenames for each compilation kind.
 * Never localised — filenames must be locale-independent.
 */
export const COMPILATION_KIND_EXPORT_TOKEN = {
  rival_kills: "NemesisFeeder",
  all_kills: "AllKills",
  nemesis_deaths: "NemesisDeaths",
  all_deaths: "AllDeaths",
  freeze_to_death: "RoundDeaths",
};

/**
 * Maps compilation_kind to its i18n key for UI display.
 */
export const COMPILATION_KIND_KEY_MAP = {
  rival_kills: "montage.compilationKindRivalKills",
  all_kills: "montage.compilationKindAllKills",
  nemesis_deaths: "montage.compilationKindNemesisDeaths",
  all_deaths: "montage.compilationKindAllDeaths",
  freeze_to_death: "montage.compilationKindFreezeToDeath",
};

/**
 * Returns the translated display label for a compilation kind.
 * @param {string} kind
 * @param {Function} t — translation function from useT()
 */
export function humanizeCompilationKind(kind, t) {
  if (kind == null || kind === "") return "";
  const k = String(kind);
  const key = COMPILATION_KIND_KEY_MAP[k];
  return key ? t(key) : k;
}

/**
 * 队列/检查器展示用：无标题时避免只显示 `片段 c_xxx` 技术 id。
 * @param {Record<string, unknown>} clip
 * @param {Function} t — translation function from useT()
 */
export function friendlyClipTitleForQueue(clip, t) {
  if (!clip || typeof clip !== "object") return t("montage.clipTitleUnnamed");
  const raw = getClipTitle(clip, t);
  if (typeof raw !== "string" || !/^片段\s+c_[a-f0-9]{6,}$/i.test(raw.trim())) {
    return raw;
  }
  const tags = Array.isArray(clip.context_tags) ? clip.context_tags : [];
  for (const tag of tags) {
    if (typeof tag === "string" && tag.trim()) return tag.trim();
  }
  const map = String(clip.map_name || clip.map || "").trim();
  const cat = String(clip.category || "");
  const kind = String(clip.compilation_kind || "");
  const typeBase =
    cat === "highlight"
      ? t("montage.catHighlightClip")
      : cat === "fail"
        ? t("montage.catFailClip")
        : cat === "meme_death"
          ? t("montage.catMemeDeathClip")
          : cat === "compilation"
            ? kind
              ? t("montage.compilationWith", { kind: humanizeCompilationKind(kind, t) })
              : t("montage.compilationClip")
            : t("montage.genericClip");
  return map ? `${typeBase} · ${map}` : typeBase;
}

/**
 * 高光 / 下饭：一行展示「击杀了谁 / 被谁击杀」与武器（与解析字段 weapon_used、victims、killer_name 对齐）。
 * @param {Record<string, unknown>} clip
 * @param {Function} t — translation function from useT()
 * @param {string} [locale="zh"]
 */
export function formatClipCombatSummaryLine(clip, t, locale = "zh") {
  if (!clip || typeof clip !== "object") return "";
  const cat = String(clip.category || "").trim().toLowerCase();
  const weapons = weaponUsedTokens(clip.weapon_used, locale);

  if (cat === "highlight") {
    const victims = Array.isArray(clip.victims)
      ? clip.victims.map((v) => String(v ?? "").trim()).filter(Boolean)
      : [];
    const parts = [];
    if (victims.length) parts.push(t("montage.combatKills", { names: victims.join("、") }));
    if (weapons.length) parts.push(weapons.join(" / "));
    return parts.join(" · ");
  }
  if (cat === "fail") {
    const killer = String(clip.killer_name || "").trim();
    const parts = [];
    if (killer) parts.push(t("montage.combatKilledBy", { killer }));
    if (weapons.length) parts.push(weapons.join(" / "));
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

/**
 * Format seconds as MM:SS. When `t` is provided and seconds is invalid, returns t("montage.durationUnknown").
 * @param {number|null} seconds
 * @param {Function} [t] — optional translation function; if omitted, falls back to "?"
 */
export function formatDuration(seconds, t) {
  if (seconds == null || !Number.isFinite(Number(seconds))) {
    return t ? t("montage.durationUnknown") : "?";
  }
  const s = Math.max(0, Math.floor(Number(seconds)));
  const m = Math.floor(s / 60);
  const r = s % 60;
  return `${String(m).padStart(2, "0")}:${String(r).padStart(2, "0")}`;
}

/**
 * Header / timeline: empty montage shows 00:00; clips with no duration data show translated "Unknown".
 * @param {number} totalKnownSeconds
 * @param {number} clipCount
 * @param {Function} t — translation function from useT()
 */
export function formatMontageEstimate(totalKnownSeconds, clipCount, t) {
  const n = Number(clipCount) || 0;
  if (n <= 0) return formatDuration(0, t);
  if (totalKnownSeconds > 0) return formatDuration(totalKnownSeconds, t);
  return t ? t("montage.durationUnknown") : "?";
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
  // Note: getClipTitle is NOT called here to avoid requiring `t` in a search helper.
  // clip.title / clip.clip_title / clip.name cover the real titles well enough.
  const parts = [
    clip.output_path,
    clip.demo_path,
    clip.demo_filename,
    clip.player_name,
    clip.clip_id,
    clip.title,
    clip.clip_title,
    clip.name,
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
  const order = ["下饭", "梗死亡", "普通片段", "时间线", "时间线击杀", "时间线死亡", "时间线整回合", "高光", "击杀", "合集", "击杀合集", "死亡合集", "回合合集"];
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
      const _isTimeline = (t) => t === "时间线" || t === "时间线击杀" || t === "时间线死亡" || t === "时间线整回合";
      const la = ta === "高光" ? 2 : _isTimeline(ta) ? 1 : 0;
      const lb = tb === "高光" ? 2 : _isTimeline(tb) ? 1 : 0;
      if (la !== lb) return la - lb;
      return a.i - b.i;
    }).map((x) => x.c);
  }

  if (strategy === "highlight_first") {
    return [...indexed].sort((a, b) => {
      const ta = normalizeClipType(a.c);
      const tb = normalizeClipType(b.c);
      const _isTimeline = (t) => t === "时间线" || t === "时间线击杀" || t === "时间线死亡" || t === "时间线整回合";
      const ha = ta === "高光" ? 2 : _isTimeline(ta) ? 1 : 0;
      const hb = tb === "高光" ? 2 : _isTimeline(tb) ? 1 : 0;
      if (ha !== hb) return hb - ha;
      return a.i - b.i;
    }).map((x) => x.c);
  }

  return [...clipsInOrder];
}

/**
 * Return a concise round label string for display badges and fact lines.
 * Compilation clips with multiple source_rounds show "R4·5·9".
 * Single-round clips show "R4". Returns null if no round info.
 */
export function getClipRoundLabel(clip) {
  if (!clip || typeof clip !== "object") return null;
  const srcRounds = Array.isArray(clip.source_rounds)
    ? clip.source_rounds.map(Number).filter(Number.isFinite)
    : [];
  if (srcRounds.length > 1) return `R${srcRounds.join("·")}`;
  const r = clip.round != null && Number.isFinite(Number(clip.round)) ? Number(clip.round) : null;
  return r != null ? `R${r}` : null;
}

/**
 * 回合、击杀/死亡对象、武器摘要行；includeDemoName=false 时省略 Demo 文件名（素材池用）。
 * @param {Record<string, unknown>} clip
 * @param {{ includeDemoName?: boolean }} opts
 * @param {Function} t — translation function from useT()
 * @param {string} [locale="zh"]
 */
export function getMontageClipFactLine(clip, { includeDemoName = true } = {}, t, locale = "zh") {
  if (!clip || typeof clip !== "object") return "";
  const demo = includeDemoName
    ? (clip.demo_filename && String(clip.demo_filename).replace(/\.(dem|mp4)$/i, "").trim()) ||
      (clip.demo_path && String(clip.demo_path).split(/[/\\]/).pop()?.replace(/\.dem$/i, "").trim()) ||
      ""
    : "";
  // For compilation clips spanning multiple rounds, show all rounds.
  const srcRounds = Array.isArray(clip.source_rounds)
    ? clip.source_rounds.map(Number).filter(Number.isFinite)
    : [];
  const rnd = srcRounds.length > 1
    ? t("montage.factRounds", { rounds: srcRounds.join("·") })
    : clip.round != null && Number.isFinite(Number(clip.round))
      ? t("montage.factRound", { n: clip.round })
      : "";
  const w = weaponUsedTokens(clip.weapon_used, locale)[0] || "";
  const cat = String(clip.category || "").toLowerCase();
  const kind = String(clip.timeline_record_kind || "").trim();
  const wck = String(clip.workbench_clip_kind || clip.recording_request_type || "").trim();
  const victims = Array.isArray(clip.victims) ? clip.victims.map((v) => String(v || "").trim()).filter(Boolean) : [];
  const kc = Number(clip.kill_count);
  let action = "";
  const qsl = String(clip.queue_summary_line || "").trim();
  if (isTimelineSourceClip(clip) && qsl) {
    action = qsl;
  } else if (cat === "fail" || kind === "death" || wck === "timeline_death") {
    const killer = String(clip.killer_name || "").trim();
    action = killer ? t("montage.combatKilledBy", { killer }) : t("montage.combatDeath");
  } else if (victims.length) {
    const kPart = Number.isFinite(kc) && kc > 0 ? t("montage.killCountPrefix", { kc }) : "";
    action = `${kPart}${victims.join("、")}`;
  } else if (Number.isFinite(kc) && kc > 0) {
    action = t("montage.killCount", { kc });
  }
  const parts = [demo, rnd, action, w].filter(Boolean);
  return parts.join(" · ");
}

export function getMontageTimelineVariant(clip) {
  if (!clip || typeof clip !== "object") return "neutral";
  if (isTimelineSourceClip(clip)) {
    const kind = String(clip.timeline_record_kind || "").trim();
    const wck = String(clip.workbench_clip_kind || clip.recording_request_type || "").trim();
    if (kind === "death" || wck === "timeline_death") return "fail";
    if (kind === "round" || wck === "timeline_round") return "compilation";
    if (kind === "kill" || wck === "timeline_kill") return "highlight";
    return "timeline";
  }
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

/** 编排/素材池徽标文案（时间线片段保留「时间线击杀/死亡/整回合」标识） */
export function getMontageBlockShortLabel(clip) {
  if (!clip || typeof clip !== "object") return "高光";
  if (isTimelineSourceClip(clip)) {
    return normalizeClipType(clip);
  }
  const cat = String(clip.category || "").toLowerCase();
  if (cat === "compilation") return "合集";
  if (cat === "fail" || cat === "meme_death") return "下饭";
  return "高光";
}

/**
 * Maps the stable label returned by `getMontageBlockShortLabel` to an i18n key.
 * Use in components: `t(blockShortLabelI18nKey(getMontageBlockShortLabel(clip)))`.
 * @param {string} label — one of getMontageBlockShortLabel's return values
 * @returns {string} — montage.clipType* i18n key
 */
export function blockShortLabelI18nKey(label) {
  return clipTypeI18nKey(label);
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

/**
 * 时间线死亡/下饭等：主段跟拍目标玩家（UI 仍标「玩家视角」），落库的 victim 段是主视角而非追加 POV。
 * 仅用于隐藏合辑里重复的「受害者视角 ×N」徽标。
 */
export function isPrimaryClipVictimPerspective(clip) {
  if (!clip || typeof clip !== "object") return false;
  const wck = String(clip.workbench_clip_kind || clip.recording_request_type || "").trim();
  if (wck === "timeline_death" || wck === "fail") return true;
  if (isTimelineSourceClip(clip) && String(clip.timeline_record_kind || "").trim() === "death") return true;
  const tag = normalizeClipType(clip);
  if (tag === "时间线死亡" || tag === "下饭") return true;
  const planned = Array.isArray(clip.planned_segments) ? clip.planned_segments : [];
  if (planned.length === 1) {
    const p = String(planned[0]?.perspective || "").toLowerCase();
    if (p === "victim") return true;
  }
  return false;
}

/** 合辑 UI：仅统计追加的受害者 POV 段（高光等），不含死亡/下饭主视角 */
export function getMontageExtraVictimPovCount(clip) {
  if (isPrimaryClipVictimPerspective(clip)) return 0;
  const segs = Array.isArray(clip?.victim_pov_segments) ? clip.victim_pov_segments : [];
  return segs.filter((s) => String(s?.perspective_type || "").toLowerCase() === "victim").length;
}

/**
 * 受害者/击杀者 POV 段 tooltip：逐段玩家名
 * @param {Record<string, unknown>} clip
 * @param {Function} t — translation function from useT()
 */
export function getVictimPovSegmentsTooltip(clip, t) {
  const segs = Array.isArray(clip?.victim_pov_segments) ? clip.victim_pov_segments : [];
  if (segs.length === 0) return "";
  return segs
    .map((s) => {
      const n = String(s?.player_name || "").trim();
      if (!n) return "";
      const perspType = String(s?.perspective_type || "").toLowerCase();
      if (perspType === "victim") return t("montage.tooltipVictim", { name: n });
      if (perspType === "killer") return t("montage.tooltipKiller", { name: n });
      return n;
    })
    .filter(Boolean)
    .join("、");
}

/**
 * 入库录像卡片：回放视角翻译文案；优先落库字段 recording_perspective + victim_pov_segments
 * @param {Record<string, unknown>} clip
 * @param {Function} t — translation function from useT()
 */
export function getRecordedClipPerspectiveZh(clip, t) {
  if (!clip || typeof clip !== "object") return t("montage.perspectiveSpectator");
  const rp = String(clip.recording_perspective || "").trim();
  const fromEnum = {
    pov_hud: t("montage.perspectivePovHud"),
    player_follow: t("montage.perspectivePlayerFollow"),
    spectator: t("montage.perspectiveSpectator"),
  }[rp];

  const extraVictim = getMontageExtraVictimPovCount(clip);
  const victimSuffix = extraVictim > 0 ? t("montage.perspectiveVictimSuffix", { n: extraVictim }) : "";

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
  if (isPrimaryClipVictimPerspective(clip)) legacy = pn ? t("montage.perspectivePlayerFollow") : t("montage.perspectiveSpectator");
  else if (matchesVictim && matchesKiller) legacy = t("montage.perspectiveVictimAndKiller");
  else if (matchesVictim) legacy = t("montage.perspectiveVictim");
  else if (matchesKiller) legacy = t("montage.perspectiveKiller");
  else if (Array.isArray(clip.planned_segments) && clip.planned_segments.length > 1) legacy = t("montage.perspectiveWithVictim");
  else if (Array.isArray(clip.record_segments) && clip.record_segments.length > 1) legacy = t("montage.perspectiveWithVictim");
  else if ((cat === "highlight" || cat === "compilation") && hasVictimNames) legacy = t("montage.perspectiveWithVictim");
  else if (pn) legacy = t("montage.perspectivePlayerFollow");
  else legacy = t("montage.perspectiveSpectator");

  return victimSuffix ? `${legacy} · ${victimSuffix}` : legacy;
}

/**
 * 不含「含 N 段受害者视角」后缀，便于与独立受害者 chip 并排展示
 * @param {Record<string, unknown>} clip
 * @param {Function} t — translation function from useT()
 */
export function getRecordedClipPerspectivePrimaryZh(clip, t) {
  const full = getRecordedClipPerspectiveZh(clip, t);
  // Strip the victim-suffix that starts with " · " followed by translated suffix content.
  // Since victimSuffix comes from t("montage.perspectiveVictimSuffix"), we split on " · " and
  // check if the trailing part looks like a suffix (contains a digit indicating count).
  const sepIdx = full.lastIndexOf(" · ");
  if (sepIdx >= 0) {
    const suffix = full.slice(sepIdx + 3);
    // If the suffix looks like a victim-count label (contains digit), strip it.
    if (/\d/.test(suffix)) return full.slice(0, sepIdx).trim();
  }
  return full;
}

export function buildDefaultExportName(themeId) {
  const now = new Date();
  const date = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}-${String(now.getDate()).padStart(2, "0")}`;

  // Use stable ASCII export tokens — filenames must not change with locale.
  const th = MONTAGE_THEMES.find((x) => x.id === themeId);
  const token = th ? th.exportToken : "Montage";

  return `CS2-${token}-${date}`;
}

/**
 * Build share/copy text for a completed montage export.
 * @param {{ themeId, clipCount, durationText, outputPath, t }} params
 */
export function buildShareText({ themeId, clipCount, durationText, outputPath, t }) {
  const themeKeyMap = {
    highlight: "montage.shareHighlight",
    funny_death: "montage.shareFunnyDeath",
    contrast: "montage.shareContrast",
    custom: "montage.shareCustom",
  };

  const titleKey = themeKeyMap[themeId] || themeKeyMap.custom;
  const title = t(titleKey);
  const n = Number(clipCount) || 0;
  const dur = durationText || t("montage.durationUnknown");
  const path = outputPath || "";
  return t("montage.shareBody", { title, n, dur, path });
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
  if (filterKey === "合集") return t === "合集" || t === "击杀合集" || t === "死亡合集" || t === "回合合集";
  if (filterKey === "击杀") return t === "击杀";
  if (filterKey === "普通片段") return t === "普通片段";
  if (filterKey === "时间线") return t === "时间线" || t === "时间线击杀" || t === "时间线死亡" || t === "时间线整回合";
  return true;
}

/**
 * Derive a deduplicated player list from ordered montage clips.
 * Returns one entry per unique identity key, with the most recent
 * player_name used for display.
 *
 * Identity key rules (mirroring the backend):
 *   - Has steamid  → player_key = "sid:<steamid64>"
 *   - No steamid   → player_key = "name:<normalised_name>"
 *     where normalised = name.toLowerCase() with all whitespace removed
 *
 * @param {Array} clips — ordered montage clips (from orderedClips)
 * @returns {Array<{player_key, steamid64, display_name, segment_count, no_steamid}>}
 */
export function derivePlayerAssetsFromClips(clips) {
  if (!Array.isArray(clips) || clips.length === 0) return [];

  // Map: player_key → { player_key, steamid64, display_name, segment_count, no_steamid }
  const map = new Map();

  for (const clip of clips) {
    const sid =
      String(clip?.target_steamid64 || clip?.target_steam_id || clip?.steamid || "").trim();
    const name = String(clip?.player_name || "").trim();
    const normName = name.toLowerCase().replace(/\s+/g, "");

    let player_key, steamid64, no_steamid;
    if (sid && sid !== "0") {
      player_key = `sid:${sid}`;
      steamid64 = sid;
      no_steamid = false;
    } else {
      player_key = normName ? `name:${normName}` : null;
      steamid64 = null;
      no_steamid = true;
    }

    if (!player_key) continue;

    if (map.has(player_key)) {
      const existing = map.get(player_key);
      existing.segment_count += 1;
      // Use the most recent name (later clip wins)
      if (name) existing.display_name = name;
    } else {
      map.set(player_key, {
        player_key,
        steamid64,
        display_name: name || player_key,
        segment_count: 1,
        no_steamid,
      });
    }
  }

  return [...map.values()];
}
