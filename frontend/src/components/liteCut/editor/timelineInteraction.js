import { snapTimelineSec } from "../../../stores/liteCut/timelineUtils.js";

/** 与 OpenCut TIMELINE_DRAG_THRESHOLD_PX 对齐 */
export const DRAG_THRESHOLD_PX = 5;

/** 独立轨道头列（72px）与列间 gap（4px），避免与片段区域重叠。 */
export const TIMELINE_LANE_HEADER_W = 76;
export const TIMELINE_CONTENT_PADDING_RIGHT = 8;

const EMPTY_DRAG_IMAGE = (() => {
  if (typeof Image === "undefined") return null;
  const img = new Image();
  img.src = "data:image/gif;base64,R0lGODlhAQABAIAAAAUEBAAAACwAAAAAAQABAAACAkQBADs=";
  return img;
})();

/** 隐藏浏览器默认 drag ghost（OpenCut draggable-item 同款） */
export function hideNativeDragImage(dataTransfer) {
  if (EMPTY_DRAG_IMAGE && dataTransfer?.setDragImage) {
    dataTransfer.setDragImage(EMPTY_DRAG_IMAGE, 0, 0);
  }
}

/** RAF-throttle state updates during pointer drag. */
export function rafThrottle(fn) {
  let raf = null;
  let latest = null;
  return (...args) => {
    latest = args;
    if (raf != null) return;
    raf = requestAnimationFrame(() => {
      raf = null;
      fn(...latest);
    });
  };
}

export function previewSnapSec(sec, body, { enabled, playheadSec }) {
  if (!enabled) return { time: sec, snapped: false };
  const snapped = snapTimelineSec(sec, body, { enabled: true, playheadSec });
  return { time: snapped, snapped: Math.abs(snapped - sec) < 0.001 };
}

export function snapPlayheadToBoundaries(sec, boundaries, pixelsPerSecond, thresholdPx = 9) {
  const raw = Math.max(0, Number(sec) || 0);
  const pps = Math.max(0.001, Number(pixelsPerSecond) || 0);
  const thresholdSec = Math.min(0.5, Math.max(0, Number(thresholdPx) || 0) / pps);
  let nearest = null;
  let nearestDistance = thresholdSec + Number.EPSILON;
  for (const boundary of boundaries || []) {
    const point = Math.max(0, Number(boundary) || 0);
    const distance = Math.abs(point - raw);
    if (distance <= nearestDistance) {
      nearest = point;
      nearestDistance = distance;
    }
  }
  return nearest == null
    ? { time: raw, snapped: false, point: null }
    : { time: nearest, snapped: true, point: nearest };
}

export function timeFromClientX(clientX, rect, totalSec) {
  const ratio = Math.max(0, Math.min(1, (clientX - rect.left) / rect.width));
  return ratio * totalSec;
}

export function timelineLaneWidth(contentWidth) {
  return Math.max(1, contentWidth - TIMELINE_LANE_HEADER_W - TIMELINE_CONTENT_PADDING_RIGHT);
}

function laneMetrics(scrollEl, seekSurfaceEl, contentWidth) {
  if (seekSurfaceEl && scrollEl) {
    const laneWidth = seekSurfaceEl.offsetWidth;
    if (laneWidth > 0) {
      const scrollRect = scrollEl.getBoundingClientRect();
      const seekLeftContent =
        seekSurfaceEl.getBoundingClientRect().left - scrollRect.left + scrollEl.scrollLeft;
      return { laneWidth, seekLeftContent };
    }
  }
  const laneWidth = timelineLaneWidth(contentWidth);
  return { laneWidth, seekLeftContent: TIMELINE_LANE_HEADER_W };
}

function mouseXContent(clientX, scrollEl) {
  const scrollRect = scrollEl.getBoundingClientRect();
  return clientX - scrollRect.left + scrollEl.scrollLeft;
}

/**
 * 将 clientX 转为时间轴时间（秒）。
 * scrollLeft 由底部横条驱动（主区域 overflow-x-hidden 时必传）。
 */
