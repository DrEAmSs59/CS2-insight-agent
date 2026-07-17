export const SPEED_RAMP_PRESETS = [
  { id: "slow-fast", label: "先慢后快", points: [[0, 0.5], [0.55, 2], [1, 2]] },
  { id: "fast-slow", label: "先快后慢", points: [[0, 2], [0.45, 0.5], [1, 0.5]] },
  { id: "impact", label: "冲击慢放", points: [[0, 1], [0.42, 0.35], [0.68, 1.5], [1, 1.5]] },
];

export function speedRampPointsForPreset(presetId, trimIn, sourceDuration) {
  const preset = SPEED_RAMP_PRESETS.find((item) => item.id === presetId);
  const start = Math.max(0, Number(trimIn) || 0);
  const duration = Math.max(0, Number(sourceDuration) || 0);
  if (!preset || duration <= 0) return [];
  return preset.points.map(([ratio, speed]) => ({
    source_sec: Number((start + duration * ratio).toFixed(6)),
    speed,
  }));
}

export function matchingSpeedRampPresetId(points, trimIn, sourceDuration) {
  const sorted = [...(points || [])].sort((a, b) => (Number(a?.source_sec) || 0) - (Number(b?.source_sec) || 0));
  for (const preset of SPEED_RAMP_PRESETS) {
    const expected = speedRampPointsForPreset(preset.id, trimIn, sourceDuration);
    if (expected.length !== sorted.length) continue;
    const matches = expected.every((point, index) => (
      Math.abs(point.source_sec - Number(sorted[index]?.source_sec)) <= 0.01
      && Math.abs(point.speed - Number(sorted[index]?.speed)) <= 0.01
    ));
    if (matches) return preset.id;
  }
  return null;
}

export function speedRampDisplaySegments(points, trimIn, sourceDuration) {
  const start = Math.max(0, Number(trimIn) || 0);
  const duration = Math.max(0.001, Number(sourceDuration) || 0.001);
  const sorted = [...(points || [])].sort((a, b) => (Number(a?.source_sec) || 0) - (Number(b?.source_sec) || 0));
  return sorted.slice(0, -1).map((point, index) => {
    const from = Math.max(0, Math.min(100, ((Number(point.source_sec) - start) / duration) * 100));
    const to = Math.max(from, Math.min(100, ((Number(sorted[index + 1].source_sec) - start) / duration) * 100));
    return { index, from, to, width: Math.max(0, to - from), speed: Math.max(0.25, Math.min(4, Number(point.speed) || 1)) };
  });
}

export function timelineSpeedRampSegments(clip) {
  const points = Array.isArray(clip?.speed_keyframes) ? clip.speed_keyframes : [];
  if (points.length < 2) return [];
  const totalTimelineDuration = Math.max(0.001, clipTimelineDuration(clip));
  const trimmedSourceDuration = Math.max(0.001, clipTrimmedSourceDuration(clip));
  const trimIn = Math.max(0, Number(clip?.trim_in) || 0);
  let elapsedTimeline = 0;

  return clipSpeedSegments(clip).map((segment, index) => {
    const timelineDuration = (segment.sourceEnd - segment.sourceStart) / segment.speed;
    const left = (elapsedTimeline / totalTimelineDuration) * 100;
    const width = (timelineDuration / totalTimelineDuration) * 100;
    elapsedTimeline += timelineDuration;
    return {
      index,
      left,
      width,
      speed: segment.speed,
      sourceFrom: ((segment.sourceStart - trimIn) / trimmedSourceDuration) * 100,
      sourceTo: ((segment.sourceEnd - trimIn) / trimmedSourceDuration) * 100,
    };
  });
}
import { clipSpeedSegments, clipTimelineDuration, clipTrimmedSourceDuration } from "../../../stores/liteCut/timelineUtils.js";
