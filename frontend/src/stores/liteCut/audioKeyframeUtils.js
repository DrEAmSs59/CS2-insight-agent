function number(value, fallback = 0) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function timelineDuration(clip) {
  if (number(clip?.duration, 0) > 0) return number(clip.duration);
  const trimIn = Math.max(0, number(clip?.trim_in));
  const trimOut = number(clip?.trim_out, NaN);
  const sourceDuration = Number.isFinite(trimOut)
    ? Math.max(0.1, trimOut - trimIn)
    : Math.max(0.1, number(clip?.meta?.duration_sec, 5) - trimIn);
  const speed = Math.max(0.25, Math.min(4, number(clip?.speed, 1)));
  return Math.max(0.1, sourceDuration / speed);
}

export function normalizedAudioVolume(value, fallback = 1) {
  return Math.max(0, Math.min(5, number(value, fallback)));
}

export function normalizedAudioKeyframes(clip, duration = timelineDuration(clip)) {
  const boundedDuration = Math.max(0, number(duration));
  return (clip?.audio_keyframes || [])
    .map((keyframe) => ({
      time_sec: Math.max(0, Math.min(boundedDuration, number(keyframe?.time_sec))),
      volume: normalizedAudioVolume(keyframe?.volume, normalizedAudioVolume(clip?.volume)),
    }))
    .sort((a, b) => a.time_sec - b.time_sec);
}

export function audioKeyframeNearPlayhead(clip, playheadSec, toleranceSec = 0.04, duration = timelineDuration(clip)) {
  const local = number(playheadSec) - number(clip?.timeline_start);
  return normalizedAudioKeyframes(clip, duration).find((keyframe) => Math.abs(keyframe.time_sec - local) <= toleranceSec) || null;
}

export function clipVolumeAt(clip, playheadSec, duration = timelineDuration(clip)) {
  const base = normalizedAudioVolume(clip?.volume);
  const local = Math.max(0, Math.min(Math.max(0, number(duration)), number(playheadSec) - number(clip?.timeline_start)));
  return clipVolumeAtLocal(clip, local, duration, base);
}

export function clipVolumeAtLocal(clip, localTime, duration = timelineDuration(clip), fallback = normalizedAudioVolume(clip?.volume)) {
  const base = normalizedAudioVolume(fallback);
  const local = Math.max(0, Math.min(Math.max(0, number(duration)), number(localTime)));
  const keyframes = normalizedAudioKeyframes(clip, duration);
  if (!keyframes.length || local <= keyframes[0].time_sec) return keyframes[0]?.volume ?? base;
  const last = keyframes.at(-1);
  if (local >= last.time_sec) return last.volume;
  const nextIndex = keyframes.findIndex((keyframe) => keyframe.time_sec >= local);
  const after = keyframes[nextIndex];
  const before = keyframes[nextIndex - 1];
  const amount = (local - before.time_sec) / Math.max(0.0001, after.time_sec - before.time_sec);
  return normalizedAudioVolume(before.volume + (after.volume - before.volume) * amount);
}

export function rebaseAudioKeyframes(original, nextClip) {
  if (!Array.isArray(original?.audio_keyframes) || !original.audio_keyframes.length) return nextClip;
  const oldStart = number(original.timeline_start);
  const oldDuration = timelineDuration(original);
  const nextStart = number(nextClip.timeline_start);
  const nextDuration = timelineDuration(nextClip);
  const oldEnd = oldStart + oldDuration;
  const nextEnd = nextStart + nextDuration;
  const source = { ...original, duration: oldDuration };
  const keyframes = [0, nextDuration];
  for (const keyframe of normalizedAudioKeyframes(source, oldDuration)) {
    const absolute = oldStart + keyframe.time_sec;
    if (absolute > nextStart + 0.0001 && absolute < nextEnd - 0.0001) keyframes.push(absolute - nextStart);
  }
  const bounded = keyframes
    .filter((time) => nextStart + time >= oldStart - 0.0001 && nextStart + time <= oldEnd + 0.0001)
    .sort((a, b) => a - b)
    .filter((time, index, values) => index === 0 || Math.abs(time - values[index - 1]) > 0.0001)
    .map((time_sec) => ({ time_sec, volume: clipVolumeAt(source, nextStart + time_sec, oldDuration) }));
  return { ...nextClip, audio_keyframes: bounded };
}