export function mouseTimeFromClientX(
  clientX,
  scrollEl,
  contentWidth,
  totalSec,
  seekSurfaceEl = null,
  scrollLeft = null,
) {
  if (!scrollEl || !contentWidth) return 0;
  const sl = scrollLeft ?? scrollEl.scrollLeft ?? 0;
  if (seekSurfaceEl) {
    const laneWidth = seekSurfaceEl.offsetWidth;
    if (laneWidth > 0) {
      const seekRect = seekSurfaceEl.getBoundingClientRect();
      const mouseInLane = sl + (clientX - seekRect.left);
      const ratio = Math.max(0, Math.min(1, mouseInLane / laneWidth));
      return ratio * totalSec;
    }
  }
  const { laneWidth, seekLeftContent } = laneMetrics(scrollEl, seekSurfaceEl, contentWidth);
  const mouseInLane = clientX - scrollEl.getBoundingClientRect().left + sl - seekLeftContent;
  const ratio = Math.max(0, Math.min(1, mouseInLane / laneWidth));
  return ratio * totalSec;
}

/** 从片段 DOM 计算抓取时间偏移（像素 → 秒，含 scroll） */
export function grabOffsetSecFromPointer(
  pointerClientX,
  clipEl,
  scrollEl,
  contentWidth,
  totalSec,
  seekSurfaceEl = null,
  scrollLeft = null,
) {
  if (!scrollEl || !clipEl || !contentWidth) return 0;
  const sl = scrollLeft ?? scrollEl.scrollLeft ?? 0;
  if (seekSurfaceEl) {
    const laneWidth = seekSurfaceEl.offsetWidth;
    if (laneWidth > 0) {
      const seekRect = seekSurfaceEl.getBoundingClientRect();
      const clipRect = clipEl.getBoundingClientRect();
      const clipLeftInLane = sl + (clipRect.left - seekRect.left);
      const clickInLane = sl + (pointerClientX - seekRect.left);
      return ((clickInLane - clipLeftInLane) / laneWidth) * totalSec;
    }
  }
  const { laneWidth, seekLeftContent } = laneMetrics(scrollEl, seekSurfaceEl, contentWidth);
  const scrollRect = scrollEl.getBoundingClientRect();
  const clipRect = clipEl.getBoundingClientRect();
  const clipLeftContent = clipRect.left - scrollRect.left + sl;
  const clickContent = pointerClientX - scrollRect.left + sl;
  return ((clickContent - clipLeftContent) / laneWidth) * totalSec;
}

/** 根据指针在轨道上的位置 + 按下时的抓取偏移，计算片段起始时间 */
export function clipStartFromPointer(
  clientX,
  scrollEl,
  contentWidth,
  totalSec,
  grabOffsetSec,
  seekSurfaceEl = null,
  scrollLeft = null,
) {
  const pointerSec = mouseTimeFromClientX(
    clientX,
    scrollEl,
    contentWidth,
    totalSec,
    seekSurfaceEl,
    scrollLeft,
  );
  return Math.max(0, pointerSec - grabOffsetSec);
}

export function formatRulerTime(sec) {
  const s = Math.max(0, sec);
  const m = Math.floor(s / 60);
  const r = Math.floor(s % 60);
  return `${String(m).padStart(2, "0")}:${String(r).padStart(2, "0")}`;
}

/** OpenCut 风格：整秒主刻度 + 标签，每秒 4 条短副刻度（200ms） */
export function buildTimelineRulerTicks(totalSec, contentWidth) {
  const total = Math.max(totalSec, 0.001);
  const pps = contentWidth / total;

  let majorStep = 10;
  if (pps >= 52) majorStep = 1;
  else if (pps >= 26) majorStep = 2;
  else if (pps >= 13) majorStep = 5;

  let minorStep = null;
  if (majorStep === 1 && pps >= 52) minorStep = 0.2;
  else if (majorStep <= 2 && pps >= 32) minorStep = 0.5;
  else if (majorStep <= 5 && pps >= 16) minorStep = 1;

  const majorMs = Math.round(majorStep * 1000);
  const isMajorMs = (ms) => ms % majorMs === 0;

  const ticks = [];
  const seen = new Set();

  const push = (t, kind) => {
    const ms = Math.round(Math.min(total, t) * 1000);
    if (seen.has(ms)) return;
    seen.add(ms);
    ticks.push({
      t: ms / 1000,
      kind,
      label: kind === "major" ? formatRulerTime(ms / 1000) : null,
    });
  };

  for (let t = 0; t <= total + 1e-6; t += majorStep) {
    push(t, "major");
  }

  if (minorStep != null) {
    const minorMs = Math.round(minorStep * 1000);
    for (let ms = 0; ms <= Math.round(total * 1000); ms += minorMs) {
      if (isMajorMs(ms)) continue;
      push(ms / 1000, "minor");
    }
  }

  ticks.sort((a, b) => a.t - b.t);
  return ticks;
}

