import {
  resolveAudioPreviewItems,
  resolveAudioPreviewPreloadItems,
  resolveBaseVideoTrackId,
  resolveIncomingTransitionPlayback,
  resolveOutgoingTransitionPreload,
  resolveTopVideoPlaybackAt,
  resolveVideoUnderlayPlaybackAt,
  resolveVideoUnderlayPlaybacksAt,
} from "./playbackUtils.js";
import { getTrack, overlaysActiveAt } from "./timelineUtils.js";

function resolveBackgroundTransition(body, playback) {
  if (!playback?.clip || !playback?.trackId) return null;
  const clips = [...(getTrack(body, playback.trackId)?.clips || [])]
    .sort((a, b) => (Number(a.timeline_start) || 0) - (Number(b.timeline_start) || 0));
  const index = clips.findIndex((clip) => clip.id === playback.clip.id);
  const localTime = Math.max(0, Number(playback.localTime) || 0);
  const clipDuration = Math.max(0, (Number(playback.clipEnd) || 0) - (Number(playback.clipStart) || 0));
  if (index === 0) {
    const transition = playback.clip.transition_in;
    const duration = Math.max(0, Math.min(1.5, Number(transition?.duration_sec) || 0));
    if (transition?.type && transition.type !== "cut" && duration >= 0.02 && localTime < duration) {
      return {
        type: transition.type,
        phase: "in",
        duration,
        startLocalTime: 0,
        progress: Math.max(0, Math.min(1, localTime / duration)),
      };
    }
  }
  if (index === clips.length - 1) {
    const transition = playback.clip.transition_out;
    const duration = Math.max(0, Math.min(1.5, Number(transition?.duration_sec) || 0));
    const startLocalTime = clipDuration - duration;
    if (transition?.type && transition.type !== "cut" && duration >= 0.02 && localTime >= startLocalTime) {
      return {
        type: transition.type,
        phase: "out",
        duration,
        startLocalTime,
        progress: Math.max(0, Math.min(1, 1 - ((localTime - startLocalTime) / duration))),
      };
    }
  }
  return null;
}

/**
 * Pure projection of project state + timeline time into preview semantics.
 * DOM media ownership, URL resolution and decoder synchronization remain in
 * the preview adapter; timing and layer decisions live here.
 */
export function buildPreviewScene(
  body,
  timelineSec,
  { masterVolume = 1, audioPreloadLeadSec = 1.5, transitionPreloadLeadSec = 2 } = {},
) {
  const time = Math.max(0, Number(timelineSec) || 0);
  const top = resolveTopVideoPlaybackAt(body, time);
  const activeAudio = resolveAudioPreviewItems(body, time, masterVolume);
  const activeAudioKeys = new Set(activeAudio.map((item) => `${item.trackId}:${item.id}`));
  const audioPreload = resolveAudioPreviewPreloadItems(body, time, masterVolume, audioPreloadLeadSec)
    .filter((item) => !activeAudioKeys.has(`${item.trackId}:${item.id}`));
  return {
    timelineSec: time,
    top,
    baseVideoTrackId: resolveBaseVideoTrackId(body),
    underlay: resolveVideoUnderlayPlaybackAt(body, time, top),
    underlays: resolveVideoUnderlayPlaybacksAt(body, time, top),
    overlays: overlaysActiveAt(body, time),
    incomingTransition: resolveIncomingTransitionPlayback(body, top),
    outgoingTransitionPreload: resolveOutgoingTransitionPreload(body, top, transitionPreloadLeadSec),
    backgroundTransition: resolveBackgroundTransition(body, top),
    audio: activeAudio,
    audioPreload,
  };
}
