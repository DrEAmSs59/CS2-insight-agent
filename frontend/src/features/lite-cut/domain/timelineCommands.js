import {
  canPlaceOnTrack,
  canTrimClipEndToPlayhead,
  canTrimClipStartToPlayhead,
  canTrimOverlayToPlayhead,
  findClipById,
  getTrack,
  buildSubtitleOverlays,
  cloneOverlayForPaste,
  cloneTimelineClipForPaste,
  editableAudioTracks,
  editableVideoTracks,
  insertAudioTrack,
  insertClipIntoTrackWithRipple,
  insertOverlayWithRipple,
  insertVideoTrack,
  linkedTimelineClipIds,
  newMarkerId,
  nudgeClipInTrack,
  nudgeOverlayInList,
  overlayTimelineEnd,
  projectFrameStepSec,
  rebaseTimelineClipKeyframes,
  resizeOverlayDraft,
  slipClipInTrack,
  splitClipAt,
  splitOverlayAt,
  sortClips,
  snapTimelineSec,
  trimClipEndDraft,
} from "../state/timelineUtils.js";
import {
  normalizeSceneKeyframes,
  normalizeSceneTransform,
  sceneKeyframeNearPlayhead,
  sceneTransformAt,
  VIDEO_SCENE_TRANSFORM_DEFAULTS,
} from "../state/sceneTransform.js";
import {
  audioKeyframeNearPlayhead,
  clipVolumeAt,
  normalizedAudioKeyframes,
  normalizedAudioVolume,
} from "../state/audioKeyframeUtils.js";
import { rewireTransitionExitEndpointsAfterSplit } from "../state/transitionModel.js";
import {
  clipMaxTimelineEnd,
  clipMaxTimelineStartForLeftTrim,
  clipSourceDuration,
  clipSourceTimeForTimeline,
  clipTimelineEnd,
  ensureClipSourceDuration,
} from "./timelineMath.js";

export function uniqueTimelineIds(ids = []) {
  return [...new Set((ids || []).filter(Boolean).map(String))];
}

export function activeTimelineSelectionIds(state) {
  return uniqueTimelineIds(state?.selectedClipIds?.length
    ? state.selectedClipIds
    : state?.selectedClipId
      ? [state.selectedClipId]
      : []);
}

export function timelineSelectionEntries(body, ids = []) {
  const wanted = new Set(uniqueTimelineIds(ids));
  if (!wanted.size) return [];
  const entries = [];
  for (const overlay of body?.overlays || []) {
    if (!wanted.has(String(overlay?.id))) continue;
    entries.push({
      id: overlay.id,
      kind: "overlay",
      trackId: "overlay",
      item: overlay,
      start: Number(overlay.timeline_start) || 0,
      end: overlayTimelineEnd(overlay),
    });
  }
  for (const track of body?.tracks || []) {
    for (const clip of track?.clips || []) {
      if (!wanted.has(String(clip?.id))) continue;
      const start = Number(clip.timeline_start) || 0;
      entries.push({
        id: clip.id,
        kind: "clip",
        trackId: track.id,
        trackType: track.type === "audio" ? "audio" : "video",
        item: clip,
        start,
        end: start + clipSourceDuration(clip),
        locked: Boolean(track.locked),
        hidden: Boolean(track.hidden),
      });
    }
  }
  return entries.sort((left, right) => left.start - right.start || String(left.id).localeCompare(String(right.id)));
}

export function canShiftTrackSelection(track, selectedIds, deltaSec) {
  if (!track || track.locked) return false;
  const ids = new Set(uniqueTimelineIds(selectedIds));
  const clips = track.clips || [];
  const selected = clips.filter((clip) => ids.has(String(clip.id)));
  if (!selected.length) return true;
  const shifted = selected.map((clip) => ({
    ...clip,
    timeline_start: (Number(clip.timeline_start) || 0) + deltaSec,
  }));
  if (shifted.some((clip) => (Number(clip.timeline_start) || 0) < 0)) return false;
  const unselected = clips.filter((clip) => !ids.has(String(clip.id)));
  return shifted.every((clip) => canPlaceOnTrack(unselected, Number(clip.timeline_start) || 0, clipSourceDuration(clip)));
}

export function canMoveTimelineSelection(body, selectedIds, deltaSec) {
  const ids = uniqueTimelineIds(selectedIds);
  if (ids.length <= 1) return { allowed: false, reason: "selection_too_small", entries: [] };
  const entries = timelineSelectionEntries(body, ids);
  if (!entries.length) return { allowed: false, reason: "selection_missing", entries };
  if (entries.some((entry) => entry.locked || entry.hidden)) return { allowed: false, reason: "selection_locked_or_hidden", entries };
  const delta = Number(deltaSec) || 0;
  if (Math.abs(delta) <= 1e-6) return { allowed: false, reason: "zero_delta", entries };
  if (Math.min(...entries.map((entry) => entry.start)) + delta < -1e-6) {
    return { allowed: false, reason: "before_timeline_start", entries };
  }
  const byTrack = new Map();
  for (const entry of entries.filter((entry) => entry.kind === "clip")) {
    if (!byTrack.has(entry.trackId)) byTrack.set(entry.trackId, []);
    byTrack.get(entry.trackId).push(entry.id);
  }
  for (const [trackId, trackIds] of byTrack.entries()) {
    const track = (body?.tracks || []).find((item) => item?.id === trackId);
    if (!canShiftTrackSelection(track, trackIds, delta)) {
      return { allowed: false, reason: "track_collision", entries };
    }
  }
  return { allowed: true, reason: null, entries };
}