export function pxPerSec(totalSec, zoom) {
  return Math.max(8, 14 * zoom);
}

export function normalizeTimelineZoom(zoom) {
  return Math.max(0.5, Math.min(4, Number(zoom) || 1));
}

export function timelineContentWidth(totalSec, zoom) {
  return Math.max(640, totalSec * pxPerSec(totalSec, normalizeTimelineZoom(zoom)));
}

export function fitTimelineZoom(totalSec, viewportWidth) {
  const sec = Math.max(0, Number(totalSec) || 0);
  const width = Math.max(1, Number(viewportWidth) || 0);
  if (sec <= 0) return 1;
  return normalizeTimelineZoom(Math.max(640, width) / (sec * 14));
}

export function timelineScrollLeftForFocus({
  anchorClientX,
  viewportLeft,
  viewportWidth,
  oldScrollLeft,
  oldContentWidth,
  newContentWidth,
}) {
  const oldLaneWidth = timelineLaneWidth(oldContentWidth);
  const newLaneWidth = timelineLaneWidth(newContentWidth);
  const oldMouseInLane = Math.max(
    0,
    Math.min(oldLaneWidth, (Number(oldScrollLeft) || 0) + (Number(anchorClientX) || 0) - (Number(viewportLeft) || 0) - TIMELINE_LANE_HEADER_W),
  );
  const focusRatio = oldLaneWidth > 0 ? oldMouseInLane / oldLaneWidth : 0;
  const mouseViewportX = (Number(anchorClientX) || 0) - (Number(viewportLeft) || 0) - TIMELINE_LANE_HEADER_W;
  const next = focusRatio * newLaneWidth - mouseViewportX;
  const max = Math.max(0, Number(newContentWidth) - Math.max(1, Number(viewportWidth) || 0));
  return Math.max(0, Math.min(max, next));
}

/** 拖动时靠近边缘自动横向滚动（底部横条） */
export function timelineScrollLeftForTimeRange({
  startSec = 0,
  endSec = startSec,
  totalSec,
  contentWidth,
  viewportWidth,
  paddingPx = 48,
}) {
  const total = Math.max(0.001, Number(totalSec) || 0);
  const width = Math.max(1, Number(contentWidth) || 0);
  const viewport = Math.max(1, Number(viewportWidth) || 0);
  const laneWidth = timelineLaneWidth(width);
  const max = Math.max(0, width - viewport);
  const start = Math.max(0, Math.min(total, Number(startSec) || 0));
  const end = Math.max(start, Math.min(total, Number(endSec) || start));
  const startX = TIMELINE_LANE_HEADER_W + (start / total) * laneWidth;
  const endX = TIMELINE_LANE_HEADER_W + (end / total) * laneWidth;
  const rangeWidth = Math.max(1, endX - startX);
  const safePadding = Math.max(0, Number(paddingPx) || 0);
  const paddedViewport = Math.max(1, viewport - safePadding * 2);
  const next =
    rangeWidth <= paddedViewport
      ? (startX + endX) / 2 - viewport / 2
      : startX - safePadding;
  return Math.max(0, Math.min(max, next));
}

export function timelineRangePercentStyle(startSec, endSec, totalSec) {
  const total = Math.max(0, Number(totalSec) || 0);
  if (total <= 0) return null;
  const start = Math.max(0, Math.min(total, Number(startSec) || 0));
  const end = Math.max(start, Math.min(total, Number(endSec) || start));
  if (end <= start) return null;
  return {
    left: `${(start / total) * 100}%`,
    width: `${((end - start) / total) * 100}%`,
  };
}

