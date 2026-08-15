import {
  clipLabel,
  audioTracks,
  sortClips,
  trackMainVideoClips,
  videoTracks,
} from "./timelineUtils.js";
import {
  clipFreezeFrameSec,
  clipMediaTimelineDuration,
  clipPreservePitch,
  clipReversePlayback,
  clipSpeedAtTimeline,
  clipSourceDuration,
  clipSourceTimeForTimeline,
  clipTimelineEnd,
  clipTrimmedSourceDuration,
} from "../domain/timelineMath.js";
import { clipVolumeAtLocal } from "./audioKeyframeUtils.js";
import {
  AUDIO_BGM_GAIN,
  AUDIO_CLIP_GAIN,
  AUDIO_DUCKING_GAIN,
  AUDIO_FADE_DURATION,
  AUDIO_MASTER_GAIN,
  AUDIO_TRACK_GAIN,
  clampAudioGain,
} from "../domain/audioContract.js";
import { LITE_CUT_TIMELINE_LIMITS } from "./projectContract.js";
import { VISUAL_SPEED_DEFAULT } from "../domain/visualMaterial.js";
import {
  clipTransitionRef,
  findVisualTransitionNode,
  overlayTransitionRef,
  transitionMarkersForNode,
} from "./transitionModel.js";

function hitClipAtTime(clip, timelineSec) {
  const start = Number(clip.timeline_start) || 0;
  const end = clipTimelineEnd(clip);
  const t = Math.max(0, timelineSec);
  if (t < start || t >= end - 1e-4) return null;
  const local = t - start;
  const trimIn = Number(clip.trim_in) || 0;
  const sourceDur = clipTrimmedSourceDuration(clip);
  const naturalDuration = clipMediaTimelineDuration(clip);
  const frozen = clipFreezeFrameSec(clip) > 0 && local >= naturalDuration - 1e-4;
  const sourceOffset = frozen
    ? Math.max(0, sourceDur - 0.05)
    : Math.max(0, Math.min(sourceDur, clipSourceTimeForTimeline(clip, local) - trimIn));
  return {
    clip,
    sourceTime: clipReversePlayback(clip) ? trimIn + Math.max(0, sourceDur - sourceOffset) : trimIn + sourceOffset,
    localTime: local,
    clipStart: start,
    clipEnd: end,
    frozen,
  };
}

function hitClipAtEnd(clip) {
  const sourceDur = clipTrimmedSourceDuration(clip);
  const timelineDur = clipSourceDuration(clip);
  const trimIn = Number(clip.trim_in) || 0;
  const start = Number(clip.timeline_start) || 0;
  const end = clipTimelineEnd(clip);
  return {
    clip,
    sourceTime: clipReversePlayback(clip) ? trimIn + 0.05 : trimIn + sourceDur - 0.05,
    localTime: timelineDur - 0.05,
    clipStart: start,
    clipEnd: end,
    atEnd: true,
    frozen: clipFreezeFrameSec(clip) > 0,
  };
}

export function resolveTransitionEndpointPlayback(body, ref, timelineSec) {
  const entry = findVisualTransitionNode(body, ref);
  if (!entry || ref?.kind !== "clip") return null;
  const time = Number(timelineSec) || 0;
  if (time < entry.start) {
    const hit = hitClipAtTime(entry.node, entry.start + 0.00001);
    return hit ? { ...hit, trackId: ref.track_id, sourceTime: Number(entry.node.trim_in) || 0, localTime: 0, freezePlayback: true, atStart: true } : null;
  }
  if (time >= entry.end - 0.00001) {
    return { ...hitClipAtEnd(entry.node), trackId: ref.track_id, freezePlayback: true };
  }
  const hit = hitClipAtTime(entry.node, time);
  return hit ? { ...hit, trackId: ref.track_id } : null;
}

/** 自上而下取最上层有内容的视频轨（预览合成） */
export function resolveTopVideoPlaybackAt(body, timelineSec) {
  const tracks = videoTracks(body).filter((track) => !track.hidden);
  const t = Math.max(0, timelineSec);

  for (const track of tracks) {
    for (const clip of sortClips(track.clips)) {
      const hit = hitClipAtTime(clip, t);
      if (hit) return { ...hit, trackId: track.id };
    }
  }
  return null;
}