export function moveTimelineSelection(body, selectedIds, deltaSec) {
  const check = canMoveTimelineSelection(body, selectedIds, deltaSec);
  if (!check.allowed) return { changed: false, body, reason: check.reason, selectedIds: uniqueTimelineIds(selectedIds) };
  const next = structuredClone(body);
  const ids = new Set(uniqueTimelineIds(selectedIds));
  const delta = Number(deltaSec) || 0;
  next.overlays = (next.overlays || []).map((overlay) => (
    ids.has(String(overlay.id))
      ? { ...overlay, timeline_start: (Number(overlay.timeline_start) || 0) + delta }
      : overlay
  ));
  for (const track of next.tracks || []) {
    if (track.locked) continue;
    track.clips = sortClips((track.clips || []).map((clip) => (
      ids.has(String(clip.id))
        ? { ...clip, timeline_start: (Number(clip.timeline_start) || 0) + delta }
        : clip
    )));
  }
  return { changed: true, body: next, reason: null, selectedIds: [...ids] };
}

export function selectedTrimTargets(body, selectedIds, side, playheadSec) {
  return timelineSelectionEntries(body, selectedIds).filter((entry) => {
    if (entry.kind === "overlay") return canTrimOverlayToPlayhead(entry.item, side, playheadSec);
    if (entry.locked || entry.hidden) return false;
    if (side === "start") return canTrimClipStartToPlayhead(entry.item, entry.trackType, playheadSec);
    if (side === "end") return canTrimClipEndToPlayhead(entry.item, entry.trackType, playheadSec);
    return false;
  });
}

export function rippleDeleteTrackSelection(track, selectedIds) {
  if (!track || track.locked || track.hidden) return { deleted: false, clips: track?.clips || [] };
  const ids = new Set(uniqueTimelineIds(selectedIds));
  const clips = track.clips || [];
  const removed = sortClips(clips.filter((clip) => ids.has(String(clip.id)))).map((clip) => ({
    id: clip.id,
    start: Number(clip.timeline_start) || 0,
    end: clipTimelineEnd(clip),
    duration: clipSourceDuration(clip),
  }));
  if (!removed.length) return { deleted: false, clips };
  const kept = clips
    .filter((clip) => !ids.has(String(clip.id)))
    .map((clip) => {
      const start = Number(clip.timeline_start) || 0;
      const shift = removed.filter((span) => start >= span.end - 1e-6).reduce((sum, span) => sum + span.duration, 0);
      return shift > 0 ? { ...clip, timeline_start: Math.max(0, start - shift) } : clip;
    });
  return { deleted: true, clips: sortClips(kept) };
}

export function rippleDeleteOverlaySelection(overlays, selectedIds) {
  const ids = new Set(uniqueTimelineIds(selectedIds));
  const removed = (overlays || [])
    .filter((overlay) => ids.has(String(overlay.id)))
    .map((overlay) => ({
      id: overlay.id,
      start: Number(overlay.timeline_start) || 0,
      end: overlayTimelineEnd(overlay),
      duration: Math.max(0.1, Number(overlay.duration) || 0),
    }))
    .sort((left, right) => left.start - right.start);
  if (!removed.length) return { deleted: false, overlays: overlays || [] };
  const kept = (overlays || [])
    .filter((overlay) => !ids.has(String(overlay.id)))
    .map((overlay) => {
      const start = Number(overlay.timeline_start) || 0;
      const shift = removed.filter((span) => start >= span.end - 1e-6).reduce((sum, span) => sum + span.duration, 0);
      return shift > 0 ? { ...overlay, timeline_start: Math.max(0, start - shift) } : overlay;
    })
    .sort((left, right) => (left.timeline_start || 0) - (right.timeline_start || 0));
  return { deleted: true, overlays: kept };
}

function timelineItemGroupId(item) {
  const id = item?.meta?.group_id;
  return typeof id === "string" && id ? id : null;
}

function timelineItemById(body, itemId) {
  return (body?.overlays || []).find((item) => String(item?.id) === String(itemId)) || findClipById(body, itemId).clip;
}

