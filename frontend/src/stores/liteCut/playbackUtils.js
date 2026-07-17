import {
  clipLabel,
  clipFreezeFrameSec,
  clipMediaTimelineDuration,
  clipReversePlayback,
  clipSpeedAtTimeline,
  clipSourceTimeForTimeline,
  clipSourceDuration,
  clipTrimmedSourceDuration,
  clipTimelineEnd,
  audioTracks,
  findClipById,
  getTrack,
  sortClips,
  trackMainVideoClips,
  v1Clips,
  videoTracks,
} from "./timelineUtils.js";
import { clipVolumeAtLocal } from "./audioKeyframeUtils.js";

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

/** Resolve which V1 clip is active at global timeline time. */
export function resolveV1PlaybackAt(body, timelineSec) {
  const clips = v1Clips(body);
  if (!clips.length) return null;

  const t = Math.max(0, timelineSec);
  for (const clip of clips) {
    const start = Number(clip.timeline_start) || 0;
    const end = clipTimelineEnd(clip);
    if (t >= start && t < end - 1e-4) {
      const local = t - start;
      const trimIn = Number(clip.trim_in) || 0;
      const sourceDur = clipTrimmedSourceDuration(clip);
      const sourceOffset = Math.max(0, Math.min(sourceDur, clipSourceTimeForTimeline(clip, local) - trimIn));
      return {
        clip,
        sourceTime: clipReversePlayback(clip) ? trimIn + Math.max(0, sourceDur - sourceOffset) : trimIn + sourceOffset,
        localTime: local,
        clipStart: start,
        clipEnd: end,
      };
    }
  }

  const last = clips[clips.length - 1];
  const end = clipTimelineEnd(last);
  if (t >= end - 1e-4) {
    const sourceDur = clipTrimmedSourceDuration(last);
    const timelineDur = clipSourceDuration(last);
    const trimIn = Number(last.trim_in) || 0;
    return {
      clip: last,
      sourceTime: clipReversePlayback(last) ? trimIn + 0.05 : trimIn + sourceDur - 0.05,
      localTime: timelineDur - 0.05,
      clipStart: last.timeline_start,
      clipEnd: end,
      atEnd: true,
    };
  }
  return null;
}

export function nextClipAfter(body, currentClipId) {
  const found = findClipById(body, currentClipId);
  const trackId = found.trackId;
  const clips = sortClips(getTrack(body, trackId)?.clips);
  const idx = clips.findIndex((c) => c.id === currentClipId);
  if (idx < 0 || idx >= clips.length - 1) return null;
  return clips[idx + 1];
}

export function resolveIncomingTransitionPlayback(body, playback) {
  if (!playback?.clip || !playback?.trackId) return null;
  const track = getTrack(body, playback.trackId);
  const clips = sortClips(track?.clips || []);
  const index = clips.findIndex((clip) => clip.id === playback.clip.id);
  if (index <= 0) return null;
  const previous = clips[index - 1];
  // Match the exporter: the incoming clip's transition_in owns the boundary
  // when present; otherwise fall back to the outgoing clip's transition_out.
  const incoming = playback.clip?.transition_in;
  const transition = incoming && typeof incoming === "object" ? incoming : previous?.transition_out;
  if (!transition || typeof transition !== "object") return null;
  const type = String(transition.type || "none").toLowerCase();
  const duration = Math.max(0, Math.min(1.5, Number(transition.duration_sec) || 0));
  const localTime = Math.max(0, Number(playback.localTime) || 0);
  const expectedStart = clipTimelineEnd(previous);
  if (type === "none" || duration < 0.02 || Math.abs((Number(playback.clipStart) || 0) - expectedStart) > 0.05 || localTime >= duration) {
    return null;
  }
  return {
    ...hitClipAtEnd(previous),
    trackId: playback.trackId,
    transitionType: type,
    transitionDuration: duration,
    progress: Math.max(0, Math.min(1, localTime / duration)),
    freezePlayback: true,
  };
}

/**
 * Mount the outgoing frame shortly before a contiguous boundary transition.
 * The element remains fully transparent until the next clip starts, so it
 * cannot change the picture before the cut but is decoded and ready beneath
 * an incoming fade at frame zero.
 */