export function selectedClipPreviewSourceTime(clip, timelineSec) {
  if (!clip) return 0;
  const trimIn = Math.max(0, Number(clip.trim_in) || 0);
  const sourceDuration = clipTrimmedSourceDuration(clip);
  const clipStart = Math.max(0, Number(clip.timeline_start) || 0);
  const clipEnd = clipTimelineEnd(clip);
  const playhead = Math.max(0, Number(timelineSec) || 0);
  const playheadInsideClip = playhead >= clipStart && playhead < clipEnd - 1e-4;
  const localTime = playheadInsideClip ? playhead - clipStart : 0;
  const naturalDuration = clipMediaTimelineDuration(clip);
  const frozen = clipFreezeFrameSec(clip) > 0 && localTime >= naturalDuration - 1e-4;
  const sourceOffset = frozen
    ? Math.max(0, sourceDuration - 0.05)
    : Math.max(0, Math.min(sourceDuration, clipSourceTimeForTimeline(clip, localTime) - trimIn));
  return clipReversePlayback(clip)
    ? trimIn + Math.max(0, sourceDuration - sourceOffset)
    : trimIn + sourceOffset;
}

/** 与导出器一致：列表最下方的可见视频轨是画布底层。 */
export function resolveBaseVideoTrackId(body) {
  for (const track of [...videoTracks(body)].reverse()) {
    if (track.hidden) continue;
    if (trackMainVideoClips(track).length > 0) return track.id;
  }
  return null;
}

export function resolveVideoUnderlayPlaybackAt(body, timelineSec, topPlayback) {
  if (!topPlayback?.trackId) return null;
  const tracks = videoTracks(body).filter((track) => !track.hidden);
  const topIndex = tracks.findIndex((track) => track.id === topPlayback.trackId);
  if (topIndex < 0 || topIndex >= tracks.length - 1) return null;
  const t = Math.max(0, timelineSec);
  for (let i = topIndex + 1; i < tracks.length; i += 1) {
    const track = tracks[i];
    for (const clip of sortClips(track.clips)) {
      const hit = hitClipAtTime(clip, t);
      if (hit) return { ...hit, trackId: track.id };
    }
  }
  return null;
}

/** Resolve every visible video layer below the current top layer, bottom to top. */
export function resolveVideoUnderlayPlaybacksAt(body, timelineSec, topPlayback) {
  if (!topPlayback?.trackId) return [];
  const tracks = videoTracks(body).filter((track) => !track.hidden);
  const topIndex = tracks.findIndex((track) => track.id === topPlayback.trackId);
  if (topIndex < 0 || topIndex >= tracks.length - 1) return [];
  const t = Math.max(0, timelineSec);
  const layers = [];
  for (let i = tracks.length - 1; i > topIndex; i -= 1) {
    const track = tracks[i];
    for (const clip of sortClips(track.clips)) {
      const hit = hitClipAtTime(clip, t);
      if (hit) {
        layers.push({ ...hit, trackId: track.id });
        break;
      }
    }
  }
  return layers;
}

export function nextTopVideoPlaybackAfter(body, currentPlayback) {
  if (!currentPlayback?.clip) return null;
  const clipEnd = Number(currentPlayback.clipEnd) || 0;
  const afterCurrent = resolveTopVideoPlaybackAt(body, clipEnd + 0.02);
  if (afterCurrent && afterCurrent.clip?.id !== currentPlayback.clip.id) {
    return { ...afterCurrent, resumeTimelineSec: clipEnd };
  }

  const futureStarts = videoTracks(body)
    .filter((track) => !track.hidden)
    .flatMap((track) => (track.clips || []).map((clip) => Number(clip.timeline_start) || 0))
    .filter((start) => start > clipEnd + 1e-4)
    .sort((a, b) => a - b);
  for (const nextStart of futureStarts) {
    const nextPlayback = resolveTopVideoPlaybackAt(body, nextStart);
    if (nextPlayback && nextPlayback.clip?.id !== currentPlayback.clip.id) {
      // Resume at the current clip end so the sequence clock traverses an
      // intentional blank gap, including when the next clip is on another track.
      return { ...nextPlayback, resumeTimelineSec: clipEnd };
    }
  }
  return null;
}