export function groupTimelineItems(body, selectedIds, groupId) {
  const ids = uniqueTimelineIds(selectedIds);
  if (ids.length < 2) return { changed: false, body, reason: "selection_too_small", selectedIds: ids };
  const next = structuredClone(body);
  const wanted = new Set(ids);
  next.overlays = (next.overlays || []).map((overlay) => (
    wanted.has(String(overlay.id))
      ? { ...overlay, meta: { ...(overlay.meta || {}), group_id: groupId } }
      : overlay
  ));
  for (const track of next.tracks || []) {
    track.clips = (track.clips || []).map((clip) => (
      wanted.has(String(clip.id))
        ? { ...clip, meta: { ...(clip.meta || {}), group_id: groupId } }
        : clip
    ));
  }
  return { changed: true, body: next, reason: null, selectedIds: ids };
}

export function ungroupTimelineItems(body, selectedIds) {
  const ids = uniqueTimelineIds(selectedIds);
  const groupIds = new Set(ids.map((id) => timelineItemGroupId(timelineItemById(body, id))).filter(Boolean));
  if (!groupIds.size) return { changed: false, body, reason: "selection_not_grouped", selectedIds: ids };
  const next = structuredClone(body);
  const clearGroup = (item) => {
    if (!groupIds.has(timelineItemGroupId(item))) return item;
    const { group_id, ...meta } = item.meta || {};
    return { ...item, meta };
  };
  next.overlays = (next.overlays || []).map(clearGroup);
  for (const track of next.tracks || []) track.clips = (track.clips || []).map(clearGroup);
  return { changed: true, body: next, reason: null, selectedIds: ids };
}

export function canLinkTimelineClips(body, selectedIds) {
  const ids = uniqueTimelineIds(selectedIds);
  if (ids.length !== 2) return { allowed: false, reason: "requires_video_audio_pair" };
  const entries = ids.map((id) => {
    const found = findClipById(body, id);
    return { ...found, track: getTrack(body, found.trackId) };
  });
  const video = entries.find((entry) => entry.track?.type === "video");
  const audio = entries.find((entry) => entry.track?.type === "audio");
  if (!video?.clip || !audio?.clip) return { allowed: false, reason: "requires_video_audio_pair" };
  if (video.track.locked || audio.track.locked) return { allowed: false, reason: "track_locked" };
  if (linkedTimelineClipIds(body, video.clip.id).length > 1 || linkedTimelineClipIds(body, audio.clip.id).length > 1) {
    return { allowed: false, reason: "already_linked" };
  }
  return { allowed: true, reason: null, videoId: String(video.clip.id), audioId: String(audio.clip.id) };
}

export function linkTimelineClips(body, selectedIds) {
  const check = canLinkTimelineClips(body, selectedIds);
  if (!check.allowed) return { changed: false, body, reason: check.reason, selectedIds: uniqueTimelineIds(selectedIds) };
  const next = structuredClone(body);
  const { clip: video } = findClipById(next, check.videoId);
  const { clip: audio } = findClipById(next, check.audioId);
  video.muted = true;
  video.meta = { ...(video.meta || {}), linked_audio_clip_id: audio.id };
  audio.meta = { ...(audio.meta || {}), source_clip_id: video.id, linked_from_video: true };
  return { changed: true, body: next, reason: null, selectedIds: uniqueTimelineIds(selectedIds) };
}

export function unlinkTimelineClips(body, selectedClipId) {
  const { clip } = findClipById(body, selectedClipId);
  const sourceId = String(clip?.meta?.source_clip_id || clip?.id || "");
  if (!sourceId || linkedTimelineClipIds(body, selectedClipId).length <= 1) {
    return { changed: false, body, reason: "selection_not_linked" };
  }
  const next = structuredClone(body);
  let changed = false;
  for (const track of next.tracks || []) {
    for (const candidate of track.clips || []) {
      if (String(candidate.id) === sourceId && candidate.meta?.linked_audio_clip_id) {
        const { linked_audio_clip_id, ...meta } = candidate.meta;
        candidate.meta = meta;
        changed = true;
      }
      if (String(candidate.meta?.source_clip_id || "") === sourceId) {
        const { source_clip_id, linked_from_video, ...meta } = candidate.meta || {};
        candidate.meta = meta;
        changed = true;
      }
    }
  }
  return { changed, body: changed ? next : body, reason: changed ? null : "selection_not_linked" };
}

export function addTimelineMarker(body, timeSec, markerId = newMarkerId()) {
  if (!body) return { changed: false, body, markerId: null };
  const next = structuredClone(body);
  const marker = {
    id: markerId,
    time_sec: Math.max(0, Number(timeSec) || 0),
    label: "",
    color: "#f59e0b",
  };
  next.markers = [...(next.markers || []), marker].sort((left, right) => (left.time_sec || 0) - (right.time_sec || 0));
  return { changed: true, body: next, markerId: marker.id };
}

