import { create } from "zustand";
import { useLiteCutEditorStore } from "../liteCutEditorStore.js";
import { useLiteCutHistoryStore } from "./historyStore.js";
import { keyframeNearPlayhead, normalizedOverlayKeyframes, normalizedOverlayTransform, overlayTransformAt, VIDEO_LAYER_TRANSFORM_DEFAULTS } from "./overlayKeyframeUtils.js";
import { audioKeyframeNearPlayhead, clipVolumeAt, normalizedAudioKeyframes } from "./audioKeyframeUtils.js";
import { clampTimelineZoom } from "./timelineZoomUtils.js";
import {
  buildAssetClip,
  buildDetachedAudioClip,
  buildRecordedClip,
  buildSubtitleOverlays,
  canDetachClipAudio,
  canPlaceOnTrack,
  canSplitOverlaysAtPlayhead,
  canSplitTrackClipsAtPlayhead,
  canTrimClipEndToPlayhead,
  canTrimClipStartToPlayhead,
  canTrimOverlayToPlayhead,
  clipMaxTimelineEnd,
  clipMaxTimelineStartForLeftTrim,
  clipSourceTimeForTimeline,
  cloneOverlayForPaste,
  cloneTimelineClipForPaste,
  clipSourceDuration,
  clipTimelineEnd,
  compactTrackGaps,
  findClipById,
  getTrack,
  isAssetMediaItem,
  markerNearTime,
  insertAudioTrack,
  insertClipIntoTrackWithRipple,
  insertOverlayWithRipple,
  newClipId,
  newMarkerId,
  newOverlayId,
  nextMarker,
  nextEditPoint,
  nextAppendStart,
  linkedTimelineClipIds,
  nudgeClipInTrack,
  slipClipInTrack,
  nudgeOverlayInList,
  ensureClipSourceDuration,
  overlayTimelineEnd,
  overlaysActiveAt,
  resizeOverlayDraft,
  rebaseTimelineClipKeyframes,
  trimClipEndDraft,
  trimClipStartDraft,
  rippleDeleteClipFromTrack,
  rippleDeleteOverlayFromList,
  canRemoveTrack,
  canMoveTrackById,
  canMoveTrackToId,
  moveTrackById,
  moveTrackToId,
  removeTrackById,
  insertVideoTrack,
  insertVideoTrackBefore,
  newVideoTrackId,
  renumberVideoTrackLabels,
  placeAssetOnVideoTrack,
  previousMarker,
  previousEditPoint,
  projectFrameStepSec,
  snapTimelineSec,
  sortClips,
  splitClipAt,
  splitOverlaysAtPlayhead,
  splitOverlayAt,
  splitTrackClipsAtPlayhead,
  timelineTotalSec,
  audioTracks,
  editableAudioTracks,
  editableVideoTracks,
  videoTracks,
} from "./timelineUtils.js";

function normalizedTransitionStyle(type, durationSec = 0.4) {
  const transitionType = String(type || "fade");
  if (transitionType === "cut" || transitionType === "none") return { type: "cut", duration_sec: 0 };
  return { type: transitionType, duration_sec: Math.max(0, Number(durationSec) || 0) };
}

function transitionsMatch(a, b) {
  const left = normalizedTransitionStyle(a?.type || "cut", a?.duration_sec ?? 0);
  const right = normalizedTransitionStyle(b?.type || "cut", b?.duration_sec ?? 0);
  return left.type === right.type && Math.abs(left.duration_sec - right.duration_sec) <= 1e-6;
}

function normalizedColorStyle(color = {}) {
  return {
    brightness: Math.max(-100, Math.min(100, Number(color?.brightness) || 0)),
    contrast: Math.max(-100, Math.min(100, Number(color?.contrast) || 0)),
    saturation: Math.max(-100, Math.min(100, Number(color?.saturation) || 0)),
    filter_preset: color?.filter_preset && color.filter_preset !== "none" ? String(color.filter_preset) : null,
  };
}

function colorsMatch(a, b) {
  const left = normalizedColorStyle(a);
  const right = normalizedColorStyle(b);
  return (
    left.brightness === right.brightness &&
    left.contrast === right.contrast &&
    left.saturation === right.saturation &&
    left.filter_preset === right.filter_preset
  );
}

function selectedEditableVideoContext(body, selectedClipId) {
  const { clip, trackId } = findClipById(body, selectedClipId);
  const track = getTrack(body, trackId);
  if (!clip || !track || track.type !== "video" || track.locked || track.hidden) return null;
  return { clip, track, trackId };
}

function videoStyleTargets(body, sourceTrackId, scope = "track") {
  const tracks =
    scope === "all"
      ? (body?.tracks || []).filter((track) => track.type === "video" && !track.locked && !track.hidden)
      : [getTrack(body, sourceTrackId)].filter((track) => track?.type === "video" && !track.locked && !track.hidden);
  return tracks.flatMap((track) => (track.clips || []).map((clip) => ({ clip, track })));
}

function uniqueIds(ids = []) {
  return [...new Set((ids || []).filter(Boolean).map(String))];
}

function activeSelectionIds(state) {
  return uniqueIds(state.selectedClipIds?.length ? state.selectedClipIds : state.selectedClipId ? [state.selectedClipId] : []);
}

function clipPatchForTrack(patch, track) {
  if (!patch || typeof patch !== "object") return {};
  if (track?.type === "video") return patch;
  const next = {};
  for (const [key, value] of Object.entries(patch)) {
    if (key === "canvas_fit" || key === "crop") continue;
    next[key] = value;
  }
  return next;
}