export function previewAudioState({
  clip = null,
  masterVolume = AUDIO_MASTER_GAIN.default,
  forceMuted = false,
  trackVolume = AUDIO_TRACK_GAIN.default,
  localTime = 0,
  visibleDuration = null,
} = {}) {
  if (forceMuted || clip?.muted) return { muted: true, volume: 0 };
  const rawClipVolume = Number(clip?.volume);
  const rawMasterVolume = Number(masterVolume);
  const rawTrackVolume = Number(trackVolume);
  const clipVolume = clipVolumeAtLocal(clip, localTime, visibleDuration ?? undefined, Number.isFinite(rawClipVolume) ? rawClipVolume : AUDIO_CLIP_GAIN.default);
  const projectVolume = Number.isFinite(rawMasterVolume) ? rawMasterVolume : AUDIO_MASTER_GAIN.default;
  const normalizedTrackVolume = clampAudioGain(rawTrackVolume, AUDIO_TRACK_GAIN);
  const fadeIn = Math.max(AUDIO_FADE_DURATION.min, Number(clip?.fade_in_sec) || AUDIO_FADE_DURATION.default);
  const fadeOut = Math.max(AUDIO_FADE_DURATION.min, Number(clip?.fade_out_sec) || AUDIO_FADE_DURATION.default);
  const local = Math.max(0, Number(localTime) || 0);
  const duration = Number.isFinite(Number(visibleDuration)) ? Math.max(0, Number(visibleDuration)) : clip ? clipSourceDuration(clip) : 0;
  const fadeInFactor = fadeIn > 0 ? Math.min(1, local / fadeIn) : 1;
  const fadeOutFactor = fadeOut > 0 && duration > 0 ? Math.min(1, Math.max(0, (duration - local) / fadeOut)) : 1;
  const volume = Math.max(0, clipVolume * normalizedTrackVolume * clampAudioGain(projectVolume, AUDIO_MASTER_GAIN) * fadeInFactor * fadeOutFactor);
  return { muted: volume <= 0, volume };
}

export function projectBgmPreviewClip(body) {
  const bgm = body?.audio?.bgm && typeof body.audio.bgm === "object" ? body.audio.bgm : null;
  if (!bgm?.path || bgm.asset_id == null) return null;
  const duration = Number(bgm.duration_sec);
  const clip = {
    id: "project-bgm",
    source_type: "file",
    file_path: bgm.path,
    timeline_start: Math.max(LITE_CUT_TIMELINE_LIMITS.time.min, Number(bgm.start_sec) || LITE_CUT_TIMELINE_LIMITS.time.default),
    trim_in: LITE_CUT_TIMELINE_LIMITS.time.default,
    volume: Number.isFinite(Number(bgm.volume)) ? Number(bgm.volume) : AUDIO_BGM_GAIN.default,
    muted: false,
    fade_in_sec: Number(bgm.fade_in_sec) || AUDIO_FADE_DURATION.default,
    fade_out_sec: Number(bgm.fade_out_sec) || AUDIO_FADE_DURATION.default,
    speed: VISUAL_SPEED_DEFAULT,
    preserve_pitch: true,
    reverse: false,
    meta: {
      kind: "audio",
      asset_id: bgm.asset_id,
      name: bgm.name || "BGM",
      project_bgm: true,
      ducking_enabled: Boolean(bgm.ducking_enabled),
      ducking_volume: clampAudioGain(bgm.ducking_volume, AUDIO_DUCKING_GAIN),
    },
  };
  if (Number.isFinite(duration) && duration > 0) {
    clip.trim_out = duration;
    clip.meta.duration_sec = duration;
  }
  return clip;
}

export function hasSoloAudioTracks(body) {
  return audioTracks(body).some((track) => Boolean(track?.solo));
}