export function updateTimelineMarker(body, markerId, patch) {
  if (!body || !markerId || !patch || typeof patch !== "object") return { changed: false, body };
  const current = (body.markers || []).find((marker) => marker?.id === markerId);
  if (!current) return { changed: false, body };
  const label = patch.label == null ? String(current.label || "") : String(patch.label).slice(0, 80);
  const candidateColor = patch.color == null ? String(current.color || "#f59e0b") : String(patch.color);
  const color = /^#[0-9a-f]{6}$/i.test(candidateColor) ? candidateColor : "#f59e0b";
  const timeSec = patch.time_sec == null
    ? Math.max(0, Number(current.time_sec) || 0)
    : Math.max(0, Number(patch.time_sec) || 0);
  if (
    label === String(current.label || "")
    && color === String(current.color || "#f59e0b")
    && Math.abs(timeSec - (Number(current.time_sec) || 0)) < 0.0001
  ) return { changed: false, body };
  const next = structuredClone(body);
  const marker = next.markers.find((item) => item?.id === markerId);
  marker.label = label;
  marker.color = color;
  marker.time_sec = timeSec;
  next.markers.sort((left, right) => (Number(left.time_sec) || 0) - (Number(right.time_sec) || 0));
  return { changed: true, body: next };
}

export function deleteTimelineMarker(body, markerId) {
  if (!body || !markerId || !(body.markers || []).some((marker) => marker?.id === markerId)) {
    return { changed: false, body };
  }
  const next = structuredClone(body);
  next.markers = (next.markers || []).filter((marker) => marker?.id !== markerId);
  return { changed: true, body: next };
}

export function nudgeTimelineItem(body, itemId, selectedTrackId, deltaSec) {
  if (!body || !itemId) return { changed: false, body };
  const next = structuredClone(body);
  if (selectedTrackId === "overlay") {
    const result = nudgeOverlayInList(next.overlays || [], itemId, deltaSec);
    if (!result.moved) return { changed: false, body };
    next.overlays = result.overlays;
    return { changed: true, body: next };
  }
  const { trackId } = findClipById(next, itemId);
  const track = getTrack(next, trackId);
  const result = nudgeClipInTrack(track, itemId, deltaSec);
  if (!result.moved) return { changed: false, body };
  track.clips = result.clips;
  return { changed: true, body: next };
}

export function slipTimelineClip(body, clipId, deltaSec) {
  if (!body || !clipId) return { changed: false, body };
  const next = structuredClone(body);
  const { trackId } = findClipById(next, clipId);
  const track = getTrack(next, trackId);
  const result = slipClipInTrack(track, clipId, deltaSec);
  if (!result.moved) return { changed: false, body };
  track.clips = result.clips;
  return { changed: true, body: next };
}

function pasteTargetTrack(body, trackType, selectedTrackId, originalTrackId = null) {
  const original = originalTrackId ? getTrack(body, originalTrackId) : null;
  if (original?.type === trackType && !original.locked && !original.hidden) return original;
  const selected = selectedTrackId !== "overlay" ? getTrack(body, selectedTrackId) : null;
  if (selected?.type === trackType && !selected.locked && !selected.hidden) return selected;
  return trackType === "audio" ? editableAudioTracks(body)[0] : editableVideoTracks(body)[0];
}

function createPasteTrack(body, trackType, afterTrackId = null) {
  const id = trackType === "audio" ? insertAudioTrack(body, afterTrackId) : insertVideoTrack(body, afterTrackId);
  return getTrack(body, id);
}

export function pasteTimelineClipboard(body, clipboard, playheadSec, selectedTrackId, { ripple = false } = {}) {
  if (!body || !clipboard) return { changed: false, body, selectedIds: [], selectedTrackId: null };
  const next = structuredClone(body);
  const newIds = [];
  let primaryId = null;
  let primaryTrackId = null;
  const remember = (id, trackId) => {
    if (!id || !trackId) return;
    newIds.push(id);
    primaryId = id;
    primaryTrackId = trackId;
  };

  if (clipboard.type === "multi") {
    const targetByTrack = new Map();
    for (const entry of clipboard.items || []) {
      const start = Math.max(0, (Number(playheadSec) || 0) + (Number(entry.offset) || 0));
      if (entry.type === "overlay") {
        const overlay = cloneOverlayForPaste(entry.item, start);
        if (!overlay) continue;
        next.overlays = [...(next.overlays || []), overlay];
        remember(overlay.id, "overlay");
        continue;
      }
      const trackType = entry.trackType === "audio" ? "audio" : "video";
      const clip = cloneTimelineClipForPaste(entry.item, start);
      if (!clip) continue;
      const duration = clipSourceDuration(clip);
      let target = targetByTrack.get(entry.trackId) || pasteTargetTrack(next, trackType, selectedTrackId, entry.trackId);
      if (!target) target = createPasteTrack(next, trackType);
      if (target && !canPlaceOnTrack(target.clips, clip.timeline_start, duration)) {
        target = createPasteTrack(next, trackType, target.id);
      }
      if (!target || target.locked || !canPlaceOnTrack(target.clips, clip.timeline_start, duration)) continue;
      target.clips = sortClips([...(target.clips || []), clip]);
      targetByTrack.set(entry.trackId, target);
      remember(clip.id, target.id);
    }
  } else if (clipboard.type === "overlay") {
    const overlay = cloneOverlayForPaste(clipboard.item, playheadSec);
    if (overlay) {
      if (ripple) {
        const result = insertOverlayWithRipple(next.overlays || [], overlay);
        if (result.inserted) {
          next.overlays = result.overlays;
          remember(overlay.id, "overlay");
        }
      } else {
        next.overlays = [...(next.overlays || []), overlay];
        remember(overlay.id, "overlay");
      }
    }
  } else {
    const trackType = clipboard.trackType === "audio" ? "audio" : "video";
    const clip = cloneTimelineClipForPaste(clipboard.item, playheadSec);
    if (clip) {
      let target = pasteTargetTrack(next, trackType, selectedTrackId);
      if (!target) target = createPasteTrack(next, trackType);
      if (ripple) {
        let result = insertClipIntoTrackWithRipple(target, clip);
        if (!result.inserted) {
          target = createPasteTrack(next, trackType, target?.id);
          result = insertClipIntoTrackWithRipple(target, clip);
        }
        if (target && !target.locked && result.inserted) {
          target.clips = result.clips;
          remember(clip.id, target.id);
        }
      } else {
        const duration = clipSourceDuration(clip);
        if (target && !canPlaceOnTrack(target.clips, clip.timeline_start, duration)) {
          target = createPasteTrack(next, trackType, target.id);
        }
        if (target && !target.locked && canPlaceOnTrack(target.clips, clip.timeline_start, duration)) {
          target.clips = sortClips([...(target.clips || []), clip]);
          remember(clip.id, target.id);
        }
      }
    }
  }

  if (!primaryId || !primaryTrackId) return { changed: false, body, selectedIds: [], selectedTrackId: null };
  return {
    changed: true,
    body: next,
    selectedClipId: primaryId,
    selectedIds: uniqueTimelineIds(newIds.length ? newIds : [primaryId]),
    selectedTrackId: primaryTrackId,
  };
}