function timelineSelectionEntries(body, ids = []) {
  const wanted = new Set(uniqueIds(ids));
  if (!wanted.size) return [];
  const entries = [];
  for (const ov of body?.overlays || []) {
    if (wanted.has(String(ov.id))) {
      entries.push({
        id: ov.id,
        kind: "overlay",
        trackId: "overlay",
        item: ov,
        start: Number(ov.timeline_start) || 0,
        end: overlayTimelineEnd(ov),
      });
    }
  }
  for (const track of body?.tracks || []) {
    for (const clip of track.clips || []) {
      if (wanted.has(String(clip.id))) {
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
  }
  return entries.sort((a, b) => a.start - b.start || String(a.id).localeCompare(String(b.id)));
}

function linkedClipPairs(body) {
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

function timelineItemGroupId(item) {
  const id = item?.meta?.group_id;
  return typeof id === "string" && id ? id : null;
}

function groupedTimelineItemIds(body, itemId) {
  const target = (body?.overlays || []).find((item) => String(item.id) === String(itemId)) || findClipById(body, itemId).clip;
  const groupId = timelineItemGroupId(target);
  if (!groupId) return itemId ? [String(itemId)] : [];
  const ids = [];
  for (const overlay of body?.overlays || []) if (timelineItemGroupId(overlay) === groupId) ids.push(String(overlay.id));
  for (const track of body?.tracks || []) {
    for (const clip of track?.clips || []) if (timelineItemGroupId(clip) === groupId) ids.push(String(clip.id));
  }
  return uniqueIds(ids);
}

function relatedTimelineItemIds(body, itemId) {
  if (!itemId) return [];
  const resolved = new Set();
  const pending = [String(itemId)];
  while (pending.length) {
    const current = pending.shift();
    if (!current || resolved.has(current)) continue;
    resolved.add(current);
    for (const id of groupedTimelineItemIds(body, current)) {
      if (!resolved.has(String(id))) pending.push(String(id));
    }
    for (const id of linkedTimelineClipIds(body, current)) {
      if (!resolved.has(String(id))) pending.push(String(id));
    }
  }
  return [...resolved];
}

function motionPresetKeyframes(transform, duration, preset, defaults) {
  const base = normalizedOverlayTransform(transform, defaults);
  const start = { ...base };
  const end = { ...base };
  if (preset === "pan_left") {
    start.x = Math.min(1, base.x + 0.22);
    end.x = Math.max(0, base.x - 0.22);
  } else if (preset === "pan_right") {
    start.x = Math.max(0, base.x - 0.22);
    end.x = Math.min(1, base.x + 0.22);
  } else if (preset === "zoom_in") {
    end.scale = Math.min(4, base.scale * 1.25);
  } else if (preset === "zoom_out") {
    start.scale = Math.min(4, base.scale * 1.25);
  } else {
    return null;
  }
  const dur = Math.max(0.1, Number(duration) || 0.1);
  return [{ time_sec: 0, transform: start }, { time_sec: dur, transform: end }];
}

function clipCanSplitAt(body, clipId, playheadSec) {
  const { clip, trackId } = findClipById(body, clipId);
  const track = getTrack(body, trackId);
  if (!clip || !track || track.locked || track.hidden) return false;
  const local = playheadSec - (Number(clip.timeline_start) || 0);
  const duration = clipSourceDuration(clip);
  return local > 0.05 && local < duration - 0.05;
}

function linkedSplitSelection(body, selectedIds, playheadSec) {
  const selected = new Set(uniqueIds(selectedIds));
  for (const { videoId, audioId } of linkedClipPairs(body)) {
    if (!selected.has(videoId) && !selected.has(audioId)) continue;
    // A linked pair is only cut together when both sides can receive the same edit.
    if (clipCanSplitAt(body, videoId, playheadSec) && clipCanSplitAt(body, audioId, playheadSec)) {
      selected.add(videoId);
      selected.add(audioId);
    } else {
      selected.delete(videoId);
      selected.delete(audioId);
    }
  }
  return uniqueIds([...selected]);
}

function setLinkedClipPair(video, audio) {
  video.meta = { ...(video.meta || {}), linked_audio_clip_id: audio.id };
  audio.meta = { ...(audio.meta || {}), source_clip_id: video.id, detached_from_video: true };
}

function clearLinkedVideoClip(clip) {
  const { linked_audio_clip_id, ...meta } = clip.meta || {};
  clip.meta = meta;
}

function clearLinkedAudioClip(clip) {
  const { source_clip_id, ...meta } = clip.meta || {};
  clip.meta = meta;
}

function restoreLinksAfterSplit(body, pairs, rightIds = new Map()) {
  for (const { videoId, audioId } of pairs) {
    const videoRightId = rightIds.get(videoId);
    const audioRightId = rightIds.get(audioId);
    if (!videoRightId && !audioRightId) continue;

    const { clip: videoLeft } = findClipById(body, videoId);
    const { clip: audioLeft } = findClipById(body, audioId);
    if (videoLeft && audioLeft) setLinkedClipPair(videoLeft, audioLeft);

    const { clip: videoRight } = videoRightId ? findClipById(body, videoRightId) : { clip: null };
    const { clip: audioRight } = audioRightId ? findClipById(body, audioRightId) : { clip: null };
    if (videoRight) clearLinkedVideoClip(videoRight);
    if (audioRight) clearLinkedAudioClip(audioRight);
    if (videoRight && audioRight) setLinkedClipPair(videoRight, audioRight);
  }
}

function selectableTimelineEntries(body, predicate = null) {
  const entries = [];
  for (const track of body?.tracks || []) {
    if (track.locked || track.hidden) continue;
    for (const clip of track.clips || []) {
      if (!clip?.id) continue;
      const start = Math.max(0, Number(clip.timeline_start) || 0);
      const entry = {
        id: String(clip.id),
        kind: "clip",
        trackId: track.id || "v1",
        start,
        end: clipTimelineEnd(clip),
      };
      if (!predicate || predicate(entry)) entries.push(entry);
    }
  }
  for (const ov of body?.overlays || []) {
    if (!ov?.id) continue;
    const start = Math.max(0, Number(ov.timeline_start) || 0);
    const entry = {
      id: String(ov.id),
      kind: "overlay",
      trackId: "overlay",
      start,
      end: overlayTimelineEnd(ov),
    };
    if (!predicate || predicate(entry)) entries.push(entry);
  }
  return entries;
}

function canShiftTrackSelection(track, selectedIds, deltaSec) {
  if (!track || track.locked) return false;
  const ids = new Set(uniqueIds(selectedIds));
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

function selectedTrimTargets(body, selectedIds, side, playheadSec) {
  return timelineSelectionEntries(body, selectedIds).filter((entry) => {
    if (entry.kind === "overlay") return canTrimOverlayToPlayhead(entry.item, side, playheadSec);
    if (entry.locked || entry.hidden) return false;
    if (side === "start") return canTrimClipStartToPlayhead(entry.item, entry.trackType, playheadSec);
    if (side === "end") return canTrimClipEndToPlayhead(entry.item, entry.trackType, playheadSec);
    return false;
  });
}

function rippleDeleteTrackSelection(track, selectedIds) {
  if (!track || track.locked || track.hidden) return { deleted: false, clips: track?.clips || [] };
  const ids = new Set(uniqueIds(selectedIds));
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
      const shift = removed
        .filter((span) => start >= span.end - 1e-6)
        .reduce((sum, span) => sum + span.duration, 0);
      return shift > 0 ? { ...clip, timeline_start: Math.max(0, start - shift) } : clip;
    });
  return { deleted: true, clips: sortClips(kept) };
}

function rippleDeleteOverlaySelection(overlays, selectedIds) {
  const ids = new Set(uniqueIds(selectedIds));
  const removed = (overlays || [])
    .filter((ov) => ids.has(String(ov.id)))
    .map((ov) => ({
      id: ov.id,
      start: Number(ov.timeline_start) || 0,
      end: overlayTimelineEnd(ov),
      duration: Math.max(0.1, Number(ov.duration) || 0),
    }))
    .sort((a, b) => a.start - b.start);
  if (!removed.length) return { deleted: false, overlays: overlays || [] };
  const kept = (overlays || [])
    .filter((ov) => !ids.has(String(ov.id)))
    .map((ov) => {
      const start = Number(ov.timeline_start) || 0;
      const shift = removed
        .filter((span) => start >= span.end - 1e-6)
        .reduce((sum, span) => sum + span.duration, 0);
      return shift > 0 ? { ...ov, timeline_start: Math.max(0, start - shift) } : ov;
    })
    .sort((a, b) => (a.timeline_start || 0) - (b.timeline_start || 0));
  return { deleted: true, overlays: kept };
}

export const useLiteCutTimelineStore = create((set, get) => ({
  selectedClipId: null,
  selectedClipIds: [],
  selectedTrackId: "v1",
  selectedOverlayTrackId: "ot1",
  playheadSec: 0,
  lastUserSeekAt: 0,
  isPlaying: false,
  snapEnabled: true,
  timelineZoom: 1,
  timelineFocusRequestId: 0,
  clipboard: null,
  propertyEditActive: false,

  toggleSnap: () => set((s) => ({ snapEnabled: !s.snapEnabled })),
  setTimelineZoom: (z) =>
    set({ timelineZoom: clampTimelineZoom(z) }),
  requestTimelineFocus: () => set((s) => ({ timelineFocusRequestId: (Number(s.timelineFocusRequestId) || 0) + 1 })),

  setPlayhead: (sec) => set({ playheadSec: Math.max(0, Number(sec) || 0) }),
  seekPlayhead: (sec) => set({
    playheadSec: Math.max(0, Number(sec) || 0),
    lastUserSeekAt: Date.now(),
    isPlaying: false,
  }),
  setPlaying: (v) => set({ isPlaying: Boolean(v) }),
  togglePlay: () => set((s) => ({ isPlaying: !s.isPlaying })),

  beginPropertyEdit: () => {
    if (get().propertyEditActive) return false;
    const body = useLiteCutEditorStore.getState().body;
    if (!body) return false;
    useLiteCutHistoryStore.getState().push(body);
    set({ propertyEditActive: true });
    return true;
  },

  endPropertyEdit: () => set({ propertyEditActive: false }),

  setExportRange: (patch, { recordHistory = true } = {}) => {
    if (!patch || typeof patch !== "object") return false;
    const output = useLiteCutEditorStore.getState().body?.output || {};
    const keys = ["range_mode", "range_start_sec", "range_end_sec"];
    if (keys.every((key) => Object.is(output[key], patch[key]))) return false;
    get().mutateProject((body) => {
      body.output = { ...(body.output || {}), ...patch };
      return body;
    }, { recordHistory });
    return true;
  },

  jumpToPreviousEditPoint: () => {
    const body = useLiteCutEditorStore.getState().body;
    const target = previousEditPoint(body, get().playheadSec);
    if (target == null) return false;
    set({ playheadSec: target, isPlaying: false });
    return true;
  },

  jumpToNextEditPoint: () => {
    const body = useLiteCutEditorStore.getState().body;
    const target = nextEditPoint(body, get().playheadSec);
    if (target == null) return false;
    set({ playheadSec: target, isPlaying: false });
    return true;
  },

  addMarkerAtPlayhead: () => {
    const { playheadSec } = get();
    let newId = null;
    get().mutateProject((body) => {
      const marker = {
        id: newMarkerId(),
        time_sec: Math.max(0, Number(playheadSec) || 0),
        label: "",
        color: "#f59e0b",
      };
      body.markers = [...(body.markers || []), marker].sort((a, b) => (a.time_sec || 0) - (b.time_sec || 0));
      newId = marker.id;
      return body;
    });
    return newId;
  },

  updateMarker: (markerId, patch) => {
    if (!markerId || !patch || typeof patch !== "object") return false;
    const current = (useLiteCutEditorStore.getState().body?.markers || []).find((marker) => marker?.id === markerId);
    if (!current) return false;
    const nextLabel = patch.label == null ? String(current.label || "") : String(patch.label).slice(0, 80);
    const candidateColor = patch.color == null ? String(current.color || "#f59e0b") : String(patch.color);
    const nextColor = /^#[0-9a-f]{6}$/i.test(candidateColor) ? candidateColor : "#f59e0b";
    const nextTime = patch.time_sec == null ? Math.max(0, Number(current.time_sec) || 0) : Math.max(0, Number(patch.time_sec) || 0);
    if (nextLabel === String(current.label || "") && nextColor === String(current.color || "#f59e0b") && Math.abs(nextTime - (Number(current.time_sec) || 0)) < 0.0001) return false;
    get().mutateProject((body) => {
      const marker = (body.markers || []).find((item) => item?.id === markerId);
      if (!marker) return body;
      marker.label = nextLabel;
      marker.color = nextColor;
      marker.time_sec = nextTime;
      body.markers.sort((a, b) => (Number(a.time_sec) || 0) - (Number(b.time_sec) || 0));
      return body;
    });
    return true;
  },

  deleteMarker: (markerId) => {
    if (!markerId) return false;
    const body = useLiteCutEditorStore.getState().body;
    if (!(body?.markers || []).some((marker) => marker?.id === markerId)) return false;
    get().mutateProject((nextBody) => {
      nextBody.markers = (nextBody.markers || []).filter((marker) => marker?.id !== markerId);
      return nextBody;
    });
    return true;
  },

  deleteMarkerNearPlayhead: () => {
    const body = useLiteCutEditorStore.getState().body;
    const marker = markerNearTime(body, get().playheadSec);
    if (!marker?.id) return false;
    let deleted = false;
    get().mutateProject((nextBody) => {
      const before = nextBody.markers || [];
      nextBody.markers = before.filter((m) => m.id !== marker.id);
      deleted = nextBody.markers.length !== before.length;
      return nextBody;
    });
    return deleted;
  },

  jumpToPreviousMarker: () => {
    const body = useLiteCutEditorStore.getState().body;
    const marker = previousMarker(body, get().playheadSec);
    if (!marker) return false;
    set({ playheadSec: marker.time_sec, isPlaying: false });
    return true;
  },

  jumpToNextMarker: () => {
    const body = useLiteCutEditorStore.getState().body;
    const marker = nextMarker(body, get().playheadSec);
    if (!marker) return false;
    set({ playheadSec: marker.time_sec, isPlaying: false });
    return true;
  },

  nudgeSelectedBy: (deltaSec) => {
    const state = get();
    const selectedIds = activeSelectionIds(state);
    const { selectedClipId, selectedTrackId } = state;
    if (!selectedIds.length) return false;
    if (selectedIds.length > 1) {
      return get().moveSelectionBy(deltaSec);
    }
    const currentBody = useLiteCutEditorStore.getState().body;
    if (selectedTrackId === "overlay") {
      if (!nudgeOverlayInList(currentBody?.overlays || [], selectedClipId, deltaSec).moved) return false;
    } else {
      const { trackId } = findClipById(currentBody, selectedClipId);
      const track = getTrack(currentBody, trackId);
      if (!nudgeClipInTrack(track, selectedClipId, deltaSec).moved) return false;
    }
    let moved = false;
    get().mutateProject((body) => {
      if (selectedTrackId === "overlay") {
        const result = nudgeOverlayInList(body.overlays || [], selectedClipId, deltaSec);
        if (!result.moved) return body;
        body.overlays = result.overlays;
        moved = true;
        return body;
      }
      const { trackId } = findClipById(body, selectedClipId);
      const track = getTrack(body, trackId);
      const result = nudgeClipInTrack(track, selectedClipId, deltaSec);
      if (!result.moved) return body;
      track.clips = result.clips;
      moved = true;
      return body;
    });
    return moved;
  },

  nudgeSelectedFrame: (direction, large = false) => {
    const body = useLiteCutEditorStore.getState().body;
    const step = large ? 1 : projectFrameStepSec(body);
    return get().nudgeSelectedBy((Number(direction) < 0 ? -1 : 1) * step);
  },

  canSlipSelectedBy: (deltaSec) => {
    const state = get();
    if (state.selectedTrackId === "overlay" || activeSelectionIds(state).length !== 1 || !state.selectedClipId) return false;
    const body = useLiteCutEditorStore.getState().body;
    const { trackId } = findClipById(body, state.selectedClipId);
    return slipClipInTrack(getTrack(body, trackId), state.selectedClipId, deltaSec).moved;
  },

  slipSelectedBy: (deltaSec) => {
    if (!get().canSlipSelectedBy(deltaSec)) return false;
    const selectedClipId = get().selectedClipId;
    let slipped = false;
    get().mutateProject((body) => {
      const { trackId } = findClipById(body, selectedClipId);
      const track = getTrack(body, trackId);
      const result = slipClipInTrack(track, selectedClipId, deltaSec);
      if (!result.moved) return body;
      track.clips = result.clips;
      slipped = true;
      return body;
    });
    return slipped;
  },

  canSlipSelectedFrame: (direction, large = false) => {
    const body = useLiteCutEditorStore.getState().body;
    const step = large ? 1 : projectFrameStepSec(body);
    return get().canSlipSelectedBy((Number(direction) < 0 ? -1 : 1) * step);
  },

  slipSelectedFrame: (direction, large = false) => {
    const body = useLiteCutEditorStore.getState().body;
    const step = large ? 1 : projectFrameStepSec(body);
    return get().slipSelectedBy((Number(direction) < 0 ? -1 : 1) * step);
  },

  canMoveSelectionBy: (deltaSec) => {
    const selectedIds = activeSelectionIds(get());
    if (selectedIds.length <= 1) return false;
    const body = useLiteCutEditorStore.getState().body;
    const entries = timelineSelectionEntries(body, selectedIds);
    if (!entries.length) return false;
    if (entries.some((entry) => entry.locked || entry.hidden)) return false;
    const delta = Number(deltaSec) || 0;
    if (Math.abs(delta) <= 1e-6) return false;
    const minStart = Math.min(...entries.map((entry) => entry.start));
    if (minStart + delta < -1e-6) return false;
    const byTrack = new Map();
    for (const entry of entries.filter((entry) => entry.kind === "clip")) {
      if (!byTrack.has(entry.trackId)) byTrack.set(entry.trackId, []);
      byTrack.get(entry.trackId).push(entry.id);
    }
    for (const [trackId, ids] of byTrack.entries()) {
      if (!canShiftTrackSelection(getTrack(body, trackId), ids, delta)) return false;
    }
    return true;
  },

  moveSelectionBy: (deltaSec, { recordHistory = true } = {}) => {
    const selectedIds = activeSelectionIds(get());
    if (selectedIds.length <= 1 || !get().canMoveSelectionBy(deltaSec)) return false;
    const delta = Number(deltaSec) || 0;
    let moved = false;
    get().mutateProject((body) => {
      const idSet = new Set(selectedIds.map(String));
      body.overlays = (body.overlays || []).map((ov) =>
        idSet.has(String(ov.id)) ? { ...ov, timeline_start: (Number(ov.timeline_start) || 0) + delta } : ov,
      );
      for (const track of body.tracks || []) {
        if (track.locked) continue;
        track.clips = sortClips(
          (track.clips || []).map((clip) =>
            idSet.has(String(clip.id)) ? { ...clip, timeline_start: (Number(clip.timeline_start) || 0) + delta } : clip,
          ),
        );
      }
      moved = true;
      return body;
    }, { recordHistory });
    return moved;
  },

  selectClip: (clipId, trackId = "v1") => {
    const ids = relatedTimelineItemIds(useLiteCutEditorStore.getState().body, clipId);
    set({ selectedClipId: clipId, selectedClipIds: ids, selectedTrackId: trackId });
  },

  canGroupSelectedItems: () => activeSelectionIds(get()).length >= 2,

  groupSelectedItems: () => {
    const ids = activeSelectionIds(get());
    if (ids.length < 2) return false;
    const idSet = new Set(ids.map(String));
    const groupId = `grp-${crypto.randomUUID().slice(0, 12)}`;
    get().mutateProject((body) => {
      body.overlays = (body.overlays || []).map((overlay) =>
        idSet.has(String(overlay.id)) ? { ...overlay, meta: { ...(overlay.meta || {}), group_id: groupId } } : overlay,
      );
      for (const track of body.tracks || []) {
        track.clips = (track.clips || []).map((clip) =>
          idSet.has(String(clip.id)) ? { ...clip, meta: { ...(clip.meta || {}), group_id: groupId } } : clip,
        );
      }
      return body;
    });
    return true;
  },

  canUngroupSelectedItems: () => {
    const body = useLiteCutEditorStore.getState().body;
    return activeSelectionIds(get()).some((id) => groupedTimelineItemIds(body, id).length > 1);
  },

  ungroupSelectedItems: () => {
    const body = useLiteCutEditorStore.getState().body;
    const groupIds = new Set();
    for (const id of activeSelectionIds(get())) {
      const target = (body?.overlays || []).find((item) => String(item.id) === String(id)) || findClipById(body, id).clip;
      const groupId = timelineItemGroupId(target);
      if (groupId) groupIds.add(groupId);
    }
    if (!groupIds.size) return false;
    get().mutateProject((nextBody) => {
      const clearGroup = (item) => {
        if (!groupIds.has(timelineItemGroupId(item))) return item;
        const { group_id, ...meta } = item.meta || {};
        return { ...item, meta };
      };
      nextBody.overlays = (nextBody.overlays || []).map(clearGroup);
      for (const track of nextBody.tracks || []) track.clips = (track.clips || []).map(clearGroup);
      return nextBody;
    });
    return true;
  },

  canSelectLinkedClips: () => {
    const { selectedClipId, selectedTrackId } = get();
    if (!selectedClipId || selectedTrackId === "overlay") return false;
    return linkedTimelineClipIds(useLiteCutEditorStore.getState().body, selectedClipId).length > 1;
  },

  selectLinkedClips: () => {
    const { selectedClipId, selectedTrackId } = get();
    if (!selectedClipId || selectedTrackId === "overlay") return false;
    const ids = linkedTimelineClipIds(useLiteCutEditorStore.getState().body, selectedClipId);
    if (ids.length <= 1) return false;
    set({ selectedClipId, selectedClipIds: ids, selectedTrackId });
    return true;
  },

  canLinkSelectedClips: () => {
    const state = get();
    const ids = activeSelectionIds(state);
    if (ids.length !== 2 || state.selectedTrackId === "overlay") return false;
    const body = useLiteCutEditorStore.getState().body;
    const entries = ids.map((id) => {
      const found = findClipById(body, id);
      return { ...found, track: getTrack(body, found.trackId) };
    });
    const video = entries.find((entry) => entry.track?.type === "video");
    const audio = entries.find((entry) => entry.track?.type === "audio");
    if (!video?.clip || !audio?.clip || video.track.locked || audio.track.locked) return false;
    return linkedTimelineClipIds(body, video.clip.id).length <= 1 && linkedTimelineClipIds(body, audio.clip.id).length <= 1;
  },

  linkSelectedClips: () => {
    if (!get().canLinkSelectedClips()) return false;
    const ids = activeSelectionIds(get());
    let linked = false;
    get().mutateProject((body) => {
      const entries = ids.map((id) => {
        const found = findClipById(body, id);
        return { ...found, track: getTrack(body, found.trackId) };
      });
      const video = entries.find((entry) => entry.track?.type === "video");
      const audio = entries.find((entry) => entry.track?.type === "audio");
      if (!video?.clip || !audio?.clip) return body;
      video.clip.meta = { ...(video.clip.meta || {}), linked_audio_clip_id: audio.clip.id };
      audio.clip.meta = { ...(audio.clip.meta || {}), source_clip_id: video.clip.id, detached_from_video: true };
      linked = true;
      return body;
    });
    return linked;
  },

  canUnlinkSelectedClips: () => get().canSelectLinkedClips(),

  unlinkSelectedClips: () => {
    const { selectedClipId, selectedTrackId } = get();
    if (!selectedClipId || selectedTrackId === "overlay") return false;
    const body = useLiteCutEditorStore.getState().body;
    const { clip } = findClipById(body, selectedClipId);
    const sourceId = String(clip?.meta?.source_clip_id || clip?.id || "");
    const linkedIds = linkedTimelineClipIds(body, selectedClipId);
    if (!sourceId || linkedIds.length <= 1) return false;
    let changed = false;
    get().mutateProject((nextBody) => {
      for (const track of nextBody.tracks || []) {
        for (const candidate of track.clips || []) {
          if (String(candidate.id) === sourceId && candidate.meta?.linked_audio_clip_id) {
            const { linked_audio_clip_id, ...meta } = candidate.meta;
            candidate.meta = meta;
            changed = true;
          }
          if (String(candidate.meta?.source_clip_id || "") === sourceId) {
            const { source_clip_id, detached_from_video, ...meta } = candidate.meta || {};
            candidate.meta = meta;
            changed = true;
          }
        }
      }
      return nextBody;
    });
    return changed;
  },

  selectTrack: (trackId) => {
    const track = getTrack(useLiteCutEditorStore.getState().body, trackId);
    if (!track) return false;
    set({ selectedClipId: null, selectedClipIds: [], selectedTrackId: trackId });
    return true;
  },

  toggleClipSelection: (clipId, trackId = "v1") => {
    if (!clipId) return;
    set((state) => {
      const key = String(clipId);
      const current = new Set(activeSelectionIds(state));
      if (current.has(key)) current.delete(key);
      else current.add(key);
      const nextIds = uniqueIds([...current]);
      const nextPrimary = nextIds.includes(key) ? key : nextIds.at(-1) || null;
      const body = useLiteCutEditorStore.getState().body;
      const fallbackTrackId =
        nextPrimary && nextPrimary !== key
          ? (body?.overlays || []).some((ov) => ov.id === nextPrimary)
            ? "overlay"
            : findClipById(body, nextPrimary).trackId || trackId
          : trackId;
      return {
        selectedClipId: nextPrimary,
        selectedClipIds: nextIds,
        selectedTrackId: nextPrimary ? fallbackTrackId : state.selectedTrackId,
      };
    });
  },

  selectOverlay: (overlayId) => {
    const ids = relatedTimelineItemIds(useLiteCutEditorStore.getState().body, overlayId);
    set({ selectedClipId: overlayId, selectedClipIds: ids, selectedTrackId: "overlay" });
  },

  toggleOverlaySelection: (overlayId) => {
    get().toggleClipSelection(overlayId, "overlay");
  },

  selectClipIds: (ids = [], primaryId = null, trackId = "v1") => {
    const nextIds = uniqueIds(ids);
    const nextPrimary = primaryId && nextIds.includes(String(primaryId)) ? String(primaryId) : nextIds.at(-1) || null;
    set({
      selectedClipId: nextPrimary,
      selectedClipIds: nextIds,
      selectedTrackId: nextPrimary ? trackId : get().selectedTrackId,
    });
  },

  selectAllTimelineItems: () => {
    const body = useLiteCutEditorStore.getState().body;
    const entries = selectableTimelineEntries(body);
    const ids = entries.map((entry) => entry.id);
    const primaryId = entries[0]?.id || null;
    const primaryTrackId = entries[0]?.trackId || "v1";
    const nextIds = uniqueIds(ids);
    if (!nextIds.length) {
      set({ selectedClipId: null, selectedClipIds: [] });
      return false;
    }
    set({ selectedClipId: primaryId, selectedClipIds: nextIds, selectedTrackId: primaryTrackId });
    return true;
  },

  selectTimelineItemsFromPlayhead: (direction = "right") => {
    const body = useLiteCutEditorStore.getState().body;
    const t = Math.max(0, Number(get().playheadSec) || 0);
    const epsilon = 1e-6;
    const entries = selectableTimelineEntries(body, (entry) =>
      direction === "left" ? entry.start < t - epsilon : entry.end > t + epsilon,
    );
    const ids = entries.map((entry) => entry.id);
    const primaryId = entries[0]?.id || null;
    const primaryTrackId = entries[0]?.trackId || "v1";
    const nextIds = uniqueIds(ids);
    if (!nextIds.length) {
      set({ selectedClipId: null, selectedClipIds: [] });
      return false;
    }
    set({ selectedClipId: primaryId, selectedClipIds: nextIds, selectedTrackId: primaryTrackId });
    return true;
  },

  selectTimelineItemsRelativeToClip: (clipId, direction = "right") => {
    const body = useLiteCutEditorStore.getState().body;
    const anchor = selectableTimelineEntries(body).find((entry) => String(entry.id) === String(clipId));
    if (!anchor) return false;
    const boundary = anchor.end;
    const epsilon = 1e-6;
    const entries = selectableTimelineEntries(body, (entry) => (
      direction === "left"
        ? entry.start < boundary - epsilon
        : entry.start >= boundary - epsilon
    ));
    const ids = entries.map((entry) => entry.id);
    const primaryId = entries[0]?.id || null;
    const primaryTrackId = entries[0]?.trackId || "v1";
    const nextIds = uniqueIds(ids);
    if (!nextIds.length) {
      set({ selectedClipId: null, selectedClipIds: [] });
      return false;
    }
    set({ selectedClipId: primaryId, selectedClipIds: nextIds, selectedTrackId: primaryTrackId });
    return true;
  },

  clearSelection: () => set({ selectedClipId: null, selectedClipIds: [] }),

  mutateProject: (mutator, { recordHistory = true } = {}) => {
    const editor = useLiteCutEditorStore.getState();
    const { body } = editor;
    if (!body) return null;
    if (recordHistory) useLiteCutHistoryStore.getState().push(body);
    const next = mutator(structuredClone(body));
    useLiteCutEditorStore.setState({ body: next, dirty: true });
    return next;
  },

  undo: () => {
    const editor = useLiteCutEditorStore.getState();
    const prev = useLiteCutHistoryStore.getState().undo(editor.body);
    if (prev) useLiteCutEditorStore.setState({ body: prev, dirty: true });
  },

  redo: () => {
    const editor = useLiteCutEditorStore.getState();
    const next = useLiteCutHistoryStore.getState().redo(editor.body);
    if (next) useLiteCutEditorStore.setState({ body: next, dirty: true });
  },

  addMediaToTrack: (mediaItem, trackId = "v1", atTime = null) => {
    if (!mediaItem) return;
    const isAsset = isAssetMediaItem(mediaItem);
    if (!isAsset && mediaItem?.id == null) return;
    const start =
      atTime != null
        ? Math.max(0, Number(atTime) || 0)
        : nextAppendStart(getTrack(useLiteCutEditorStore.getState().body, trackId)?.clips);
    return get().addMediaAtTime(mediaItem, trackId, start);
  },

  addFromMediaBin: (mediaItem) => {
    if (!mediaItem) return;
    const { playheadSec } = get();
    if (isAssetMediaItem(mediaItem)) {
      const kind = mediaItem.kind || "image";
      if (kind === "audio") {
        const body = useLiteCutEditorStore.getState().body;
        const targetId = editableAudioTracks(body)[0]?.id;
        if (!targetId) return;
        return get().addMediaAtTime(mediaItem, targetId, playheadSec);
      }
      if (kind === "video") {
        const body = useLiteCutEditorStore.getState().body;
        const mainId = editableVideoTracks(body)[0]?.id;
        if (!mainId) return;
        return get().addMediaToTrack(mediaItem, mainId);
      }
      return get().addOverlayFromAsset(mediaItem, { x: 0.5, y: 0.5, atTime: playheadSec });
    }
    const body = useLiteCutEditorStore.getState().body;
    const mainId = editableVideoTracks(body)[0]?.id;
    if (!mainId) return;
    return get().addMediaToTrack(mediaItem, mainId);
  },

  migrateAlphaMovOverlaysToVideoTracks: (assets) => {
    const alphaAssets = new Map(
      (assets || [])
        .filter((asset) => asset?.kind === "video" && asset?.has_alpha)
        .map((asset) => [Number(asset.id), asset]),
    );
    if (!alphaAssets.size) return 0;
    const currentBody = useLiteCutEditorStore.getState().body;
    const candidates = (currentBody?.overlays || []).filter((overlay) => alphaAssets.has(Number(overlay?.meta?.asset_id)));
    if (!candidates.length) return 0;
    get().mutateProject((body) => {
      let target = (body.tracks || []).find((track) => track.type === "video" && track.name === "透明视频轨");
      if (!target) {
        const baseTrack = (body.tracks || []).find((track) => track.type === "video");
        const targetId = baseTrack ? insertVideoTrackBefore(body, baseTrack.id) : insertVideoTrack(body, null);
        target = getTrack(body, targetId);
        if (target) target.name = "透明视频轨";
      }
      if (!target) return body;
      const candidateIds = new Set(candidates.map((overlay) => String(overlay.id)));
      for (const overlay of candidates) {
        const asset = alphaAssets.get(Number(overlay.meta?.asset_id));
        const clip = buildAssetClip(asset, Number(overlay.timeline_start) || 0);
        clip.trim_in = Math.max(0, Number(overlay.trim_in) || 0);
        clip.trim_out = clip.trim_in + Math.max(0.1, Number(overlay.duration) || Number(asset.duration_sec) || 3);
        clip.transform = overlay.transform ? { ...overlay.transform } : { ...VIDEO_LAYER_TRANSFORM_DEFAULTS };
        clip.keyframes = Array.isArray(overlay.keyframes) ? overlay.keyframes : [];
        clip.flip_horizontal = Boolean(overlay.flip_horizontal);
        clip.flip_vertical = Boolean(overlay.flip_vertical);
        clip.transition_in = overlay.transition_in || null;
        clip.transition_out = overlay.transition_out || null;
        clip.fade_in_sec = Number(overlay.fade_in_sec) || 0;
        clip.fade_out_sec = Number(overlay.fade_out_sec) || 0;
        target.clips.push(clip);
      }
      target.clips = sortClips(target.clips);
      body.overlays = (body.overlays || []).filter((overlay) => !candidateIds.has(String(overlay.id)));
      return body;
    }, { recordHistory: false });
    return candidates.length;
  },

  replaceSelectedClipSource: (mediaItem) => {
    if (!mediaItem) return false;
    const { selectedClipId, selectedTrackId } = get();
    const editor = useLiteCutEditorStore.getState();
    const track = getTrack(editor.body, selectedTrackId);
    const current = (track?.clips || []).find((clip) => clip.id === selectedClipId);
    const isAsset = isAssetMediaItem(mediaItem);
    const mediaIsAudio = isAsset && mediaItem.kind === "audio";
    const targetIsAudio = track?.type === "audio";
    if (!current || !track || (targetIsAudio !== mediaIsAudio) || (!isAsset && targetIsAudio)) return false;

    let replaced = false;
    get().mutateProject((body) => {
      const targetTrack = getTrack(body, selectedTrackId);
      const index = targetTrack?.clips?.findIndex((clip) => clip.id === selectedClipId) ?? -1;
      if (index < 0) return body;
      const old = targetTrack.clips[index];
      const source = isAsset ? buildAssetClip(mediaItem, old.timeline_start) : buildRecordedClip(mediaItem, old.timeline_start);
      const oldSourceDuration = Math.max(0.1, Number(old.trim_out) - (Number(old.trim_in) || 0) || clipSourceDuration(old));
      const newSourceDuration = Math.max(0.1, clipSourceDuration(source));
      targetTrack.clips[index] = {
        ...old,
        source_type: source.source_type,
        source_id: source.source_id,
        file_path: source.file_path,
        trim_in: 0,
        trim_out: Math.min(oldSourceDuration, newSourceDuration),
        speed_keyframes: [],
        meta: source.meta,
      };
      replaced = true;
      return body;
    });
    return replaced;
  },

  addMediaAtTime: (mediaItem, trackId, atTime, { createBelow = false, createAbove = false, createNewTrack = false } = {}) => {
    if (!mediaItem) return;
    const isAsset = isAssetMediaItem(mediaItem);
    if (isAsset) {
      const kind = mediaItem.kind || "image";
      if (kind === "video") {
        // Uploaded videos are first-class timeline clips; stickers/images stay overlays.
      } else if (kind !== "audio") {
        return get().addOverlayFromAsset(mediaItem, {
          x: 0.5,
          y: 0.5,
          atTime: atTime ?? get().playheadSec,
          overlayTrackId: String(trackId || "").startsWith("ot") ? trackId : null,
        });
      }
    }
    if (!isAsset && mediaItem?.id == null) return;
    const { playheadSec, snapEnabled } = get();
    const editor = useLiteCutEditorStore.getState();
    let start = Math.max(0, Number(atTime ?? playheadSec) || 0);
    start = snapTimelineSec(start, editor.body, { enabled: snapEnabled });
    let newId = null;
    let placedTrackId = trackId;
    get().mutateProject((body) => {
      const clip = isAsset ? buildAssetClip(mediaItem, start) : buildRecordedClip(mediaItem, start);
      const dur = clipSourceDuration(clip);
      let targetTrackId = trackId || videoTracks(body)[0]?.id || "v1";
      const isAudioAsset = isAsset && (mediaItem.kind || "") === "audio";
      if (isAudioAsset) {
        targetTrackId = trackId || audioTracks(body)[0]?.id || "a1";
      }

      if (createNewTrack) {
        if (isAudioAsset) {
          targetTrackId = insertAudioTrack(body, targetTrackId);
        } else if (createAbove && targetTrackId) {
          targetTrackId = insertVideoTrackBefore(body, targetTrackId);
        } else if (createBelow && targetTrackId) {
          targetTrackId = insertVideoTrack(body, targetTrackId);
        } else {
          targetTrackId = insertVideoTrack(body, targetTrackId);
        }
      }

      let track = getTrack(body, targetTrackId);
      if (!track || (isAudioAsset ? track.type !== "audio" : track.type !== "video")) return body;
      if (track.locked) return body;
      if (!canPlaceOnTrack(track.clips, start, dur)) {
        if (createNewTrack) {
          targetTrackId = isAudioAsset ? insertAudioTrack(body, targetTrackId) : insertVideoTrack(body, targetTrackId);
          track = getTrack(body, targetTrackId);
          if (!track) return body;
        } else {
          start = nextAppendStart(track.clips);
          clip.timeline_start = start;
        }
      }
      track.clips = sortClips([...(track.clips || []), clip]);
      placedTrackId = targetTrackId;
      newId = clip.id;
      return body;
    });
    if (newId) set({ selectedClipId: newId, selectedClipIds: [newId], selectedTrackId: placedTrackId });
  },

  addOverlayFromAsset: (assetItem, { x = 0.5, y = 0.5, atTime = null, overlayTrackId = null } = {}) => {
    if (!assetItem?.path && !assetItem?.file_path) return;
    const { playheadSec, snapEnabled } = get();
    const editor = useLiteCutEditorStore.getState();
    let start = Math.max(0, Number(atTime ?? playheadSec) || 0);
    start = snapTimelineSec(start, editor.body, { enabled: snapEnabled });
    const dur =
      Number(assetItem.duration_sec) > 0
        ? Number(assetItem.duration_sec)
        : assetItem.kind === "image"
          ? 3
          : 5;
    const path = assetItem.path || assetItem.file_path;
    const kind = assetItem.kind || "image";
    const outputWidth = Math.max(1, Number(get().body?.output?.width) || 1920);
    const outputHeight = Math.max(1, Number(get().body?.output?.height) || 1080);
    const sourceWidth = Math.max(0, Number(assetItem.width) || 0);
    const sourceHeight = Math.max(0, Number(assetItem.height) || 0);
    const nativeWidth = kind === "image" && sourceWidth > 0 ? sourceWidth / outputWidth : 0.33;
    const nativeHeight = kind === "image" && sourceHeight > 0 ? sourceHeight / outputHeight : 0.33;
    const isLoopingAnimation = kind === "video" && /\.gif$/i.test(String(assetItem.name || path));
    const overlayDur = dur;
    let newId = null;
    get().mutateProject((body) => {
      const ov = {
        id: newOverlayId(),
        type: kind === "webm" || kind === "video" ? "webm" : "sticker",
        timeline_start: start,
        duration: overlayDur,
        fade_in_sec: 0,
        fade_out_sec: 0,
        transform: { x, y, scale: 1, rotation: 0, width: nativeWidth, height: nativeHeight, opacity: 1 },
        asset_path: path,
        meta: { asset_id: assetItem.id, name: assetItem.name, kind, duration_sec: dur, source_width: sourceWidth || null, source_height: sourceHeight || null, source_fps: Number(assetItem.fps) || null, codec_name: assetItem.codec_name || null, preview_proxy_version: assetItem.preview_proxy_version || null, has_alpha: Boolean(assetItem.has_alpha), is_looping_animation: isLoopingAnimation, overlay_track_id: overlayTrackId || get().selectedOverlayTrackId || "ot1" },
      };
      body.overlays = [...(body.overlays || []), ov];
      newId = ov.id;
      return body;
    });
    if (newId) {
      set({ selectedClipId: newId, selectedClipIds: [newId], selectedTrackId: "overlay" });
    }
  },

  addTextOverlay: ({
    text = "CLUTCH",
    presetId = "clutch",
    atTime = null,
    x = 0.5,
    y = 0.22,
    fontFamily = "微软雅黑",
    fontFile = null,
    fontSize = 64,
    overlayTrackId = null,
  } = {}) => {
    const { playheadSec, snapEnabled } = get();
    const editor = useLiteCutEditorStore.getState();
    let start = Math.max(0, Number(atTime ?? playheadSec) || 0);
    start = snapTimelineSec(start, editor.body, { enabled: snapEnabled });
    let newId = null;
    const content = String(text || "Text").slice(0, 160);
    get().mutateProject((body) => {
      const ov = {
        id: newOverlayId(),
        type: "text",
        timeline_start: start,
        duration: 3,
        fade_in_sec: 0,
        fade_out_sec: 0,
        transform: { x, y, scale: 1, rotation: 0, width: 0.65, height: 0.18, opacity: 1 },
        text: {
          content,
          font_family: fontFamily || "微软雅黑",
          font_file: fontFile || null,
          font_size: Math.max(12, Math.min(220, Number(fontSize) || 64)),
          preset_id: presetId,
          anim_in: null,
          anim_out: null,
        },
        meta: { name: content, kind: "text", textStyleId: presetId, overlay_track_id: overlayTrackId || get().selectedOverlayTrackId || "ot1" },
      };
      body.overlays = [...(body.overlays || []), ov];
      newId = ov.id;
      return body;
    });
    if (newId) set({ selectedClipId: newId, selectedClipIds: [newId], selectedTrackId: "overlay" });
  },

  addSubtitleOverlays: (rawText, options = {}) => {
    const overlays = buildSubtitleOverlays(rawText, options);
    if (!overlays.length) return 0;
    get().mutateProject((body) => {
      body.overlays = [...(body.overlays || []), ...overlays];
      return body;
    });
    set({ selectedClipId: overlays[0].id, selectedClipIds: [overlays[0].id], selectedTrackId: "overlay" });
    return overlays.length;
  },

  applyTextPatchToSubtitles: (patch) => {
    const safePatch = patch && typeof patch === "object" ? patch : {};
    if (!Object.keys(safePatch).length) return 0;
    let count = 0;
    get().mutateProject((body) => {
      for (const overlay of body.overlays || []) {
        if (overlay?.type !== "text" || !overlay?.meta?.subtitle) continue;
        overlay.text = { ...(overlay.text || {}), ...safePatch };
        if (safePatch.preset_id != null) {
          overlay.meta = { ...(overlay.meta || {}), textStyleId: safePatch.preset_id };
        }
        count += 1;
      }
      return body;
    });
    return count;
  },

  addVideoTrack: (afterTrackId = null) => {
    let newId = null;
    get().mutateProject((body) => {
      newId = insertVideoTrack(body, afterTrackId);
      return body;
    });
    if (newId) set({ selectedClipId: null, selectedClipIds: [], selectedTrackId: newId });
    return newId;
  },

  addAudioTrack: (afterTrackId = null) => {
    let newId = null;
    get().mutateProject((body) => {
      newId = insertAudioTrack(body, afterTrackId);
      return body;
    });
    if (newId) set({ selectedClipId: null, selectedClipIds: [], selectedTrackId: newId });
    return newId;
  },

  selectOverlayTrack: (trackId) => set({ selectedOverlayTrackId: trackId || "ot1", selectedClipId: null, selectedClipIds: [] }),

  addOverlayTrack: () => {
    const id = `ot-${crypto.randomUUID().slice(0, 8)}`;
    get().mutateProject((body) => {
      const tracks = Array.isArray(body.overlay_tracks) && body.overlay_tracks.length ? body.overlay_tracks : [{ id: "ot1", label: "文字轨1" }];
      body.overlay_tracks = [...tracks, { id, label: `文字轨${tracks.length + 1}` }];
      return body;
    });
    set({ selectedOverlayTrackId: id, selectedClipId: null, selectedClipIds: [] });
    return id;
  },

  moveOverlayTrack: (trackId, direction) => {
    let moved = false;
    get().mutateProject((body) => {
      const tracks = [...(body.overlay_tracks || [{ id: "ot1", label: "文字轨1" }])];
      const index = tracks.findIndex((track) => track.id === trackId);
      const target = index + (direction === "up" ? -1 : 1);
      if (index < 0 || target < 0 || target >= tracks.length) return body;
      [tracks[index], tracks[target]] = [tracks[target], tracks[index]];
      body.overlay_tracks = tracks;
      moved = true;
      return body;
    });
    return moved;
  },

  canRemoveTrack: (trackId) => {
    const body = useLiteCutEditorStore.getState().body;
    const overlayTracks = Array.isArray(body?.overlay_tracks) ? body.overlay_tracks : [];
    const overlayTrack = overlayTracks.find((track) => String(track.id) === String(trackId));
    if (overlayTrack) {
      const hasContent = (body?.overlays || []).some((overlay) => String(overlay?.meta?.overlay_track_id || "ot1") === String(trackId));
      return overlayTracks.length > 1 && !overlayTrack.locked && !hasContent;
    }
    return canRemoveTrack(body, trackId);
  },

  canCompactSelectedTrackGaps: () => {
    const { selectedTrackId } = get();
    if (!selectedTrackId || selectedTrackId === "overlay") return false;
    const track = getTrack(useLiteCutEditorStore.getState().body, selectedTrackId);
    if (!track || track.locked || (track.clips || []).length < 2) return false;
    return compactTrackGaps(track).changed;
  },

  compactSelectedTrackGaps: () => {
    if (!get().canCompactSelectedTrackGaps()) return false;
    const { selectedTrackId } = get();
    let changed = false;
    get().mutateProject((body) => {
      const track = getTrack(body, selectedTrackId);
      if (!track || track.locked) return body;
      const result = compactTrackGaps(track);
      if (!result.changed) return body;
      track.clips = result.clips;
      changed = true;
      return body;
    });
    return changed;
  },

  canDetachSelectedAudio: () => {
    const { selectedClipId, selectedTrackId } = get();
    if (!selectedClipId || selectedTrackId === "overlay") return false;
    const body = useLiteCutEditorStore.getState().body;
    const { clip, trackId } = findClipById(body, selectedClipId);
    const track = getTrack(body, trackId);
    return Boolean(clip && track && !track.locked && canDetachClipAudio(clip, track.type));
  },

  detachSelectedAudio: () => {
    if (!get().canDetachSelectedAudio()) return false;
    const { selectedClipId } = get();
    let newId = null;
    let targetTrackId = null;
    get().mutateProject((body) => {
      const { clip, trackId } = findClipById(body, selectedClipId);
      const sourceTrack = getTrack(body, trackId);
      if (!clip || !sourceTrack || sourceTrack.locked || !canDetachClipAudio(clip, sourceTrack.type)) return body;
      const audioClip = buildDetachedAudioClip(clip);
      if (!audioClip) return body;
      const duration = clipSourceDuration(audioClip);
      let target = editableAudioTracks(body).find((track) =>
        canPlaceOnTrack(track.clips, audioClip.timeline_start, duration),
      );
      if (!target) {
        const lastAudioId = audioTracks(body).at(-1)?.id || null;
        targetTrackId = insertAudioTrack(body, lastAudioId);
        target = getTrack(body, targetTrackId);
      }
      if (!target || target.locked || !canPlaceOnTrack(target.clips, audioClip.timeline_start, duration)) return body;
      target.clips = sortClips([...(target.clips || []), audioClip]);
      clip.meta = { ...(clip.meta || {}), linked_audio_clip_id: audioClip.id };
      clip.muted = true;
      newId = audioClip.id;
      targetTrackId = target.id;
      return body;
    });
    if (newId && targetTrackId) {
      const relatedIds = relatedTimelineItemIds(useLiteCutEditorStore.getState().body, newId);
      set({ selectedClipId: newId, selectedClipIds: relatedIds, selectedTrackId: targetTrackId });
      return true;
    }
    return false;
  },

  removeTrack: (trackId) => {
    const currentBody = useLiteCutEditorStore.getState().body;
    const overlayTracks = Array.isArray(currentBody?.overlay_tracks) ? currentBody.overlay_tracks : [];
    const overlayTrack = overlayTracks.find((track) => String(track.id) === String(trackId));
    if (overlayTrack) {
      const hasContent = (currentBody?.overlays || []).some((overlay) => String(overlay?.meta?.overlay_track_id || "ot1") === String(trackId));
      if (overlayTracks.length <= 1 || overlayTrack.locked || hasContent) return false;
      get().mutateProject((body) => {
        body.overlay_tracks = (body.overlay_tracks || []).filter((track) => String(track.id) !== String(trackId));
        return body;
      });
      if (String(get().selectedOverlayTrackId) === String(trackId)) {
        set({ selectedOverlayTrackId: String(overlayTracks.find((track) => String(track.id) !== String(trackId))?.id || "ot1") });
      }
      return true;
    }
    if (!canRemoveTrack(currentBody, trackId)) return false;
    let removed = false;
    get().mutateProject((body) => {
      removed = removeTrackById(body, trackId);
      return body;
    });
    if (removed && get().selectedTrackId === trackId) {
      set({ selectedClipId: null, selectedClipIds: [], selectedTrackId: "v1" });
    }
    return removed;
  },

  canMoveTrack: (trackId, direction) => canMoveTrackById(useLiteCutEditorStore.getState().body, trackId, direction),

  moveTrack: (trackId, direction) => {
    const body = useLiteCutEditorStore.getState().body;
    if (!canMoveTrackById(body, trackId, direction)) return false;
    let moved = false;
    get().mutateProject((nextBody) => {
      moved = moveTrackById(nextBody, trackId, direction);
      return nextBody;
    });
    return moved;
  },

  canMoveTrackTo: (trackId, targetTrackId, position) =>
    canMoveTrackToId(useLiteCutEditorStore.getState().body, trackId, targetTrackId, position),

  moveTrackTo: (trackId, targetTrackId, position) => {
    const body = useLiteCutEditorStore.getState().body;
    if (!canMoveTrackToId(body, trackId, targetTrackId, position)) return false;
    let moved = false;
    get().mutateProject((nextBody) => {
      moved = moveTrackToId(nextBody, trackId, targetTrackId, position);
      return nextBody;
    });
    return moved;
  },

  updateTrack: (trackId, patch, { recordHistory = true } = {}) => {
    if (!trackId || !patch) return;
    get().mutateProject((body) => {
      const track = getTrack(body, trackId);
      if (!track) return body;
      Object.assign(track, patch);
      return body;
    }, { recordHistory });
  },

  renameTrack: (trackId, name) => {
    const track = getTrack(useLiteCutEditorStore.getState().body, trackId);
    if (!track || track.type === "overlay") return false;
    const normalized = String(name || "").trim().replace(/\s+/g, " ").slice(0, 60) || null;
    if (Object.is(track.name || null, normalized)) return false;
    get().mutateProject((body) => {
      const target = getTrack(body, trackId);
      if (!target || target.type === "overlay") return body;
      target.name = normalized;
      return body;
    });
    return true;
  },

  toggleTrackLocked: (trackId) => {
    get().mutateProject((body) => {
      const track = getTrack(body, trackId);
      if (track) {
        track.locked = !track.locked;
        return body;
      }
      const overlayTrack = (body.overlay_tracks || []).find((item) => String(item.id) === String(trackId));
      if (overlayTrack) overlayTrack.locked = !overlayTrack.locked;
      return body;
    });
  },

  toggleTrackHidden: (trackId) => {
    get().mutateProject((body) => {
      const track = getTrack(body, trackId);
      if (track) {
        track.hidden = !track.hidden;
        return body;
      }
      const overlayTrack = (body.overlay_tracks || []).find((item) => String(item.id) === String(trackId));
      if (overlayTrack) overlayTrack.hidden = !overlayTrack.hidden;
      return body;
    });
  },

  toggleTrackMuted: (trackId) => {
    get().mutateProject((body) => {
      const track = getTrack(body, trackId);
      if (!track) return body;
      track.muted = !track.muted;
      return body;
    });
  },

  toggleTrackSolo: (trackId) => {
    const track = getTrack(useLiteCutEditorStore.getState().body, trackId);
    if (!track || track.type !== "audio") return false;
    get().mutateProject((body) => {
      const target = getTrack(body, trackId);
      if (!target || target.type !== "audio") return body;
      target.solo = !target.solo;
      return body;
    });
    return true;
  },

  deleteSelected: () => {
    const state = get();
    const selectedIds = activeSelectionIds(state);
    const { selectedClipId, selectedTrackId } = state;
    if (!selectedIds.length) return;
    get().mutateProject((body) => {
      if (selectedIds.length > 1) {
        const idSet = new Set(selectedIds.map(String));
        body.overlays = (body.overlays || []).filter((o) => !idSet.has(String(o.id)));
        for (const track of body.tracks || []) {
          if (track.locked) continue;
          track.clips = (track.clips || []).filter((c) => !idSet.has(String(c.id)));
        }
        return body;
      }
      if (selectedTrackId === "overlay") {
        body.overlays = (body.overlays || []).filter((o) => o.id !== selectedClipId);
        return body;
      }
      const selectedTrack = getTrack(body, selectedTrackId);
      if (selectedTrack?.locked) return body;
      for (const track of body.tracks || []) {
        track.clips = (track.clips || []).filter((c) => c.id !== selectedClipId);
      }
      return body;
    });
    set({ selectedClipId: null, selectedClipIds: [] });
  },

  canRippleDeleteSelected: () => {
    const state = get();
    const selectedIds = activeSelectionIds(state);
    const { selectedClipId, selectedTrackId } = state;
    if (!selectedClipId) return false;
    if (selectedIds.length > 1) {
      const body = useLiteCutEditorStore.getState().body;
      return timelineSelectionEntries(body, selectedIds).some((entry) => entry.kind === "overlay" || (!entry.locked && !entry.hidden));
    }
    if (selectedTrackId === "overlay") return true;
    const body = useLiteCutEditorStore.getState().body;
    const { clip, trackId } = findClipById(body, selectedClipId);
    const track = getTrack(body, trackId);
    return Boolean(clip && track && !track.locked);
  },

  rippleDeleteSelected: () => {
    if (!get().canRippleDeleteSelected()) return false;
    const state = get();
    const selectedIds = activeSelectionIds(state);
    const { selectedClipId, selectedTrackId } = state;
    let deleted = false;
    get().mutateProject((body) => {
      if (selectedIds.length > 1) {
        const overlayResult = rippleDeleteOverlaySelection(body.overlays || [], selectedIds);
        if (overlayResult.deleted) {
          body.overlays = overlayResult.overlays;
          deleted = true;
        }
        for (const track of body.tracks || []) {
          const result = rippleDeleteTrackSelection(track, selectedIds);
          if (!result.deleted) continue;
          track.clips = result.clips;
          deleted = true;
        }
        return body;
      }
      if (selectedTrackId === "overlay") {
        const result = rippleDeleteOverlayFromList(body.overlays || [], selectedClipId);
        if (!result.deleted) return body;
        body.overlays = result.overlays;
        deleted = true;
        return body;
      }
      const { trackId } = findClipById(body, selectedClipId);
      const track = getTrack(body, trackId);
      if (!track || track.locked) return body;
      const result = rippleDeleteClipFromTrack(track, selectedClipId);
      if (!result.deleted) return body;
      track.clips = result.clips;
      deleted = true;
      return body;
    });
    if (deleted) set({ selectedClipId: null, selectedClipIds: [] });
    return deleted;
  },

  copySelected: () => {
    const state = get();
    const selectedIds = activeSelectionIds(state);
    const { selectedClipId, selectedTrackId } = state;
    if (!selectedIds.length) return false;
    const body = useLiteCutEditorStore.getState().body;
    if (selectedIds.length > 1) {
      const entries = timelineSelectionEntries(body, selectedIds).filter((entry) => !entry.locked && !entry.hidden);
      if (!entries.length) return false;
      const anchor = Math.min(...entries.map((entry) => entry.start));
      set({
        clipboard: {
          type: "multi",
          anchor,
          items: entries.map((entry) => ({
            type: entry.kind,
            trackId: entry.trackId,
            trackType: entry.trackType,
            offset: entry.start - anchor,
            item: structuredClone(entry.item),
          })),
        },
      });
      return true;
    }
    if (selectedTrackId === "overlay") {
      const ov = (body?.overlays || []).find((o) => o.id === selectedClipId);
      if (!ov) return false;
      set({ clipboard: { type: "overlay", item: structuredClone(ov) } });
      return true;
    }
    const { clip, trackId } = findClipById(body, selectedClipId);
    const track = getTrack(body, trackId);
    if (!clip || !track) return false;
    set({ clipboard: { type: "clip", trackType: track.type, item: structuredClone(clip) } });
    return true;
  },

  canPasteClipboard: () => Boolean(get().clipboard && useLiteCutEditorStore.getState().body),

  pasteClipboard: () => {
    const { clipboard, playheadSec, selectedTrackId } = get();
    if (!clipboard) return false;
    let newId = null;
    let newTrackId = null;
    let newIds = [];
    get().mutateProject((body) => {
      if (clipboard.type === "multi") {
        const targetByTrack = new Map();
        for (const entry of clipboard.items || []) {
          const start = Math.max(0, playheadSec + (Number(entry.offset) || 0));
          if (entry.type === "overlay") {
            const ov = cloneOverlayForPaste(entry.item, start);
            if (!ov) continue;
            body.overlays = [...(body.overlays || []), ov];
            newIds.push(ov.id);
            newId = ov.id;
            newTrackId = "overlay";
            continue;
          }

          const trackType = entry.trackType === "audio" ? "audio" : "video";
          const clip = cloneTimelineClipForPaste(entry.item, start);
          if (!clip) continue;
          const duration = clipSourceDuration(clip);
          let target = targetByTrack.get(entry.trackId) || null;
          if (!target) {
            const original = getTrack(body, entry.trackId);
            if (original?.type === trackType && !original.locked && !original.hidden) target = original;
          }
          if (!target) target = trackType === "audio" ? editableAudioTracks(body)[0] : editableVideoTracks(body)[0];
          if (!target) {
            const id = trackType === "audio" ? insertAudioTrack(body) : insertVideoTrack(body);
            target = getTrack(body, id);
          }
          if (!target) continue;
          if (!canPlaceOnTrack(target.clips, clip.timeline_start, duration)) {
            const id = trackType === "audio" ? insertAudioTrack(body, target.id) : insertVideoTrack(body, target.id);
            target = getTrack(body, id);
          }
          if (!target || target.locked || !canPlaceOnTrack(target.clips, clip.timeline_start, duration)) continue;
          target.clips = sortClips([...(target.clips || []), clip]);
          targetByTrack.set(entry.trackId, target);
          newIds.push(clip.id);
          newId = clip.id;
          newTrackId = target.id;
        }
        return body;
      }

      if (clipboard.type === "overlay") {
        const ov = cloneOverlayForPaste(clipboard.item, playheadSec);
        if (!ov) return body;
        body.overlays = [...(body.overlays || []), ov];
        newId = ov.id;
        newTrackId = "overlay";
        return body;
      }

      const trackType = clipboard.trackType === "audio" ? "audio" : "video";
      const clip = cloneTimelineClipForPaste(clipboard.item, playheadSec);
      if (!clip) return body;
      const duration = clipSourceDuration(clip);
      let target = null;
      const selectedTrack = selectedTrackId !== "overlay" ? getTrack(body, selectedTrackId) : null;
      if (selectedTrack?.type === trackType && !selectedTrack.locked && !selectedTrack.hidden) {
        target = selectedTrack;
      }
      if (!target) {
        target = trackType === "audio" ? editableAudioTracks(body)[0] : editableVideoTracks(body)[0];
      }
      if (!target) {
        const id = trackType === "audio" ? insertAudioTrack(body) : insertVideoTrack(body);
        target = getTrack(body, id);
      }
      if (!target) return body;
      if (!canPlaceOnTrack(target.clips, clip.timeline_start, duration)) {
        const id = trackType === "audio" ? insertAudioTrack(body, target.id) : insertVideoTrack(body, target.id);
        target = getTrack(body, id);
      }
      if (!target || target.locked || !canPlaceOnTrack(target.clips, clip.timeline_start, duration)) return body;
      target.clips = sortClips([...(target.clips || []), clip]);
      newId = clip.id;
      newTrackId = target.id;
      return body;
    });
    if (newId && newTrackId) {
      set({ selectedClipId: newId, selectedClipIds: uniqueIds(newIds.length ? newIds : [newId]), selectedTrackId: newTrackId });
      return true;
    }
    return false;
  },

  insertPasteClipboard: () => {
    const { clipboard, playheadSec, selectedTrackId } = get();
    if (!clipboard) return false;
    if (clipboard.type === "multi") return get().pasteClipboard();
    let newId = null;
    let newTrackId = null;
    get().mutateProject((body) => {
      if (clipboard.type === "overlay") {
        const ov = cloneOverlayForPaste(clipboard.item, playheadSec);
        if (!ov) return body;
        const result = insertOverlayWithRipple(body.overlays || [], ov);
        if (!result.inserted) return body;
        body.overlays = result.overlays;
        newId = ov.id;
        newTrackId = "overlay";
        return body;
      }

      const trackType = clipboard.trackType === "audio" ? "audio" : "video";
      const clip = cloneTimelineClipForPaste(clipboard.item, playheadSec);
      if (!clip) return body;
      let target = null;
      const selectedTrack = selectedTrackId !== "overlay" ? getTrack(body, selectedTrackId) : null;
      if (selectedTrack?.type === trackType && !selectedTrack.locked && !selectedTrack.hidden) {
        target = selectedTrack;
      }
      if (!target) {
        target = trackType === "audio" ? editableAudioTracks(body)[0] : editableVideoTracks(body)[0];
      }
      if (!target) {
        const id = trackType === "audio" ? insertAudioTrack(body) : insertVideoTrack(body);
        target = getTrack(body, id);
      }
      if (!target) return body;

      let result = insertClipIntoTrackWithRipple(target, clip);
      if (!result.inserted) {
        const id = trackType === "audio" ? insertAudioTrack(body, target.id) : insertVideoTrack(body, target.id);
        target = getTrack(body, id);
        result = insertClipIntoTrackWithRipple(target, clip);
      }
      if (!target || target.locked || !result.inserted) return body;
      target.clips = result.clips;
      newId = clip.id;
      newTrackId = target.id;
      return body;
    });
    if (newId && newTrackId) {
      set({ selectedClipId: newId, selectedClipIds: [newId], selectedTrackId: newTrackId });
      return true;
    }
    return false;
  },

  duplicateSelected: () => {
    const state = get();
    const selectedIds = activeSelectionIds(state);
    const { selectedClipId, selectedTrackId } = state;
    if (!selectedClipId) return;
    if (selectedIds.length > 1) {
      const body = useLiteCutEditorStore.getState().body;
      const entries = timelineSelectionEntries(body, selectedIds);
      if (!entries.length || !get().copySelected()) return;
      const maxEnd = Math.max(...entries.map((entry) => entry.end));
      const prevPlayhead = get().playheadSec;
      set({ playheadSec: maxEnd + 0.05 });
      const pasted = get().pasteClipboard();
      set({ playheadSec: prevPlayhead });
      return pasted;
    }
    let newId = null;
    let trackId = null;
    get().mutateProject((body) => {
      if (selectedTrackId === "overlay") {
        const ov = (body.overlays || []).find((o) => o.id === selectedClipId);
        if (!ov) return body;
        const dup = {
          ...structuredClone(ov),
          id: newOverlayId(),
          timeline_start: overlayTimelineEnd(ov) + 0.05,
        };
        body.overlays = [...(body.overlays || []), dup];
        newId = dup.id;
        trackId = "overlay";
        return body;
      }
      const found = findClipById(body, selectedClipId);
      const clip = found.clip;
      trackId = found.trackId;
      if (!clip || !trackId) return body;
      const track = getTrack(body, trackId);
      if (track?.locked) return body;
      const start = clipTimelineEnd(clip) + 0.05;
      const dup = { ...structuredClone(clip), id: newClipId(), timeline_start: start };
      if (!canPlaceOnTrack(track.clips, start, clipSourceDuration(dup))) return body;
      track.clips = [...(track.clips || []), dup];
      newId = dup.id;
      return body;
    });
    if (newId) set({ selectedClipId: newId, selectedClipIds: [newId], selectedTrackId: trackId });
  },

  splitAtPlayhead: () => {
    const state = get();
    const initialSelectedIds = activeSelectionIds(state);
    const { selectedClipId, selectedTrackId, playheadSec } = state;
    if (!selectedClipId) return;
    const currentBody = useLiteCutEditorStore.getState().body;
    const selectedIds = linkedSplitSelection(currentBody, initialSelectedIds, playheadSec);
    if (!selectedIds.length) return false;
    if (selectedIds.length > 1) {
      const splitTargets = timelineSelectionEntries(currentBody, selectedIds).filter((entry) => {
        if (entry.locked || entry.hidden) return false;
        const local = playheadSec - entry.start;
        const duration = entry.end - entry.start;
        return local > 0.05 && local < duration - 0.05;
      });
      if (!splitTargets.length) return false;
      let newIds = [];
      let primaryTrackId = null;
      const selected = new Set(selectedIds.map(String));
      const pairs = linkedClipPairs(currentBody);
      const rightIds = new Map();
      get().mutateProject((body) => {
        for (const track of body.tracks || []) {
          if (track.locked || track.hidden) continue;
          const next = [];
          for (const clip of sortClips(track.clips || [])) {
            if (!selected.has(String(clip.id))) {
              next.push(clip);
              continue;
            }
            const local = playheadSec - (Number(clip.timeline_start) || 0);
            if (local <= 0.05 || local >= clipSourceDuration(clip) - 0.05) {
              next.push(clip);
              continue;
            }
            const [left, right] = splitClipAt(clip, local);
            next.push(left, right);
            newIds.push(right.id);
            rightIds.set(String(clip.id), String(right.id));
            primaryTrackId = primaryTrackId || track.id;
          }
          track.clips = sortClips(next);
        }

        const overlays = [];
        for (const ov of body.overlays || []) {
          if (!selected.has(String(ov.id))) {
            overlays.push(ov);
            continue;
          }
          const local = playheadSec - (Number(ov.timeline_start) || 0);
          const dur = Number(ov.duration) || 0;
          if (local <= 0.05 || local >= dur - 0.05) {
            overlays.push(ov);
            continue;
          }
          const [left, right] = splitOverlayAt(ov, local);
          overlays.push(left, right);
          newIds.push(right.id);
          primaryTrackId = primaryTrackId || "overlay";
        }
        body.overlays = overlays.sort((a, b) => (a.timeline_start || 0) - (b.timeline_start || 0));
        restoreLinksAfterSplit(body, pairs, rightIds);
        return body;
      });
      if (newIds.length) {
        set({ selectedClipId: newIds[0], selectedClipIds: uniqueIds(newIds), selectedTrackId: primaryTrackId || selectedTrackId });
        return true;
      }
      return false;
    }
    let newId = null;
    let trackId = null;
    const pairs = linkedClipPairs(currentBody);
    const rightIds = new Map();
    get().mutateProject((body) => {
      if (selectedTrackId === "overlay") {
        const ov = (body.overlays || []).find((o) => o.id === selectedClipId);
        if (!ov) return body;
        const local = playheadSec - (Number(ov.timeline_start) || 0);
        const dur = Number(ov.duration) || 0;
        if (local <= 0.05 || local >= dur - 0.05) return body;
        const [left, right] = splitOverlayAt(ov, local);
        body.overlays = (body.overlays || []).filter((o) => o.id !== selectedClipId).concat([left, right]);
        newId = right.id;
        trackId = "overlay";
        return body;
      }
      const found = findClipById(body, selectedClipId);
      const clip = found.clip;
      trackId = found.trackId;
      if (!clip || !trackId) return body;
      const track = getTrack(body, trackId);
      if (track?.locked) return body;
      const local = playheadSec - (Number(clip.timeline_start) || 0);
      const dur = clipSourceDuration(clip);
      if (local <= 0.05 || local >= dur - 0.05) return body;
      const [left, right] = splitClipAt(clip, local);
      track.clips = sortClips(
        (track.clips || []).filter((c) => c.id !== selectedClipId).concat([left, right]),
      );
      rightIds.set(String(clip.id), String(right.id));
      restoreLinksAfterSplit(body, pairs, rightIds);
      newId = right.id;
      return body;
    });
    if (newId) set({ selectedClipId: newId, selectedClipIds: [newId], selectedTrackId: trackId });
  },

  canSplitAllAtPlayhead: () => {
    const body = useLiteCutEditorStore.getState().body;
    const { playheadSec } = get();
    return Boolean(
      (body?.tracks || []).some((track) => canSplitTrackClipsAtPlayhead(track, playheadSec)) ||
        canSplitOverlaysAtPlayhead(body?.overlays || [], playheadSec),
    );
  },

  splitAllAtPlayhead: () => {
    if (!get().canSplitAllAtPlayhead()) return false;
    const { playheadSec } = get();
    let firstNewId = null;
    let firstTrackId = null;
    const currentBody = useLiteCutEditorStore.getState().body;
    const pairs = linkedClipPairs(currentBody);
    const rightIds = new Map();
    get().mutateProject((body) => {
      for (const track of body.tracks || []) {
        const result = splitTrackClipsAtPlayhead(track, playheadSec);
        if (!result.changed) continue;
        track.clips = result.clips;
        for (const pair of result.splitPairs || []) rightIds.set(pair.id, pair.rightId);
        if (!firstNewId && result.newIds[0]) {
          firstNewId = result.newIds[0];
          firstTrackId = track.id;
        }
      }

      const overlayResult = splitOverlaysAtPlayhead(body.overlays || [], playheadSec);
      if (overlayResult.changed) {
        body.overlays = overlayResult.overlays;
        if (!firstNewId && overlayResult.newIds[0]) {
          firstNewId = overlayResult.newIds[0];
          firstTrackId = "overlay";
        }
      }
      restoreLinksAfterSplit(body, pairs, rightIds);
      return body;
    });
    if (firstNewId) set({ selectedClipId: firstNewId, selectedClipIds: [firstNewId], selectedTrackId: firstTrackId });
    return Boolean(firstNewId);
  },

  canTrimSelectedStartToPlayhead: () => {
    const state = get();
    const selectedIds = activeSelectionIds(state);
    const { selectedClipId, selectedTrackId, playheadSec } = state;
    if (!selectedClipId) return false;
    const body = useLiteCutEditorStore.getState().body;
    if (selectedIds.length > 1) return selectedTrimTargets(body, selectedIds, "start", playheadSec).length > 0;
    if (selectedTrackId === "overlay") {
      const ov = (body?.overlays || []).find((o) => o.id === selectedClipId);
      return canTrimOverlayToPlayhead(ov, "start", playheadSec);
    }
    const { clip, trackId } = findClipById(body, selectedClipId);
    const track = getTrack(body, trackId);
    return Boolean(clip && track && !track.locked && canTrimClipStartToPlayhead(clip, track.type, playheadSec));
  },

  canTrimSelectedEndToPlayhead: () => {
    const state = get();
    const selectedIds = activeSelectionIds(state);
    const { selectedClipId, selectedTrackId, playheadSec } = state;
    if (!selectedClipId) return false;
    const body = useLiteCutEditorStore.getState().body;
    if (selectedIds.length > 1) return selectedTrimTargets(body, selectedIds, "end", playheadSec).length > 0;
    if (selectedTrackId === "overlay") {
      const ov = (body?.overlays || []).find((o) => o.id === selectedClipId);
      return canTrimOverlayToPlayhead(ov, "end", playheadSec);
    }
    const { clip, trackId } = findClipById(body, selectedClipId);
    const track = getTrack(body, trackId);
    return Boolean(clip && track && !track.locked && canTrimClipEndToPlayhead(clip, track.type, playheadSec));
  },

  trimSelectedStartToPlayhead: () => {
    if (!get().canTrimSelectedStartToPlayhead()) return false;
    const state = get();
    const selectedIds = activeSelectionIds(state);
    const { selectedClipId, selectedTrackId, playheadSec } = state;
    const body = useLiteCutEditorStore.getState().body;
    if (selectedIds.length > 1) {
      const targets = selectedTrimTargets(body, selectedIds, "start", playheadSec);
      if (!targets.length) return false;
      const targetIds = new Set(targets.map((target) => String(target.id)));
      get().mutateProject((nextBody) => {
        nextBody.overlays = (nextBody.overlays || []).map((ov) => {
          if (!targetIds.has(String(ov.id))) return ov;
          return resizeOverlayDraft(ov, {
            start: playheadSec,
            duration: overlayTimelineEnd(ov) - playheadSec,
          });
        });
        for (const track of nextBody.tracks || []) {
          if (track.locked) continue;
          track.clips = sortClips((track.clips || []).map((clip) => {
            if (!targetIds.has(String(clip.id))) return clip;
            const oldStart = Number(clip.timeline_start) || 0;
            const maxStart = clipMaxTimelineStartForLeftTrim(clip);
            const start = Math.max(oldStart, Math.min(playheadSec, maxStart));
            const delta = start - oldStart;
            if (delta <= 0) return clip;
            return rebaseTimelineClipKeyframes(clip, {
              ...clip,
              timeline_start: start,
              trim_in: clipSourceTimeForTimeline(clip, delta),
            });
          }));
        }
        return nextBody;
      });
      return true;
    }
    if (selectedTrackId === "overlay") {
      const ov = (body?.overlays || []).find((o) => o.id === selectedClipId);
      if (!ov) return false;
      get().resizeOverlay(selectedClipId, {
        start: playheadSec,
        duration: overlayTimelineEnd(ov) - playheadSec,
      });
      return true;
    }
    const { trackId } = findClipById(body, selectedClipId);
    get().trimClipLeft(selectedClipId, trackId, playheadSec);
    return true;
  },

  trimSelectedEndToPlayhead: () => {
    if (!get().canTrimSelectedEndToPlayhead()) return false;
    const state = get();
    const selectedIds = activeSelectionIds(state);
    const { selectedClipId, selectedTrackId, playheadSec } = state;
    const body = useLiteCutEditorStore.getState().body;
    if (selectedIds.length > 1) {
      const targets = selectedTrimTargets(body, selectedIds, "end", playheadSec);
      if (!targets.length) return false;
      const targetIds = new Set(targets.map((target) => String(target.id)));
      get().mutateProject((nextBody) => {
        nextBody.overlays = (nextBody.overlays || []).map((ov) => {
          if (!targetIds.has(String(ov.id))) return ov;
          return resizeOverlayDraft(ov, {
            duration: playheadSec - (Number(ov.timeline_start) || 0),
          });
        });
        for (const track of nextBody.tracks || []) {
          if (track.locked) continue;
          track.clips = sortClips((track.clips || []).map((clip) => {
            if (!targetIds.has(String(clip.id))) return clip;
            ensureClipSourceDuration(clip);
            const start = Number(clip.timeline_start) || 0;
            const maxEnd = clipMaxTimelineEnd(clip);
            const end = Math.max(start + 0.1, Math.min(playheadSec, maxEnd));
            return rebaseTimelineClipKeyframes(clip, trimClipEndDraft(clip, end));
          }));
        }
        return nextBody;
      });
      return true;
    }
    if (selectedTrackId === "overlay") {
      const ov = (body?.overlays || []).find((o) => o.id === selectedClipId);
      if (!ov) return false;
      get().resizeOverlay(selectedClipId, {
        duration: playheadSec - (Number(ov.timeline_start) || 0),
      });
      return true;
    }
    const { trackId } = findClipById(body, selectedClipId);
    get().trimClipRight(selectedClipId, trackId, playheadSec);
    return true;
  },

  deleteTimelineSide: (direction = "left") => {
    const cut = Math.max(0, Number(get().playheadSec) || 0);
    if (direction !== "left" && direction !== "right") return false;
    if (direction === "left" && cut <= 1e-6) return false;
    get().mutateProject((body) => {
      for (const track of body.tracks || []) {
        const next = [];
        for (const source of track.clips || []) {
          const start = Number(source.timeline_start) || 0;
          const end = clipTimelineEnd(source);
          if (direction === "right") {
            if (start >= cut - 1e-6) continue;
            next.push(end > cut + 1e-6
              ? rebaseTimelineClipKeyframes(source, trimClipEndDraft(source, cut))
              : source);
            continue;
          }
          if (end <= cut + 1e-6) continue;
          if (start < cut - 1e-6) {
            const delta = cut - start;
            next.push(rebaseTimelineClipKeyframes(source, {
              ...source,
              timeline_start: 0,
              trim_in: clipSourceTimeForTimeline(source, delta),
            }));
          } else {
            next.push({ ...source, timeline_start: Math.max(0, start - cut) });
          }
        }
        track.clips = sortClips(next);
      }
      body.overlays = (body.overlays || []).flatMap((source) => {
        const start = Number(source.timeline_start) || 0;
        const end = overlayTimelineEnd(source);
        if (direction === "right") {
          if (start >= cut - 1e-6) return [];
          return [end > cut + 1e-6 ? resizeOverlayDraft(source, { duration: cut - start }) : source];
        }
        if (end <= cut + 1e-6) return [];
        if (start < cut - 1e-6) {
          const trimmed = resizeOverlayDraft(source, { start: cut, duration: end - cut });
          return [{ ...trimmed, timeline_start: 0 }];
        }
        return [{ ...source, timeline_start: Math.max(0, start - cut) }];
      });
      return body;
    });
    if (direction === "left") get().setPlayhead(0);
    get().clearSelection();
    return true;
  },

  updateSelectedClip: (patch) => {
    const state = get();
    const selectedIds = activeSelectionIds(state);
    const { selectedClipId } = state;
    if (!selectedClipId) return;
    get().mutateProject((body) => {
      if (selectedIds.length > 1) {
        const idSet = new Set(selectedIds.map(String));
        for (const track of body.tracks || []) {
          if (track.locked || track.hidden) continue;
          const trackPatch = clipPatchForTrack(patch, track);
          if (!Object.keys(trackPatch).length) continue;
          for (const clip of track.clips || []) {
            if (idSet.has(String(clip.id))) Object.assign(clip, trackPatch);
          }
        }
        return body;
      }
      const { clip, trackId } = findClipById(body, selectedClipId);
      const track = getTrack(body, trackId);
      if (track?.locked) return body;
      if (!clip) return body;
      const trackPatch = clipPatchForTrack(patch, track);
      if (!Object.keys(trackPatch).length) return body;
      Object.assign(clip, trackPatch);
      return body;
    }, { recordHistory: false });
  },

  updateClip: (clipId, trackId, patch, { recordHistory = false } = {}) => {
    if (!clipId || !trackId || !patch || typeof patch !== "object") return false;
    let changed = false;
    get().mutateProject((body) => {
      const track = getTrack(body, trackId);
      const clip = (track?.clips || []).find((item) => String(item.id) === String(clipId));
      if (!clip || track?.locked) return body;
      Object.assign(clip, clipPatchForTrack(patch, track));
      changed = true;
      return body;
    }, { recordHistory });
    return changed;
  },

  upsertClipAudioKeyframe: (clipId, trackId, playheadSec) => {
    get().mutateProject((body) => {
      const track = getTrack(body, trackId);
      const clip = (track?.clips || []).find((item) => String(item.id) === String(clipId));
      if (!clip || track?.locked) return body;
      const duration = clipSourceDuration(clip);
      const local = Math.max(0, Math.min(duration, (Number(playheadSec) || 0) - (Number(clip.timeline_start) || 0)));
      clip.audio_keyframes = [
        ...normalizedAudioKeyframes(clip, duration).filter((keyframe) => Math.abs(keyframe.time_sec - local) > 0.04),
        { time_sec: local, volume: clipVolumeAt(clip, playheadSec, duration) },
      ].sort((a, b) => a.time_sec - b.time_sec);
      return body;
    });
  },

  removeClipAudioKeyframe: (clipId, trackId, playheadSec) => {
    get().mutateProject((body) => {
      const track = getTrack(body, trackId);
      const clip = (track?.clips || []).find((item) => String(item.id) === String(clipId));
      if (!clip || track?.locked) return body;
      const local = (Number(playheadSec) || 0) - (Number(clip.timeline_start) || 0);
      clip.audio_keyframes = normalizedAudioKeyframes(clip, clipSourceDuration(clip)).filter((keyframe) => Math.abs(keyframe.time_sec - local) > 0.04);
      return body;
    });
  },

  moveClipAudioKeyframe: (clipId, trackId, fromPlayheadSec, toPlayheadSec, { recordHistory = true } = {}) => {
    let changed = false;
    get().mutateProject((body) => {
      const track = getTrack(body, trackId);
      const clip = (track?.clips || []).find((item) => String(item.id) === String(clipId));
      if (!clip || track?.locked) return body;
      const duration = clipSourceDuration(clip);
      const start = Number(clip.timeline_start) || 0;
      const fromLocal = (Number(fromPlayheadSec) || 0) - start;
      const frame = projectFrameStepSec(body);
      const targetLocal = Math.max(0, Math.min(duration, Math.round(((Number(toPlayheadSec) || 0) - start) / frame) * frame));
      const keyframes = normalizedAudioKeyframes(clip, duration);
      const moving = keyframes.find((point) => Math.abs(point.time_sec - fromLocal) <= Math.max(0.04, frame));
      if (!moving || Math.abs(moving.time_sec - targetLocal) < 0.000001) return body;
      clip.audio_keyframes = [
        ...keyframes.filter((point) => point !== moving && Math.abs(point.time_sec - targetLocal) > Math.max(0.04, frame / 2)),
        { ...moving, time_sec: targetLocal },
      ].sort((a, b) => a.time_sec - b.time_sec);
      changed = true;
      return body;
    }, { recordHistory });
    return changed;
  },

  updateClipVolumeAtTime: (clipId, trackId, playheadSec, volume) => {
    get().mutateProject((body) => {
      const track = getTrack(body, trackId);
      const clip = (track?.clips || []).find((item) => String(item.id) === String(clipId));
      if (!clip || track?.locked) return body;
      const duration = clipSourceDuration(clip);
      const existing = audioKeyframeNearPlayhead(clip, playheadSec, 0.04, duration);
      if (!existing) {
        clip.volume = Math.max(0, Math.min(5, Number(volume) || 0));
        return body;
      }
      clip.audio_keyframes = normalizedAudioKeyframes(clip, duration).map((keyframe) =>
        Math.abs(keyframe.time_sec - existing.time_sec) <= 0.04 ? { ...keyframe, volume: Math.max(0, Math.min(5, Number(volume) || 0)) } : keyframe,
      );
      return body;
    }, { recordHistory: false });
  },

  updateSelectedTransition: (type, durationSec = 0.4) => {
    const state = get();
    const selectedIds = activeSelectionIds(state);
    const { selectedClipId } = state;
    if (!selectedClipId) return;
    const target = normalizedTransitionStyle(type, durationSec);
    get().mutateProject((body) => {
      if (selectedIds.length > 1) {
        const idSet = new Set(selectedIds.map(String));
        for (const track of body.tracks || []) {
          if (track.type !== "video" || track.locked || track.hidden) continue;
          for (const clip of track.clips || []) {
            if (idSet.has(String(clip.id))) clip.transition_out = { ...target };
          }
        }
        return body;
      }
      const { clip, trackId } = findClipById(body, selectedClipId);
      if (getTrack(body, trackId)?.locked) return body;
      if (!clip) return body;
      clip.transition_out = { ...target };
      // Older inspector builds accidentally stored transition timing as a
      // fade-to-black on the clip itself. A transition selection owns the
      // boundary effect, so clear those stale black fades here.
      clip.fade_in_sec = 0;
      clip.fade_out_sec = 0;
      return body;
    });
  },

  updateSelectedTransitionType: (type) => {
    const { selectedClipId } = get();
    if (!selectedClipId) return;
    get().mutateProject((body) => {
      const { clip, trackId } = findClipById(body, selectedClipId);
      if (!clip || getTrack(body, trackId)?.locked) return body;
      const incomingDuration = Math.max(0.05, Number(clip.transition_in?.duration_sec) || 0.25);
      const outgoingDuration = Math.max(0.05, Number(clip.transition_out?.duration_sec) || 0.25);
      clip.transition_in = normalizedTransitionStyle(type, incomingDuration);
      clip.transition_out = normalizedTransitionStyle(type, outgoingDuration);
      clip.fade_in_sec = 0;
      clip.fade_out_sec = 0;
      return body;
    });
  },

  updateSelectedTransitionDuration: (edge, durationSec) => {
    const { selectedClipId } = get();
    if (!selectedClipId || !["in", "out"].includes(edge)) return;
    get().mutateProject((body) => {
      const { clip, trackId } = findClipById(body, selectedClipId);
      if (!clip || getTrack(body, trackId)?.locked) return body;
      const key = edge === "in" ? "transition_in" : "transition_out";
      const fallbackType = clip.transition_out?.type || clip.transition_in?.type || "fade";
      clip[key] = normalizedTransitionStyle(clip[key]?.type || fallbackType, durationSec);
      return body;
    }, { recordHistory: false });
  },

  canApplySelectedTransitionToScope: (scope = "track", type = "fade", durationSec = 0.4) => {
    const body = useLiteCutEditorStore.getState().body;
    const { selectedClipId } = get();
    const context = selectedEditableVideoContext(body, selectedClipId);
    if (!context) return false;
    const target = normalizedTransitionStyle(type, durationSec);
    return videoStyleTargets(body, context.trackId, scope).some(({ clip }) => !transitionsMatch(clip.transition_out, target));
  },

  applySelectedTransitionToScope: (scope = "track", type = "fade", durationSec = 0.4) => {
    if (!get().canApplySelectedTransitionToScope(scope, type, durationSec)) return false;
    const { selectedClipId } = get();
    const target = normalizedTransitionStyle(type, durationSec);
    let changed = false;
    get().mutateProject((body) => {
      const context = selectedEditableVideoContext(body, selectedClipId);
      if (!context) return body;
      for (const { clip } of videoStyleTargets(body, context.trackId, scope)) {
        if (transitionsMatch(clip.transition_out, target)) continue;
        clip.transition_out = { ...target };
        changed = true;
      }
      return body;
    });
    return changed;
  },

  updateSelectedColor: (colorPatch) => {
    const state = get();
    const { selectedClipId } = state;
    const selectedIds = activeSelectionIds(state);
    if (!selectedClipId) return;
    get().mutateProject((body) => {
      if (selectedIds.length > 1) {
        const selectedIdSet = new Set(selectedIds.map(String));
        for (const track of body.tracks || []) {
          if (track.type !== "video" || track.locked || track.hidden) continue;
          for (const clip of track.clips || []) {
            if (!selectedIdSet.has(String(clip.id))) continue;
            clip.color = { ...(clip.color || {}), ...colorPatch };
          }
        }
        return body;
      }
      const { clip, trackId } = findClipById(body, selectedClipId);
      if (getTrack(body, trackId)?.locked) return body;
      if (!clip) return body;
      clip.color = { ...(clip.color || {}), ...colorPatch };
      return body;
    }, { recordHistory: false });
  },

  canApplySelectedColorToScope: (scope = "track", color = {}) => {
    const body = useLiteCutEditorStore.getState().body;
    const { selectedClipId } = get();
    const context = selectedEditableVideoContext(body, selectedClipId);
    if (!context) return false;
    const target = normalizedColorStyle(color);
    return videoStyleTargets(body, context.trackId, scope).some(({ clip }) => !colorsMatch(clip.color, target));
  },

  applySelectedColorToScope: (scope = "track", color = {}) => {
    if (!get().canApplySelectedColorToScope(scope, color)) return false;
    const { selectedClipId } = get();
    const target = normalizedColorStyle(color);
    let changed = false;
    get().mutateProject((body) => {
      const context = selectedEditableVideoContext(body, selectedClipId);
      if (!context) return body;
      for (const { clip } of videoStyleTargets(body, context.trackId, scope)) {
        if (colorsMatch(clip.color, target)) continue;
        clip.color = { ...target };
        changed = true;
      }
      return body;
    });
    return changed;
  },

  moveClipToTime: (clipId, trackId, newStart, { snap = true, recordHistory = true } = {}) => {
    const { playheadSec } = get();
    get().mutateProject((body) => {
      const track = getTrack(body, trackId);
      const clip = (track?.clips || []).find((c) => c.id === clipId);
      if (!clip || !track) return body;
      if (track.locked) return body;
      const dur = clipSourceDuration(clip);
      let start = Math.max(0, newStart);
      if (snap) {
        start = snapTimelineSec(start, body, {
          enabled: get().snapEnabled,
          playheadSec,
        });
      }
      if (!canPlaceOnTrack(track.clips, start, dur, clipId)) return body;
      clip.timeline_start = start;
      return body;
    }, { recordHistory });
  },

  moveClipToTrack: (clipId, fromTrackId, toTrackId, newStart, { snap = true, recordHistory = true, createBelow = false, createAbove = false } = {}) => {
    const { playheadSec } = get();
    let ok = false;
    let finalTrackId = toTrackId;
    get().mutateProject((body) => {
      if (createBelow && toTrackId) {
        const target = getTrack(body, toTrackId);
        finalTrackId = target?.type === "audio" ? insertAudioTrack(body, toTrackId) : insertVideoTrack(body, toTrackId);
      } else if (createAbove && toTrackId) {
        finalTrackId = insertVideoTrackBefore(body, toTrackId);
      }
      if (fromTrackId === finalTrackId) {
        const track = getTrack(body, fromTrackId);
        const clip = (track?.clips || []).find((c) => c.id === clipId);
        if (!clip || !track) return body;
        if (track.locked) return body;
        const dur = clipSourceDuration(clip);
        let start = Math.max(0, newStart);
        if (snap) {
          start = snapTimelineSec(start, body, { enabled: get().snapEnabled, playheadSec });
        }
        if (!canPlaceOnTrack(track.clips, start, dur, clipId)) return body;
        clip.timeline_start = start;
        ok = true;
        return body;
      }
      const fromTrack = getTrack(body, fromTrackId);
      const toTrack = getTrack(body, finalTrackId);
      if (!fromTrack || !toTrack) return body;
      if (fromTrack.locked || toTrack.locked) return body;
      const clip = (fromTrack.clips || []).find((c) => c.id === clipId);
      if (!clip) return body;
      const dur = clipSourceDuration(clip);
      let start = Math.max(0, newStart);
      if (snap) {
        start = snapTimelineSec(start, body, { enabled: get().snapEnabled, playheadSec });
      }
      if (!canPlaceOnTrack(toTrack.clips, start, dur)) return body;
      fromTrack.clips = (fromTrack.clips || []).filter((c) => c.id !== clipId);
      clip.timeline_start = start;
      toTrack.clips = sortClips([...(toTrack.clips || []), clip]);
      ok = true;
      return body;
    }, { recordHistory });
    if (ok) set({ selectedClipId: clipId, selectedClipIds: [clipId], selectedTrackId: finalTrackId });
  },

  moveOverlayToTime: (overlayId, newStart, { snap = true, recordHistory = true } = {}) => {
    const { playheadSec } = get();
    get().mutateProject((body) => {
      const ov = (body.overlays || []).find((o) => o.id === overlayId);
      if (!ov) return body;
      let start = Math.max(0, newStart);
      if (snap) {
        start = snapTimelineSec(start, body, {
          enabled: get().snapEnabled,
          playheadSec,
        });
      }
      ov.timeline_start = start;
      return body;
    }, { recordHistory });
  },

  moveOverlayToTrack: (overlayId, overlayTrackId) => {
    get().mutateProject((body) => {
      const overlay = (body.overlays || []).find((item) => item.id === overlayId);
      if (!overlay) return body;
      overlay.meta = { ...(overlay.meta || {}), overlay_track_id: overlayTrackId || "ot1" };
      return body;
    });
  },

  trimClipLeft: (clipId, trackId, newTimelineStart, { recordHistory = true } = {}) => {
    get().mutateProject((body) => {
      const track = getTrack(body, trackId);
      const clip = (track?.clips || []).find((c) => c.id === clipId);
      if (!clip || !track) return body;
      if (track.locked) return body;
      ensureClipSourceDuration(clip);
      const original = structuredClone(clip);
      const draft = trimClipStartDraft(clip, newTimelineStart);
      if (Math.abs((Number(draft.timeline_start) || 0) - (Number(clip.timeline_start) || 0)) < 0.000001) return body;
      Object.assign(clip, rebaseTimelineClipKeyframes(original, draft));
      return body;
    }, { recordHistory });
  },

  trimClipRight: (clipId, trackId, newEnd, { recordHistory = true } = {}) => {
    get().mutateProject((body) => {
      const track = getTrack(body, trackId);
      const clip = (track?.clips || []).find((c) => c.id === clipId);
      if (!clip || !track) return body;
      if (track.locked) return body;
      ensureClipSourceDuration(clip);
      const original = structuredClone(clip);
      const start = Number(clip.timeline_start) || 0;
      const maxEnd = clipMaxTimelineEnd(clip);
      const end = Math.max(start + 0.1, Math.min(newEnd, maxEnd));
      Object.assign(clip, rebaseTimelineClipKeyframes(original, trimClipEndDraft(clip, end)));
      return body;
    }, { recordHistory });
  },

  /**
   * 用播放器实测的媒体时长纠正 meta.duration_sec。
   * 素材入库时 ffprobe 探测失败会落到 5s 默认值，而 trim 的钳制上限
   * 读取的正是 meta.duration_sec，导致片段无法拖出超过 5s。
   */
  backfillClipSourceDuration: (clipId, durationSec) => {
    const real = Number(durationSec);
    if (!clipId || !Number.isFinite(real) || real <= 0.05) return false;
    const body = useLiteCutEditorStore.getState().body;
    const { clip } = findClipById(body, clipId);
    if (!clip) return false;
    const sourceKey = (candidate) =>
      candidate?.source_type === "file"
        ? `file:${candidate.meta?.asset_id ?? candidate.file_path ?? ""}`
        : `rec:${candidate?.source_id ?? ""}`;
    const targetKey = sourceKey(clip);
    const needsUpdate = (candidate) =>
      sourceKey(candidate) === targetKey
      && (
        Math.abs((Number(candidate.meta?.duration_sec) || 0) - real) > 0.05
        || (Number(candidate.trim_out) || 0) > real + 0.001
        || (Number(candidate.trim_in) || 0) >= real - 0.001
      );
    const hasStale = (body?.tracks || []).some((track) => (track.clips || []).some(needsUpdate));
    if (!hasStale) return false;
    get().mutateProject((nextBody) => {
      for (const track of nextBody.tracks || []) {
        for (const candidate of track.clips || []) {
          if (needsUpdate(candidate)) {
            candidate.meta = { ...(candidate.meta || {}), duration_sec: real };
            const trimIn = Math.max(0, Math.min(Number(candidate.trim_in) || 0, Math.max(0, real - 0.1)));
            const trimOut = Number(candidate.trim_out);
            candidate.trim_in = trimIn;
            if (!Number.isFinite(trimOut) || trimOut > real || trimOut <= trimIn) {
              candidate.trim_out = Math.max(trimIn + 0.1, real);
            }
          }
        }
      }
      return nextBody;
    }, { recordHistory: false });
    return true;
  },

  resizeOverlay: (overlayId, { start, duration }, { recordHistory = true } = {}) => {
    get().mutateProject((body) => {
      const ov = (body.overlays || []).find((o) => o.id === overlayId);
      if (!ov) return body;
      Object.assign(ov, resizeOverlayDraft(ov, { start, duration }));
      return body;
    }, { recordHistory });
  },

  beginClipDrag: () => {
    const editor = useLiteCutEditorStore.getState();
    if (editor.body) {
      useLiteCutHistoryStore.getState().push(structuredClone(editor.body));
    }
  },

  beginOverlayDrag: () => {
    const editor = useLiteCutEditorStore.getState();
    if (editor.body) {
      useLiteCutHistoryStore.getState().push(structuredClone(editor.body));
    }
  },

  updateOverlayTransform: (overlayId, patch) => {
    get().mutateProject((body) => {
      const ov = (body.overlays || []).find((o) => o.id === overlayId);
      if (!ov) return body;
      ov.transform = { ...(ov.transform || { x: 0.5, y: 0.5, scale: 1, rotation: 0 }), ...patch };
      return body;
    }, { recordHistory: false });
  },

  upsertOverlayKeyframe: (overlayId, playheadSec) => {
    get().mutateProject((body) => {
      const ov = (body.overlays || []).find((o) => o.id === overlayId);
      if (!ov) return body;
      const local = Math.max(0, Math.min(Number(ov.duration) || 0, (Number(playheadSec) || 0) - (Number(ov.timeline_start) || 0)));
      const keyframes = normalizedOverlayKeyframes(ov);
      const existing = keyframeNearPlayhead(ov, playheadSec);
      const next = { time_sec: local, transform: overlayTransformAt(ov, playheadSec) };
      ov.keyframes = [...keyframes.filter((keyframe) => keyframe !== existing && Math.abs(keyframe.time_sec - local) > 0.04), next].sort((a, b) => a.time_sec - b.time_sec);
      return body;
    });
  },

  removeOverlayKeyframe: (overlayId, playheadSec) => {
    get().mutateProject((body) => {
      const ov = (body.overlays || []).find((o) => o.id === overlayId);
      if (!ov) return body;
      const local = (Number(playheadSec) || 0) - (Number(ov.timeline_start) || 0);
      ov.keyframes = normalizedOverlayKeyframes(ov).filter((keyframe) => Math.abs(keyframe.time_sec - local) > 0.04);
      return body;
    });
  },

  moveOverlayKeyframe: (overlayId, fromPlayheadSec, toPlayheadSec, { recordHistory = true } = {}) => {
    let changed = false;
    get().mutateProject((body) => {
      const overlay = (body.overlays || []).find((item) => item.id === overlayId);
      if (!overlay) return body;
      const start = Number(overlay.timeline_start) || 0;
      const duration = Math.max(0, Number(overlay.duration) || 0);
      const frame = projectFrameStepSec(body);
      const fromLocal = (Number(fromPlayheadSec) || 0) - start;
      const targetLocal = Math.max(0, Math.min(duration, Math.round(((Number(toPlayheadSec) || 0) - start) / frame) * frame));
      const keyframes = normalizedOverlayKeyframes(overlay);
      const moving = keyframes.find((point) => Math.abs(point.time_sec - fromLocal) <= Math.max(0.04, frame));
      if (!moving || Math.abs(moving.time_sec - targetLocal) < 0.000001) return body;
      overlay.keyframes = [
        ...keyframes.filter((point) => point !== moving && Math.abs(point.time_sec - targetLocal) > Math.max(0.04, frame / 2)),
        { ...moving, time_sec: targetLocal },
      ].sort((a, b) => a.time_sec - b.time_sec);
      changed = true;
      return body;
    }, { recordHistory });
    return changed;
  },

  updateOverlayTransformAtTime: (overlayId, playheadSec, patch) => {
    get().mutateProject((body) => {
      const ov = (body.overlays || []).find((o) => o.id === overlayId);
      if (!ov) return body;
      const existing = keyframeNearPlayhead(ov, playheadSec);
      if (!existing) {
        ov.transform = { ...(ov.transform || {}), ...patch };
        return body;
      }
      ov.keyframes = normalizedOverlayKeyframes(ov).map((keyframe) =>
        Math.abs(keyframe.time_sec - existing.time_sec) <= 0.04 ? { ...keyframe, transform: { ...keyframe.transform, ...patch } } : keyframe,
      );
      return body;
    }, { recordHistory: false });
  },

  applyOverlayMotionPreset: (overlayId, preset) => {
    let changed = false;
    get().mutateProject((body) => {
      const overlay = (body.overlays || []).find((item) => item.id === overlayId);
      if (!overlay) return body;
      const keyframes = motionPresetKeyframes(overlay.transform, overlay.duration, preset, undefined);
      if (!keyframes) return body;
      overlay.keyframes = keyframes;
      changed = true;
      return body;
    });
    return changed;
  },

  upsertClipKeyframe: (clipId, trackId, playheadSec) => {
    get().mutateProject((body) => {
      const clip = (getTrack(body, trackId)?.clips || []).find((item) => item.id === clipId);
      if (!clip) return body;
      const keyframeClip = { ...clip, duration: clipSourceDuration(clip) };
      const local = Math.max(0, Math.min(keyframeClip.duration, (Number(playheadSec) || 0) - (Number(clip.timeline_start) || 0)));
      const keyframes = normalizedOverlayKeyframes(keyframeClip, VIDEO_LAYER_TRANSFORM_DEFAULTS);
      clip.keyframes = [
        ...keyframes.filter((keyframe) => Math.abs(keyframe.time_sec - local) > 0.04),
        { time_sec: local, transform: overlayTransformAt(keyframeClip, playheadSec, VIDEO_LAYER_TRANSFORM_DEFAULTS) },
      ].sort((a, b) => a.time_sec - b.time_sec);
      return body;
    });
  },

  removeClipKeyframe: (clipId, trackId, playheadSec) => {
    get().mutateProject((body) => {
      const clip = (getTrack(body, trackId)?.clips || []).find((item) => item.id === clipId);
      if (!clip) return body;
      const keyframeClip = { ...clip, duration: clipSourceDuration(clip) };
      const local = (Number(playheadSec) || 0) - (Number(clip.timeline_start) || 0);
      clip.keyframes = normalizedOverlayKeyframes(keyframeClip, VIDEO_LAYER_TRANSFORM_DEFAULTS).filter((keyframe) => Math.abs(keyframe.time_sec - local) > 0.04);
      return body;
    });
  },

  moveClipKeyframe: (clipId, trackId, fromPlayheadSec, toPlayheadSec, { recordHistory = true } = {}) => {
    let changed = false;
    get().mutateProject((body) => {
      const track = getTrack(body, trackId);
      const clip = (track?.clips || []).find((item) => item.id === clipId);
      if (!clip || track?.locked) return body;
      const duration = clipSourceDuration(clip);
      const start = Number(clip.timeline_start) || 0;
      const frame = projectFrameStepSec(body);
      const fromLocal = (Number(fromPlayheadSec) || 0) - start;
      const targetLocal = Math.max(0, Math.min(duration, Math.round(((Number(toPlayheadSec) || 0) - start) / frame) * frame));
      const keyframeClip = { ...clip, duration };
      const keyframes = normalizedOverlayKeyframes(keyframeClip, VIDEO_LAYER_TRANSFORM_DEFAULTS);
      const moving = keyframes.find((point) => Math.abs(point.time_sec - fromLocal) <= Math.max(0.04, frame));
      if (!moving || Math.abs(moving.time_sec - targetLocal) < 0.000001) return body;
      clip.keyframes = [
        ...keyframes.filter((point) => point !== moving && Math.abs(point.time_sec - targetLocal) > Math.max(0.04, frame / 2)),
        { ...moving, time_sec: targetLocal },
      ].sort((a, b) => a.time_sec - b.time_sec);
      changed = true;
      return body;
    }, { recordHistory });
    return changed;
  },

  updateClipTransformAtTime: (clipId, trackId, playheadSec, patch) => {
    get().mutateProject((body) => {
      const clip = (getTrack(body, trackId)?.clips || []).find((item) => item.id === clipId);
      if (!clip) return body;
      const keyframeClip = { ...clip, duration: clipSourceDuration(clip) };
      const existing = keyframeNearPlayhead(keyframeClip, playheadSec, 0.04, VIDEO_LAYER_TRANSFORM_DEFAULTS);
      if (!existing) {
        clip.transform = { ...VIDEO_LAYER_TRANSFORM_DEFAULTS, ...(clip.transform || {}), ...patch };
        return body;
      }
      clip.keyframes = normalizedOverlayKeyframes(keyframeClip, VIDEO_LAYER_TRANSFORM_DEFAULTS).map((keyframe) =>
        Math.abs(keyframe.time_sec - existing.time_sec) <= 0.04 ? { ...keyframe, transform: { ...keyframe.transform, ...patch } } : keyframe,
      );
      return body;
    }, { recordHistory: false });
  },

  applyClipMotionPreset: (clipId, trackId, preset) => {
    let changed = false;
    get().mutateProject((body) => {
      const clip = (getTrack(body, trackId)?.clips || []).find((item) => item.id === clipId);
      if (!clip) return body;
      const keyframes = motionPresetKeyframes(clip.transform, clipSourceDuration(clip), preset, VIDEO_LAYER_TRANSFORM_DEFAULTS);
      if (!keyframes) return body;
      clip.keyframes = keyframes;
      changed = true;
      return body;
    });
    return changed;
  },

  updateOverlay: (overlayId, patch) => {
    get().mutateProject((body) => {
      const ov = (body.overlays || []).find((o) => o.id === overlayId);
      if (!ov) return body;
      Object.assign(ov, patch || {});
      return body;
    }, { recordHistory: false });
  },

  updateOverlayText: (overlayId, patch) => {
    get().mutateProject((body) => {
      const ov = (body.overlays || []).find((o) => o.id === overlayId);
      if (!ov || ov.type !== "text") return body;
      ov.text = { ...(ov.text || {}), ...patch };
      if (patch.content != null) {
        ov.meta = { ...(ov.meta || {}), name: String(patch.content), kind: "text" };
      }
      if (patch.preset_id != null) {
        ov.meta = { ...(ov.meta || {}), textStyleId: patch.preset_id };
      }
      return body;
    }, { recordHistory: false });
  },
}));