export function resolveAudioPreviewItems(body, timelineSec, masterVolume = AUDIO_MASTER_GAIN.default) {
  const t = Math.max(0, Number(timelineSec) || 0);
  const out = [];
  const soloActive = hasSoloAudioTracks(body);
  const pushClip = (clip, trackId, trackVolume = AUDIO_TRACK_GAIN.default) => {
    const hit = hitClipAtTime(clip, t);
    if (!hit) return;
    const audio = previewAudioState({
      clip,
      masterVolume,
      trackVolume,
      localTime: hit.localTime,
      visibleDuration: clipSourceDuration(clip),
    });
    out.push({
      id: clip.id,
      trackId,
      clip,
      sourceTime: hit.sourceTime,
      localTime: hit.localTime,
      playbackRate: clipSpeedAtTimeline(clip, hit.localTime),
      preservePitch: clipPreservePitch(clip),
      reversePlayback: clipReversePlayback(clip),
      muted: audio.muted,
      volume: audio.volume,
    });
  };
  for (const track of audioTracks(body)) {
    if (track.hidden || track.muted || (soloActive && !track.solo)) continue;
    for (const clip of sortClips(track.clips)) {
      pushClip(clip, track.id, track.volume);
    }
  }
  const bgmClip = projectBgmPreviewClip(body);
  if (bgmClip && !soloActive) {
    const foregroundActive = out.some((item) => !item.muted && item.volume > 0);
    const duckGain = foregroundActive && bgmClip.meta?.ducking_enabled ? bgmClip.meta.ducking_volume : AUDIO_TRACK_GAIN.default;
    pushClip(bgmClip, "bgm", duckGain);
  }
  return out;
}

/**
 * Keep media for clips about to start mounted before the timeline reaches the
 * cut.  The actual preview item reuses this DOM node at the boundary, which
 * avoids an audio decoder/network startup in the audible frame.
 */
export function resolveAudioPreviewPreloadItems(body, timelineSec, masterVolume = AUDIO_MASTER_GAIN.default, leadSec = 1.5) {
  const now = Math.max(0, Number(timelineSec) || 0);
  const horizon = now + Math.max(0, Number(leadSec) || 0);
  const out = [];
  const soloActive = hasSoloAudioTracks(body);
  const pushUpcoming = (clip, trackId, trackVolume = AUDIO_TRACK_GAIN.default) => {
    const start = Math.max(0, Number(clip?.timeline_start) || 0);
    if (start <= now + 1e-4 || start > horizon + 1e-4) return;
    // Use the timeline-facing first frame, including trimmed or reversed clips.
    const hit = hitClipAtTime(clip, start);
    if (!hit) return;
    const audio = previewAudioState({
      clip,
      masterVolume,
      trackVolume,
      localTime: 0,
      visibleDuration: clipSourceDuration(clip),
    });
    out.push({
      id: clip.id,
      trackId,
      clip,
      sourceTime: hit.sourceTime,
      localTime: 0,
      playbackRate: clipSpeedAtTimeline(clip, 0),
      preservePitch: clipPreservePitch(clip),
      reversePlayback: clipReversePlayback(clip),
      muted: audio.muted,
      volume: audio.volume,
      preloadOnly: true,
    });
  };
  for (const track of audioTracks(body)) {
    if (track.hidden || track.muted || (soloActive && !track.solo)) continue;
    for (const clip of sortClips(track.clips)) pushUpcoming(clip, track.id, track.volume);
  }
  if (!soloActive) {
    const bgmClip = projectBgmPreviewClip(body);
    if (bgmClip) pushUpcoming(bgmClip, "bgm");
  }
  return out;
}

export function overlayBlocks(body, totalSec) {
  return (body?.overlays || []).map((ov) => ({
    id: ov.id,
    label: (ov.meta?.name || ov.text?.content || ov.type || "叠层").toString().slice(0, 12),
    start: Number(ov.timeline_start) || 0,
    width: Number(ov.duration) || 3,
    color: ov.type === "webm" ? "bg-cyan-600/85" : "bg-violet-600/85",
    _overlay: ov,
    _transitionMarkers: transitionMarkersForNode(body, overlayTransitionRef(ov)),
  }));
}

export function trackBlocks(body, trackId, selectedClipId, selectedTrackId = null) {
  const track = body?.tracks?.find((t) => t.id === trackId);
  if (!track) return [];
  const isTrackSelected = selectedTrackId == null || selectedTrackId === trackId;
  return sortClips(track.clips).map((clip) => ({
    id: clip.id,
    label: clipLabel(clip).slice(0, 18),
    start: Number(clip.timeline_start) || 0,
    width: clipSourceDuration(clip),
    _transitionMarkers: transitionMarkersForNode(body, clipTransitionRef(trackId, clip.id)),
    thumb: trackId === "v2" ? "from-cyan-900 via-slate-800 to-zinc-900" : "from-orange-900 via-stone-800 to-zinc-900",
    selected: isTrackSelected && clip.id === selectedClipId,
    _clip: clip,
  }));
}