function commandLinkedClipPairs(body) {
  const videos = new Map();
  const audios = new Map();
  for (const track of body?.tracks || []) {
    for (const clip of track?.clips || []) {
      if (!clip?.id) continue;
      if (track.type === "video") videos.set(String(clip.id), clip);
      if (track.type === "audio") audios.set(String(clip.id), clip);
    }
  }
  const pairs = new Map();
  for (const [videoId, video] of videos) {
    const audioId = String(video.meta?.linked_audio_clip_id || "");
    if (audioId && audios.has(audioId)) pairs.set(`${videoId}:${audioId}`, { videoId, audioId });
  }
  for (const [audioId, audio] of audios) {
    const videoId = String(audio.meta?.source_clip_id || "");
    if (videoId && videos.has(videoId)) pairs.set(`${videoId}:${audioId}`, { videoId, audioId });
  }
  return [...pairs.values()];
}

function commandClipCanSplitAt(body, clipId, playheadSec) {
  const { clip, trackId } = findClipById(body, clipId);
  const track = getTrack(body, trackId);
  if (!clip || !track || track.locked || track.hidden) return false;
  const local = playheadSec - (Number(clip.timeline_start) || 0);
  return local > 0.05 && local < clipSourceDuration(clip) - 0.05;
}

function commandLinkedSplitSelection(body, selectedIds, playheadSec) {
  const selected = new Set(uniqueTimelineIds(selectedIds));
  for (const { videoId, audioId } of commandLinkedClipPairs(body)) {
    if (!selected.has(videoId) && !selected.has(audioId)) continue;
    if (commandClipCanSplitAt(body, videoId, playheadSec) && commandClipCanSplitAt(body, audioId, playheadSec)) {
      selected.add(videoId);
      selected.add(audioId);
    } else {
      selected.delete(videoId);
      selected.delete(audioId);
    }
  }
  return uniqueTimelineIds([...selected]);
}

function commandSetLinkedClipPair(video, audio) {
  video.muted = true;
  video.meta = { ...(video.meta || {}), linked_audio_clip_id: audio.id };
  audio.meta = { ...(audio.meta || {}), source_clip_id: video.id, linked_from_video: true };
}

function commandRestoreLinksAfterSplit(body, pairs, rightIds) {
  for (const { videoId, audioId } of pairs) {
    const videoRightId = rightIds.get(videoId);
    const audioRightId = rightIds.get(audioId);
    if (!videoRightId && !audioRightId) continue;
    const { clip: videoLeft } = findClipById(body, videoId);
    const { clip: audioLeft } = findClipById(body, audioId);
    if (videoLeft && audioLeft) commandSetLinkedClipPair(videoLeft, audioLeft);
    const { clip: videoRight } = videoRightId ? findClipById(body, videoRightId) : { clip: null };
    const { clip: audioRight } = audioRightId ? findClipById(body, audioRightId) : { clip: null };
    if (videoRight) {
      const { linked_audio_clip_id, ...meta } = videoRight.meta || {};
      videoRight.meta = meta;
    }
    if (audioRight) {
      const { source_clip_id, ...meta } = audioRight.meta || {};
      audioRight.meta = meta;
    }
    if (videoRight && audioRight) commandSetLinkedClipPair(videoRight, audioRight);
  }
}

