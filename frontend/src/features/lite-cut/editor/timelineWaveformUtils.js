import { clipReversePlayback, clipSourceTimeForTimeline, clipTrimmedSourceDuration } from "../state/timelineUtils.js";
import { waveformBarCountForWidth } from "../state/audioWaveformUtils.js";

export const TIMELINE_WAVEFORM_TILE_WIDTH_PX = 768;
export const TIMELINE_WAVEFORM_MAX_TILES = 24;

function finiteVisibleEnd(range, start, pixelsPerSecond, tileWidthPx) {
  const end = Number(range?.end);
  if (Number.isFinite(end)) return end;
  return start + (tileWidthPx * 3) / pixelsPerSecond;
}

function sourceTimeAtLocalTimeline(clip, localTimelineSec) {
  const forward = clipSourceTimeForTimeline(clip, localTimelineSec);
  if (!clipReversePlayback(clip)) return forward;
  const trimIn = Math.max(0, Number(clip?.trim_in) || 0);
  const trimOut = trimIn + clipTrimmedSourceDuration(clip);
  return trimOut - (forward - trimIn);
}

export function timelineWaveformTiles({
  clip,
  clipStart = 0,
  clipDuration = 0,
  pixelsPerSecond = 1,
  visibleRange = { start: 0, end: Number.POSITIVE_INFINITY },
  tileWidthPx = TIMELINE_WAVEFORM_TILE_WIDTH_PX,
} = {}) {
  if (!clip) return [];
  const start = Math.max(0, Number(clipStart) || 0);
  const duration = Math.max(0.001, Number(clipDuration) || 0.001);
  const end = start + duration;
  const pps = Math.max(0.001, Number(pixelsPerSecond) || 1);
  const tileWidth = Math.max(128, Number(tileWidthPx) || TIMELINE_WAVEFORM_TILE_WIDTH_PX);
  const visibleStart = Math.max(start, Math.min(end, Number(visibleRange?.start) || 0));
  const visibleEnd = Math.max(visibleStart, Math.min(end, finiteVisibleEnd(visibleRange, visibleStart, pps, tileWidth)));
  if (visibleEnd <= visibleStart + 0.000001) return [];

  const clipPixelWidth = duration * pps;
  const firstTile = Math.max(0, Math.floor(((visibleStart - start) * pps) / tileWidth));
  const finalTile = Math.max(firstTile, Math.floor(Math.max(0, ((visibleEnd - start) * pps) - 0.001) / tileWidth));
  const tiles = [];
  for (let tileIndex = firstTile; tileIndex <= finalTile && tiles.length < TIMELINE_WAVEFORM_MAX_TILES; tileIndex += 1) {
    const leftPx = tileIndex * tileWidth;
    const widthPx = Math.max(1, Math.min(tileWidth, clipPixelWidth - leftPx));
    if (widthPx <= 0) continue;
    const localStart = leftPx / pps;
    const localEnd = Math.min(duration, (leftPx + widthPx) / pps);
    const bars = waveformBarCountForWidth(widthPx);
    const sourceTimes = Array.from({ length: bars }, (_unused, index) => (
      sourceTimeAtLocalTimeline(clip, localStart + ((index + 0.5) / bars) * (localEnd - localStart))
    ));
    const sourceStartSec = Math.min(...sourceTimes);
    const sourceEndSec = Math.max(...sourceTimes);
    const sourcePadding = Math.max(0.001, (sourceEndSec - sourceStartSec) / Math.max(1, bars));
    tiles.push({
      key: `${tileIndex}:${pps.toFixed(4)}`,
      tileIndex,
      leftPx,
      widthPx,
      bars,
      sourceStartSec: Math.max(0, sourceStartSec - sourcePadding / 2),
      sourceEndSec: sourceEndSec + sourcePadding / 2,
      sourceTimes,
    });
  }
  return tiles;
}