export function visibleTimelineRange({ scrollLeft = 0, viewportWidth = 0, pixelsPerSecond = 1, headerWidth = 0, overscanPx = viewportWidth }) {
  if (!(Number(viewportWidth) > 0)) return { start: 0, end: Number.POSITIVE_INFINITY };
  const pps = Math.max(0.001, Number(pixelsPerSecond) || 1);
  const leftPx = Math.max(0, (Number(scrollLeft) || 0) - Math.max(0, Number(headerWidth) || 0));
  const widthPx = Math.max(1, Number(viewportWidth) || 1);
  const padding = Math.max(0, Number(overscanPx) || 0);
  return {
    start: Math.max(0, (leftPx - padding) / pps),
    end: (leftPx + widthPx + padding) / pps,
  };
}

export function timelineClipIntersectsRange(startSec, durationSec, range) {
  const start = Math.max(0, Number(startSec) || 0);
  const end = start + Math.max(0.001, Number(durationSec) || 0);
  return end >= Math.max(0, Number(range?.start) || 0) && start <= Math.max(0, Number(range?.end) || 0);
}

export function autoScrollTimeline(clientX, viewportEl, hBarEl, speed = 14) {
  if (!viewportEl || !hBarEl) return;
  const r = viewportEl.getBoundingClientRect();
  const margin = 56;
  if (clientX < r.left + margin) {
    hBarEl.scrollLeft = Math.max(0, hBarEl.scrollLeft - speed);
  } else if (clientX > r.right - margin) {
    hBarEl.scrollLeft += speed;
  }
}

/** 将 clientY 转为轨道区域相对 Y（相对 lanes 容器顶部） */
export function mouseYInLanes(clientY, lanesEl) {
  if (!lanesEl) return 0;
  const rect = lanesEl.getBoundingClientRect();
  return clientY - rect.top;
}

export function selectedTimelineItemsInMarquee(rows, timeA, timeB, yA, yB) {
  const start = Math.max(0, Math.min(Number(timeA) || 0, Number(timeB) || 0));
  const end = Math.max(start, Math.max(Number(timeA) || 0, Number(timeB) || 0));
  const top = Math.min(Number(yA) || 0, Number(yB) || 0);
  const bottom = Math.max(Number(yA) || 0, Number(yB) || 0);
  if (end - start <= 1e-6 || bottom - top <= 1e-6) return [];

  const out = [];
  for (const row of rows || []) {
    const rowTop = Number(row?.top) || 0;
    const rowBottom = Number(row?.bottom) || rowTop;
    if (rowBottom < top || rowTop > bottom) continue;
    for (const clip of row.clips || []) {
      const clipStart = Math.max(0, Number(clip?.start) || 0);
      const clipEnd = clipStart + Math.max(0, Number(clip?.width) || 0);
      if (clipEnd > start + 1e-6 && clipStart < end - 1e-6) {
        out.push({
          id: clip.id,
          trackId: row.selectionTrackId || row.id,
          start: clipStart,
          end: clipEnd,
        });
      }
    }
  }
  return out.sort((a, b) => a.start - b.start || String(a.id).localeCompare(String(b.id)));
}

/**
 * 文档级 pointer 监听，跨轨道拖动时不会丢事件。
 * @returns {() => void} cleanup
 */
export function attachDocumentPointerDrag(pointerId, { onMove, onEnd }) {
  const move = (ev) => {
    if (ev.pointerId !== pointerId) return;
    onMove(ev);
  };
  const end = (ev) => {
    if (ev.pointerId !== pointerId) return;
    cleanup();
    onEnd(ev);
  };
  const cleanup = () => {
    document.removeEventListener("pointermove", move);
    document.removeEventListener("pointerup", end);
    document.removeEventListener("pointercancel", end);
  };
  document.addEventListener("pointermove", move);
  document.addEventListener("pointerup", end);
  document.addEventListener("pointercancel", end);
  return cleanup;
}

/**
 * OpenCut 风格 pending → dragging：未过阈值算点击，过了阈值算拖动。
 */
export function startPendingDrag(pointerId, origin, { onDragStart, onDragMove, onDragEnd, onClick }) {
  let moved = false;
  return attachDocumentPointerDrag(pointerId, {
    onMove: (ev) => {
      if (!moved) {
        if (Math.hypot(ev.clientX - origin.x, ev.clientY - origin.y) < DRAG_THRESHOLD_PX) return;
        moved = true;
        onDragStart?.(ev);
      }
      onDragMove?.(ev);
    },
    onEnd: () => {
      if (moved) onDragEnd?.();
      else onClick?.();
    },
  });
}