export function splitTimelineSelection(body, selectedIds, playheadSec) {
  if (!body) return { changed: false, body, selectedIds: [], selectedTrackId: null };
  const ids = commandLinkedSplitSelection(body, selectedIds, playheadSec);
  if (!ids.length) return { changed: false, body, selectedIds: [], selectedTrackId: null };
  const targets = timelineSelectionEntries(body, ids).filter((entry) => {
    if (entry.locked || entry.hidden) return false;
    const local = playheadSec - entry.start;
    return local > 0.05 && local < (entry.end - entry.start) - 0.05;
  });
  if (!targets.length) return { changed: false, body, selectedIds: [], selectedTrackId: null };
  const next = structuredClone(body);
  const selected = new Set(ids.map(String));
  const pairs = commandLinkedClipPairs(body);
  const rightIds = new Map();
  const newIds = [];
  let primaryTrackId = null;
  for (const track of next.tracks || []) {
    if (track.locked || track.hidden) continue;
    const clips = [];
    for (const clip of sortClips(track.clips || [])) {
      if (!selected.has(String(clip.id))) {
        clips.push(clip);
        continue;
      }
      const local = playheadSec - (Number(clip.timeline_start) || 0);
      if (local <= 0.05 || local >= clipSourceDuration(clip) - 0.05) {
        clips.push(clip);
        continue;
      }
      const [left, right] = splitClipAt(clip, local);
      clips.push(left, right);
      newIds.push(right.id);
      rightIds.set(String(clip.id), String(right.id));
      primaryTrackId ||= track.id;
    }
    track.clips = sortClips(clips);
  }
  const overlays = [];
  for (const overlay of next.overlays || []) {
    if (!selected.has(String(overlay.id))) {
      overlays.push(overlay);
      continue;
    }
    const local = playheadSec - (Number(overlay.timeline_start) || 0);
    const duration = Number(overlay.duration) || 0;
    if (local <= 0.05 || local >= duration - 0.05) {
      overlays.push(overlay);
      continue;
    }
    const [left, right] = splitOverlayAt(overlay, local);
    overlays.push(left, right);
    newIds.push(right.id);
    rightIds.set(String(overlay.id), String(right.id));
    primaryTrackId ||= "overlay";
  }
  next.overlays = overlays.sort((left, right) => (left.timeline_start || 0) - (right.timeline_start || 0));
  commandRestoreLinksAfterSplit(next, pairs, rightIds);
  rewireTransitionExitEndpointsAfterSplit(next, rightIds);
  if (!newIds.length) return { changed: false, body, selectedIds: [], selectedTrackId: null };
  return {
    changed: true,
    body: next,
    selectedClipId: newIds[0],
    selectedIds: uniqueTimelineIds(newIds),
    selectedTrackId: primaryTrackId,
  };
}

export function trimTimelineSelection(body, selectedIds, side, playheadSec) {
  if (!body) return { changed: false, body };
  const next = structuredClone(body);
  const targets = selectedTrimTargets(next, selectedIds, side, playheadSec);
  if (!targets.length) return { changed: false, body };
  const targetIds = new Set(targets.map((target) => String(target.id)));
  next.overlays = (next.overlays || []).map((overlay) => {
    if (!targetIds.has(String(overlay.id))) return overlay;
    if (side === "start") {
      return resizeOverlayDraft(overlay, {
        start: playheadSec,
        duration: overlayTimelineEnd(overlay) - playheadSec,
      });
    }
    return resizeOverlayDraft(overlay, { duration: playheadSec - (Number(overlay.timeline_start) || 0) });
  });
  for (const track of next.tracks || []) {
    if (track.locked) continue;
    track.clips = sortClips((track.clips || []).map((clip) => {
      if (!targetIds.has(String(clip.id))) return clip;
      if (side === "start") {
        const oldStart = Number(clip.timeline_start) || 0;
        const start = Math.max(oldStart, Math.min(playheadSec, clipMaxTimelineStartForLeftTrim(clip)));
        const delta = start - oldStart;
        if (delta <= 0) return clip;
        return rebaseTimelineClipKeyframes(clip, {
          ...clip,
          timeline_start: start,
          trim_in: clipSourceTimeForTimeline(clip, delta),
        });
      }
      ensureClipSourceDuration(clip);
      const start = Number(clip.timeline_start) || 0;
      const end = Math.max(start + 0.1, Math.min(playheadSec, clipMaxTimelineEnd(clip)));
      return rebaseTimelineClipKeyframes(clip, trimClipEndDraft(clip, end));
    }));
  }
  return { changed: true, body: next };
}

export function buildSubtitleTimelineItems(rawText, options = {}) {
  return buildSubtitleOverlays(rawText, options);
}

export function snapTimelinePosition(timeSec, body, options = {}) {
  return snapTimelineSec(timeSec, body, options);
}

