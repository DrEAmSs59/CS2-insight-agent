/**
 * 击杀轴：把成片素材自带的击杀时间点映射到时间轴坐标。
 *
 * 录制侧把每次击杀换算成成片文件内的秒数写进 `recorded_clips.clip_meta.kill_markers`，
 * 该字段随 API 行一路铺进 `clip.meta`（见 timelineUtils.buildRecordedClip）。这里只做
 * 「源时间 → 时间轴时间」的映射，因此裁剪、移动、变速、倒放都会自动跟随片段，不需要
 * 在编辑时改写任何标记数据。
 */

import {
  clipFreezeFrameSec,
  clipMediaTimelineDuration,
  clipReversePlayback,
  clipTimelineTimeForSource,
  clipTrimmedSourceDuration,
} from "./timelineUtils.js";

export const KILL_AXIS_TONES = {
  kill: { fill: "#f97316", ring: "rgba(249,115,22,0.45)" },
  death: { fill: "#f43f5e", ring: "rgba(244,63,94,0.45)" },
};

/**
 * 单次击杀的展示文案：受害者 / 武器 / 多杀序号等，按可用信息拼接。
 *
 * 拼接顺序与词条无关，所以翻译函数由调用方传入（组件用 useT()），本模块保持纯函数。
 */
export function killMarkerLabel(marker, t) {
  if (!marker) return "";
  const parts = [];
  if (marker.perspective === "victim") parts.push(t("liteCut.killAxis.victimView"));
  else parts.push(t(marker.kind === "death" ? "liteCut.killAxis.death" : "liteCut.killAxis.kill"));
  if (marker.round != null) parts.push(t("liteCut.killAxis.round", { round: marker.round }));
  if (marker.victim) parts.push(marker.victim);
  if (marker.weapon) parts.push(marker.weapon);
  if (marker.headshot) parts.push(t("liteCut.killAxis.headshot"));
  if (marker.killIndex >= 2) parts.push(t("liteCut.killAxis.multiKill", { count: marker.killIndex }));
  return parts.join(" · ");
}

function normalizeMarker(raw) {
  if (!raw || typeof raw !== "object") return null;
  const videoSec = Number(raw.video_sec);
  if (!Number.isFinite(videoSec) || videoSec < 0) return null;
  const kind = raw.kind === "death" ? "death" : "kill";
  const killIndex = Number(raw.kill_index);
  return {
    videoSec,
    kind,
    perspective: String(raw.perspective || ""),
    tick: Number.isFinite(Number(raw.tick)) ? Number(raw.tick) : null,
    round: Number.isFinite(Number(raw.round)) ? Number(raw.round) : null,
    victim: String(raw.victim || ""),
    weapon: String(raw.weapon || ""),
    headshot: Boolean(raw.headshot),
    killIndex: Number.isFinite(killIndex) ? killIndex : 0,
    icons: Array.isArray(raw.icons) ? raw.icons.map(String) : [],
    banner: raw.banner ? String(raw.banner) : "",
    tags: Array.isArray(raw.tags) ? raw.tags.map(String) : [],
  };
}

/** 读取片段自带的击杀点（成片文件内的秒数，未经裁剪映射）。 */
export function readClipKillMarkers(clip) {
  const raw = clip?.meta?.kill_markers;
  if (!Array.isArray(raw)) return [];
  return raw.map(normalizeMarker).filter(Boolean).sort((a, b) => a.videoSec - b.videoSec);
}

/** 该片段是否携带击杀数据（用于决定是否显示击杀轴轨道）。 */
export function clipHasKillMarkers(clip) {
  return readClipKillMarkers(clip).length > 0;
}

/**
 * 把一个击杀点映射到时间轴绝对秒数；落在裁剪范围外时返回 null。
 *
 * 变速（含变速关键帧）交给 clipTimelineTimeForSource 积分；倒放则先把源位置镜像到
 * 等效的正向位置，与预览取帧逻辑保持一致。
 */
export function killMarkerTimelineSec(clip, videoSec) {
  if (!clip) return null;
  const source = Number(videoSec);
  if (!Number.isFinite(source)) return null;
  const trimIn = Math.max(0, Number(clip.trim_in) || 0);
  const trimmed = clipTrimmedSourceDuration(clip);
  const trimOut = trimIn + trimmed;
  if (source < trimIn - 1e-4 || source > trimOut + 1e-4) return null;
  const forwardSource = clipReversePlayback(clip) ? trimOut - (source - trimIn) : source;
  const local = clipTimelineTimeForSource(clip, forwardSource);
  return Math.max(0, Number(clip.timeline_start) || 0) + local;
}

/**
 * 汇总整个项目的击杀轴条目，按时间轴时间升序。
 *
 * 只看视频轨（音频轨复用同一素材时不重复标注），并跳过隐藏轨道。
 */
export function collectKillAxisItems(body) {
  const out = [];
  for (const track of body?.tracks || []) {
    if (track?.type !== "video" || track?.hidden) continue;
    for (const clip of track.clips || []) {
      for (const marker of readClipKillMarkers(clip)) {
        const timelineSec = killMarkerTimelineSec(clip, marker.videoSec);
        if (timelineSec == null) continue;
        out.push({
          id: `${clip.id}:${marker.tick ?? marker.videoSec}:${marker.perspective || marker.kind}`,
          timelineSec,
          clipId: String(clip.id),
          trackId: String(track.id),
          marker,
        });
      }
    }
  }
  return out.sort((a, b) => a.timelineSec - b.timelineSec);
}

/** 击杀轴上是否存在任何可显示的条目。 */
export function hasKillAxisItems(body) {
  return collectKillAxisItems(body).length > 0;
}

/**
 * 密集击杀错层：像素间距不足时下移一层，避免图标互相压住。
 * 返回的每项附带 `level`（0 起）。
 */
export function assignKillAxisLevels(items, pixelsPerSecond, minGapPx = 16) {
  const lastPxByLevel = [];
  return (items || []).map((item) => {
    const pixel = item.timelineSec * (Number(pixelsPerSecond) || 0);
    let level = lastPxByLevel.findIndex((last) => pixel - last >= minGapPx);
    if (level < 0) level = lastPxByLevel.length;
    lastPxByLevel[level] = pixel;
    return { ...item, level };
  });
}

/** 片段末尾的定格帧不属于素材本身，用于判断击杀轴需要覆盖的可视长度。 */
export function clipKillAxisSpan(clip) {
  const start = Math.max(0, Number(clip?.timeline_start) || 0);
  return {
    start,
    end: start + clipMediaTimelineDuration(clip) + clipFreezeFrameSec(clip),
  };
}