export function resolveOutgoingTransitionPreload(body, playback, preloadLeadSec = 2) {
  if (!playback?.clip || !playback?.trackId) return null;
  const track = getTrack(body, playback.trackId);
  const clips = sortClips(track?.clips || []);
  const index = clips.findIndex((clip) => clip.id === playback.clip.id);
  if (index < 0 || index >= clips.length - 1) return null;
  const next = clips[index + 1];
  const expectedStart = clipTimelineEnd(playback.clip);
  if (Math.abs((Number(next.timeline_start) || 0) - expectedStart) > 0.05) return null;
  const incoming = next.transition_in;
  const transition = incoming && typeof incoming === "object" ? incoming : playback.clip.transition_out;
  if (!transition || typeof transition !== "object") return null;
  const type = String(transition.type || "none").toLowerCase();
  const duration = Math.max(0, Math.min(1.5, Number(transition.duration_sec) || 0));
  const localTime = Math.max(0, Number(playback.localTime) || 0);
  const clipDuration = Math.max(0, Number(playback.clipEnd) - Number(playback.clipStart));
  const lead = Math.max(duration, Math.min(2, Math.max(0.25, Number(preloadLeadSec) || 2)));
  if (type === "none" || duration < 0.02 || localTime < Math.max(0, clipDuration - lead)) return null;
  return {
    ...hitClipAtEnd(playback.clip),
    trackId: playback.trackId,
    transitionType: type,
    transitionDuration: duration,
    preloadOnly: true,
    freezePlayback: true,
  };
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
  masterVolume = 1,
  forceMuted = false,
  trackVolume = 1,
  localTime = 0,
  visibleDuration = null,
} = {}) {
  if (forceMuted || clip?.muted) return { muted: true, volume: 0 };
  const rawClipVolume = Number(clip?.volume);
  const rawMasterVolume = Number(masterVolume);
  const rawTrackVolume = Number(trackVolume);
  const clipVolume = clipVolumeAtLocal(clip, localTime, visibleDuration ?? undefined, Number.isFinite(rawClipVolume) ? rawClipVolume : 1);
  const projectVolume = Number.isFinite(rawMasterVolume) ? rawMasterVolume : 1;
  const normalizedTrackVolume = Number.isFinite(rawTrackVolume) ? Math.max(0, Math.min(2, rawTrackVolume)) : 1;
  const fadeIn = Math.max(0, Number(clip?.fade_in_sec) || 0);
  const fadeOut = Math.max(0, Number(clip?.fade_out_sec) || 0);
  const local = Math.max(0, Number(localTime) || 0);
  const duration = Number.isFinite(Number(visibleDuration)) ? Math.max(0, Number(visibleDuration)) : clip ? clipSourceDuration(clip) : 0;
  const fadeInFactor = fadeIn > 0 ? Math.min(1, local / fadeIn) : 1;
  const fadeOutFactor = fadeOut > 0 && duration > 0 ? Math.min(1, Math.max(0, (duration - local) / fadeOut)) : 1;
  const volume = Math.max(0, Math.min(1, clipVolume * normalizedTrackVolume * projectVolume * Math.min(fadeInFactor, fadeOutFactor)));
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
    timeline_start: Math.max(0, Number(bgm.start_sec) || 0),
    trim_in: 0,
    volume: Number.isFinite(Number(bgm.volume)) ? Number(bgm.volume) : 1,
    muted: false,
    fade_in_sec: Number(bgm.fade_in_sec) || 0,
    fade_out_sec: Number(bgm.fade_out_sec) || 0,
    speed: 1,
    preserve_pitch: true,
    reverse: false,
    meta: {
      kind: "audio",
      asset_id: bgm.asset_id,
      name: bgm.name || "BGM",
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

export function resolveAudioPreviewItems(body, timelineSec, masterVolume = 1) {
  const t = Math.max(0, Number(timelineSec) || 0);
  const out = [];
  const soloActive = hasSoloAudioTracks(body);
  const pushClip = (clip, trackId, trackVolume = 1) => {
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
  // Native <video> audio can only represent the currently selected visual
  // layer.  Export mixes every visible video layer, so mirror that mix through
  // dedicated audio elements during timeline preview.
  if (!soloActive) {
    for (const track of videoTracks(body)) {
      if (track.hidden || track.muted) continue;
      for (const clip of sortClips(track.clips)) {
        pushClip(clip, track.id, track.volume);
      }
    }
  }
  const bgmClip = projectBgmPreviewClip(body);
  if (bgmClip && !soloActive) pushClip(bgmClip, "bgm");
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
    thumb: trackId === "v2" ? "from-cyan-900 via-slate-800 to-zinc-900" : "from-orange-900 via-stone-800 to-zinc-900",
    selected: isTrackSelected && clip.id === selectedClipId,
    _clip: clip,
  }));
}