function transformKeyframeTarget(body, kind, itemId, trackId) {
  if (kind === "overlay") {
    const item = (body?.overlays || []).find((overlay) => String(overlay.id) === String(itemId));
    return { item, locked: false, defaults: undefined, duration: Math.max(0, Number(item?.duration) || 0) };
  }
  const track = getTrack(body, trackId);
  const item = (track?.clips || []).find((clip) => String(clip.id) === String(itemId));
  return {
    item,
    locked: Boolean(track?.locked),
    defaults: VIDEO_SCENE_TRANSFORM_DEFAULTS,
    duration: item ? clipSourceDuration(item) : 0,
  };
}

function keyframeItem(item, duration) {
  return item?.timeline_start == null ? item : { ...item, duration };
}

export function upsertTimelineTransformKeyframe(body, { kind, itemId, trackId, playheadSec }) {
  if (!body) return { changed: false, body };
  const next = structuredClone(body);
  const target = transformKeyframeTarget(next, kind, itemId, trackId);
  if (!target.item) return { changed: false, body };
  const item = keyframeItem(target.item, target.duration);
  const local = Math.max(0, Math.min(target.duration, (Number(playheadSec) || 0) - (Number(target.item.timeline_start) || 0)));
  const keyframes = normalizeSceneKeyframes(item, target.defaults);
  const existing = sceneKeyframeNearPlayhead(item, playheadSec, 0.04, target.defaults);
  const point = { time_sec: local, transform: sceneTransformAt(item, playheadSec, target.defaults) };
  target.item.keyframes = [
    ...keyframes.filter((keyframe) => keyframe !== existing && Math.abs(keyframe.time_sec - local) > 0.04),
    point,
  ].sort((left, right) => left.time_sec - right.time_sec);
  return { changed: true, body: next };
}

export function removeTimelineTransformKeyframe(body, { kind, itemId, trackId, playheadSec }) {
  if (!body) return { changed: false, body };
  const next = structuredClone(body);
  const target = transformKeyframeTarget(next, kind, itemId, trackId);
  if (!target.item) return { changed: false, body };
  const item = keyframeItem(target.item, target.duration);
  const local = (Number(playheadSec) || 0) - (Number(target.item.timeline_start) || 0);
  target.item.keyframes = normalizeSceneKeyframes(item, target.defaults)
    .filter((keyframe) => Math.abs(keyframe.time_sec - local) > 0.04);
  return { changed: true, body: next };
}

export function moveTimelineTransformKeyframe(body, {
  kind,
  itemId,
  trackId,
  fromPlayheadSec,
  toPlayheadSec,
}) {
  if (!body) return { changed: false, body };
  const next = structuredClone(body);
  const target = transformKeyframeTarget(next, kind, itemId, trackId);
  if (!target.item || target.locked) return { changed: false, body };
  const start = Number(target.item.timeline_start) || 0;
  const frame = projectFrameStepSec(next);
  const fromLocal = (Number(fromPlayheadSec) || 0) - start;
  const targetLocal = Math.max(0, Math.min(
    target.duration,
    Math.round(((Number(toPlayheadSec) || 0) - start) / frame) * frame,
  ));
  const item = keyframeItem(target.item, target.duration);
  const keyframes = normalizeSceneKeyframes(item, target.defaults);
  const moving = keyframes.find((point) => Math.abs(point.time_sec - fromLocal) <= Math.max(0.04, frame));
  if (!moving || Math.abs(moving.time_sec - targetLocal) < 0.000001) return { changed: false, body };
  target.item.keyframes = [
    ...keyframes.filter((point) => point !== moving && Math.abs(point.time_sec - targetLocal) > Math.max(0.04, frame / 2)),
    { ...moving, time_sec: targetLocal },
  ].sort((left, right) => left.time_sec - right.time_sec);
  return { changed: true, body: next };
}

export function updateTimelineTransformAtTime(body, { kind, itemId, trackId, playheadSec, patch }) {
  if (!body || !patch || typeof patch !== "object") return { changed: false, body };
  const next = structuredClone(body);
  const target = transformKeyframeTarget(next, kind, itemId, trackId);
  if (!target.item) return { changed: false, body };
  const item = keyframeItem(target.item, target.duration);
  const existing = sceneKeyframeNearPlayhead(item, playheadSec, 0.04, target.defaults);
  if (!existing) {
    target.item.transform = { ...(target.defaults || {}), ...(target.item.transform || {}), ...patch };
    return { changed: true, body: next };
  }
  target.item.keyframes = normalizeSceneKeyframes(item, target.defaults).map((keyframe) => (
    Math.abs(keyframe.time_sec - existing.time_sec) <= 0.04
      ? { ...keyframe, transform: { ...keyframe.transform, ...patch } }
      : keyframe
  ));
  return { changed: true, body: next };
}

function motionPresetKeyframes(transform, duration, preset, defaults) {
  const base = normalizeSceneTransform(transform, defaults);
  const start = { ...base };
  const end = { ...base };
  if (preset === "pan_left") {
    start.x = Math.min(1, (Number(base.x) || 0) + 0.22);
    end.x = Math.max(0, (Number(base.x) || 0) - 0.22);
  } else if (preset === "pan_right") {
    start.x = Math.max(0, (Number(base.x) || 0) - 0.22);
    end.x = Math.min(1, (Number(base.x) || 0) + 0.22);
  } else if (preset === "zoom_in") {
    end.scale = Math.min(5, (Number(base.scale) || 1) * 1.25);
  } else if (preset === "zoom_out") {
    start.scale = Math.min(5, (Number(base.scale) || 1) * 1.25);
  } else {
    return null;
  }
  const normalizedDuration = Math.max(0.1, Number(duration) || 0.1);
  return [{ time_sec: 0, transform: start }, { time_sec: normalizedDuration, transform: end }];
}

export function applyTimelineMotionPreset(body, { kind, itemId, trackId, preset }) {
  if (!body) return { changed: false, body };
  const next = structuredClone(body);
  const target = transformKeyframeTarget(next, kind, itemId, trackId);
  if (!target.item) return { changed: false, body };
  const keyframes = motionPresetKeyframes(target.item.transform, target.duration, preset, target.defaults);
  if (!keyframes) return { changed: false, body };
  target.item.keyframes = keyframes;
  return { changed: true, body: next };
}

function audioKeyframeTarget(body, clipId, trackId) {
  const track = getTrack(body, trackId);
  const clip = (track?.clips || []).find((item) => String(item.id) === String(clipId));
  return { track, clip };
}

export function upsertTimelineAudioKeyframe(body, { clipId, trackId, playheadSec }) {
  if (!body) return { changed: false, body };
  const next = structuredClone(body);
  const { track, clip } = audioKeyframeTarget(next, clipId, trackId);
  if (!clip || track?.locked) return { changed: false, body };
  const duration = clipSourceDuration(clip);
  const local = Math.max(0, Math.min(duration, (Number(playheadSec) || 0) - (Number(clip.timeline_start) || 0)));
  clip.audio_keyframes = [
    ...normalizedAudioKeyframes(clip, duration).filter((keyframe) => Math.abs(keyframe.time_sec - local) > 0.04),
    { time_sec: local, volume: clipVolumeAt(clip, playheadSec, duration) },
  ].sort((left, right) => left.time_sec - right.time_sec);
  return { changed: true, body: next };
}

export function removeTimelineAudioKeyframe(body, { clipId, trackId, playheadSec }) {
  if (!body) return { changed: false, body };
  const next = structuredClone(body);
  const { track, clip } = audioKeyframeTarget(next, clipId, trackId);
  if (!clip || track?.locked) return { changed: false, body };
  const local = (Number(playheadSec) || 0) - (Number(clip.timeline_start) || 0);
  clip.audio_keyframes = normalizedAudioKeyframes(clip, clipSourceDuration(clip))
    .filter((keyframe) => Math.abs(keyframe.time_sec - local) > 0.04);
  return { changed: true, body: next };
}

export function moveTimelineAudioKeyframe(body, {
  clipId,
  trackId,
  fromPlayheadSec,
  toPlayheadSec,
}) {
  if (!body) return { changed: false, body };
  const next = structuredClone(body);
  const { track, clip } = audioKeyframeTarget(next, clipId, trackId);
  if (!clip || track?.locked) return { changed: false, body };
  const duration = clipSourceDuration(clip);
  const start = Number(clip.timeline_start) || 0;
  const frame = projectFrameStepSec(next);
  const fromLocal = (Number(fromPlayheadSec) || 0) - start;
  const targetLocal = Math.max(0, Math.min(duration, Math.round(((Number(toPlayheadSec) || 0) - start) / frame) * frame));
  const keyframes = normalizedAudioKeyframes(clip, duration);
  const moving = keyframes.find((point) => Math.abs(point.time_sec - fromLocal) <= Math.max(0.04, frame));
  if (!moving || Math.abs(moving.time_sec - targetLocal) < 0.000001) return { changed: false, body };
  clip.audio_keyframes = [
    ...keyframes.filter((point) => point !== moving && Math.abs(point.time_sec - targetLocal) > Math.max(0.04, frame / 2)),
    { ...moving, time_sec: targetLocal },
  ].sort((left, right) => left.time_sec - right.time_sec);
  return { changed: true, body: next };
}

export function updateTimelineVolumeAtTime(body, { clipId, trackId, playheadSec, volume }) {
  if (!body) return { changed: false, body };
  const next = structuredClone(body);
  const { track, clip } = audioKeyframeTarget(next, clipId, trackId);
  if (!clip || track?.locked) return { changed: false, body };
  const duration = clipSourceDuration(clip);
  const existing = audioKeyframeNearPlayhead(clip, playheadSec, 0.04, duration);
  const nextVolume = normalizedAudioVolume(volume, 0);
  if (!existing) clip.volume = nextVolume;
  else {
    clip.audio_keyframes = normalizedAudioKeyframes(clip, duration).map((keyframe) => (
      Math.abs(keyframe.time_sec - existing.time_sec) <= 0.04
        ? { ...keyframe, volume: nextVolume }
        : keyframe
    ));
  }
  return { changed: true, body: next };
}
