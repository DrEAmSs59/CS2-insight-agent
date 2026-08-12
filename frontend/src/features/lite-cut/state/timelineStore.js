import { create } from "zustand";
import { useLiteCutEditorStore } from "./editorStore.js";
import { useLiteCutHistoryStore } from "./historyStore.js";
import { VIDEO_SCENE_TRANSFORM_DEFAULTS } from "./sceneTransform.js";
import { clampTimelineZoom } from "./timelineZoomUtils.js";
import {
  clipTransitionRef,
  overlayTransitionRef,
  TRANSITION_DURATION_DEFAULT,
  reconcileTransitionEvents,
  rewireTransitionExitEndpointsAfterSplit,
  resolveTransitionEvent,
  setNodeEdgeTransition,
  transitionEventForNodeEdge,
  transitionEventsForNode,
  updateTransitionEvent,
} from "./transitionModel.js";
import {
  buildAssetClip,
  buildLinkedAudioClip,
  buildRecordedClip,
  buildStandaloneAudioClip,
  canPlaceOnTrack,
  canSplitOverlaysAtPlayhead,
  canSplitTrackClipsAtPlayhead,
  canTrimClipEndToPlayhead,
  canTrimClipStartToPlayhead,
  canTrimOverlayToPlayhead,
  compactTrackGaps,
  findClipById,
  ensurePairedMediaTrack,
  getTrack,
  isAssetMediaItem,
  markerNearTime,
  mediaItemHasAudio,
  insertAudioTrack,
  insertPairedMediaTracks,
  newClipId,
  newOverlayId,
  nextMarker,
  nextEditPoint,
  nextAppendStart,
  linkedTimelineClipIds,
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
  sortClips,
  splitOverlaysAtPlayhead,
  splitTrackClipsAtPlayhead,
  timelineTotalSec,
  audioTracks,
  editableAudioTracks,
  editableVideoTracks,
  videoTracks,
} from "./timelineUtils.js";
import {
  clipMaxTimelineEnd,
  clipSourceDuration,
  clipSourceTimeForTimeline,
  clipTimelineEnd,
  ensureClipSourceDuration,
} from "../domain/timelineMath.js";
import { moveTimelineClipDrag } from "../domain/timelineClipDrag.js";
import { VISUAL_COLOR_MAX, VISUAL_COLOR_MIN, visualMaterialSupports } from "../domain/visualMaterial.js";
import {
  addTimelineMarker,
  activeTimelineSelectionIds,
  applyTimelineMotionPreset,
  buildSubtitleTimelineItems,
  canLinkTimelineClips,
  canMoveTimelineSelection,
  deleteTimelineMarker,
  groupTimelineItems,
  linkTimelineClips,
  moveTimelineSelection,
  moveTimelineAudioKeyframe,
  moveTimelineTransformKeyframe,
  nudgeTimelineItem,
  pasteTimelineClipboard,
  removeTimelineAudioKeyframe,
  removeTimelineTransformKeyframe,
  rippleDeleteOverlaySelection as rippleDeleteOverlaySelectionCommand,
  rippleDeleteTrackSelection as rippleDeleteTrackSelectionCommand,
  selectedTrimTargets as selectedTrimTargetsCommand,
  slipTimelineClip,
  splitTimelineSelection,
  snapTimelinePosition,
  timelineSelectionEntries as timelineSelectionEntriesCommand,
  trimTimelineSelection,
  ungroupTimelineItems,
  uniqueTimelineIds,
  unlinkTimelineClips,
  updateTimelineTransformAtTime,
  updateTimelineMarker,
  updateTimelineVolumeAtTime,
  upsertTimelineAudioKeyframe,
  upsertTimelineTransformKeyframe,
} from "../domain/timelineCommands.js";

function normalizedTransitionStyle(type, durationSec = TRANSITION_DURATION_DEFAULT) {
  const transitionType = String(type || "fade");
  if (transitionType === "cut") return { type: "cut", duration_sec: 0 };
  return { type: transitionType, duration_sec: Math.max(0, Number(durationSec) || 0) };
}

function transitionsMatch(a, b) {
  const left = normalizedTransitionStyle(a?.type || "cut", a?.duration_sec ?? 0);
  const right = normalizedTransitionStyle(b?.type || "cut", b?.duration_sec ?? 0);
  return left.type === right.type && Math.abs(left.duration_sec - right.duration_sec) <= 1e-6;
}

function normalizedColorStyle(color = {}) {
  return {
    brightness: Math.max(VISUAL_COLOR_MIN, Math.min(VISUAL_COLOR_MAX, Number(color?.brightness) || 0)),
    contrast: Math.max(VISUAL_COLOR_MIN, Math.min(VISUAL_COLOR_MAX, Number(color?.contrast) || 0)),
    saturation: Math.max(VISUAL_COLOR_MIN, Math.min(VISUAL_COLOR_MAX, Number(color?.saturation) || 0)),
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

function overlayTrackFor(body, overlay) {
  const trackId = String(overlay?.meta?.overlay_track_id || "ot1");
  const track = (body?.overlay_tracks || []).find((item) => String(item?.id) === trackId) || { id: trackId };
  return { track, trackId };
}

function selectedEditableVisualContext(body, state) {
  if (!state?.selectedClipId) return null;
  if (state.selectedTrackId !== "overlay") {
    const context = selectedEditableVideoContext(body, state.selectedClipId);
    return context ? { kind: "clip", node: context.clip, track: context.track, trackId: context.trackId } : null;
  }
  const node = (body?.overlays || []).find((item) => String(item?.id) === String(state.selectedClipId));
  if (!node) return null;
  const { track, trackId } = overlayTrackFor(body, node);
  if (track?.locked || track?.hidden) return null;
  return { kind: "overlay", node, track, trackId };
}

function visualStyleTargets(body, context, scope = "track", capability = null) {
  if (!context) return [];
  const targets = [];
  const includeAll = scope === "all";
  for (const track of body?.tracks || []) {
    if (track?.type !== "video" || track.locked || track.hidden) continue;
    if (!includeAll && (context.kind !== "clip" || String(track.id) !== String(context.trackId))) continue;
    for (const node of track.clips || []) {
      if (!capability || visualMaterialSupports(node, capability, { timelineClip: true })) {
        targets.push({ kind: "clip", node, track, trackId: String(track.id), ref: clipTransitionRef(track.id, node.id) });
      }
    }
  }
  for (const node of body?.overlays || []) {
    const { track, trackId } = overlayTrackFor(body, node);
    if (track?.locked || track?.hidden) continue;
    if (!includeAll && (context.kind !== "overlay" || String(trackId) !== String(context.trackId))) continue;
    if (!capability || visualMaterialSupports(node, capability)) {
      targets.push({ kind: "overlay", node, track, trackId, ref: overlayTransitionRef(node) });
    }
  }
  return targets;
}

function uniqueIds(ids = []) {
  return uniqueTimelineIds(ids);
}

function activeSelectionIds(state) {
  return activeTimelineSelectionIds(state);
}

function selectedVisualTransitionRef(body, state) {
  if (!state?.selectedClipId) return null;
  if (state.selectedTrackId === "overlay") {
    const overlay = (body?.overlays || []).find((item) => String(item?.id) === String(state.selectedClipId));
    return overlay ? overlayTransitionRef(overlay) : null;
  }
  const { clip, trackId } = findClipById(body, state.selectedClipId);
  const track = getTrack(body, trackId);
  return clip && track?.type === "video" ? clipTransitionRef(trackId, clip.id) : null;
}

function selectedVisualTransitionRefs(body, state) {
  const selected = new Set(activeSelectionIds(state).map(String));
  if (!selected.size && state?.selectedClipId) selected.add(String(state.selectedClipId));
  const refs = [];
  for (const track of body?.tracks || []) {
    if (track?.type !== "video" || track.locked || track.hidden) continue;
    for (const clip of track.clips || []) {
      if (selected.has(String(clip?.id))) refs.push(clipTransitionRef(track.id, clip.id));
    }
  }
  const overlayTracks = new Map((body?.overlay_tracks || []).map((track) => [String(track?.id || ""), track]));
  for (const overlay of body?.overlays || []) {
    if (!selected.has(String(overlay?.id))) continue;
    const row = overlayTracks.get(String(overlay?.meta?.overlay_track_id || "ot1"));
    if (row?.locked || row?.hidden) continue;
    refs.push(overlayTransitionRef(overlay));
  }
  return refs;
}

function clipPatchForTrack(patch, track) {
  if (!patch || typeof patch !== "object") return {};
  if (track?.type === "video") return patch;
  const next = {};
  for (const [key, value] of Object.entries(patch)) {
    if (key === "content_fit" || key === "crop") continue;
    next[key] = value;
  }
  return next;
}

function visualPatchForNode(patch, node, { timelineClip = false } = {}) {
  const next = { ...(patch || {}) };
  const capabilityFields = {
    crop: ["crop"],
    content_fit: ["content_fit"],
    color: ["color"],
    speed: ["speed"],
    speed_ramp: ["speed_keyframes"],
    reverse: ["reverse"],
    freeze: ["freeze_frame_sec"],
    audio: ["volume", "muted", "fade_in_sec", "fade_out_sec", "audio_keyframes", "preserve_pitch"],
  };
  for (const [capability, fields] of Object.entries(capabilityFields)) {
    if (visualMaterialSupports(node, capability, { timelineClip })) continue;
    for (const field of fields) delete next[field];
  }
  return next;
}

function timelineSelectionEntries(body, ids = []) {
  return timelineSelectionEntriesCommand(body, ids);
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

function setLinkedClipPair(video, audio) {
  video.muted = true;
  video.meta = { ...(video.meta || {}), linked_audio_clip_id: audio.id };
  audio.meta = { ...(audio.meta || {}), source_clip_id: video.id, linked_from_video: true };
}

function appendLinkedAudioClip(body, videoClip, preferredAudioTrackId = null) {
  const audioClip = buildLinkedAudioClip(videoClip, videoClip.timeline_start);
  if (!audioClip) return null;
  const duration = clipSourceDuration(audioClip);
  const preferredTrack = getTrack(body, preferredAudioTrackId);
  let track = preferredTrack?.type === "audio" && !preferredTrack.hidden && !preferredTrack.locked
    && canPlaceOnTrack(preferredTrack.clips, audioClip.timeline_start, duration)
    ? preferredTrack
    : editableAudioTracks(body).find((candidate) => (
    canPlaceOnTrack(candidate.clips, audioClip.timeline_start, duration)
  ));
  if (!track) {
    const trackId = insertAudioTrack(body, audioTracks(body).at(-1)?.id || null);
    track = getTrack(body, trackId);
  }
  if (!track || track.locked || !canPlaceOnTrack(track.clips, audioClip.timeline_start, duration)) return null;
  setLinkedClipPair(videoClip, audioClip);
  track.clips = sortClips([...(track.clips || []), audioClip]);
  return audioClip;
}

function clearLinkedVideoClip(clip) {
  const { linked_audio_clip_id, ...meta } = clip.meta || {};
  clip.meta = meta;
}

function clearLinkedAudioClip(clip) {
  const { source_clip_id, linked_from_video, ...meta } = clip.meta || {};
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

function selectedTrimTargets(body, selectedIds, side, playheadSec) {
  return selectedTrimTargetsCommand(body, selectedIds, side, playheadSec);
}

function rippleDeleteTrackSelection(track, selectedIds) {
  return rippleDeleteTrackSelectionCommand(track, selectedIds);
}

function rippleDeleteOverlaySelection(overlays, selectedIds) {
  return rippleDeleteOverlaySelectionCommand(overlays, selectedIds);
}

export const useLiteCutTimelineStore = create((set, get) => ({
  selectedClipId: null,
  selectedClipIds: [],
  selectedTransitionId: null,
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
    const command = addTimelineMarker(useLiteCutEditorStore.getState().body, get().playheadSec);
    if (!command.changed) return null;
    get().mutateProject(() => command.body);
    return command.markerId;
  },

  updateMarker: (markerId, patch) => {
    const command = updateTimelineMarker(useLiteCutEditorStore.getState().body, markerId, patch);
    if (!command.changed) return false;
    get().mutateProject(() => command.body);
    return true;
  },

  deleteMarker: (markerId) => {
    const command = deleteTimelineMarker(useLiteCutEditorStore.getState().body, markerId);
    if (!command.changed) return false;
    get().mutateProject(() => command.body);
    return true;
  },

  deleteMarkerNearPlayhead: () => {
    const body = useLiteCutEditorStore.getState().body;
    const marker = markerNearTime(body, get().playheadSec);
    if (!marker?.id) return false;
    return get().deleteMarker(marker.id);
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
    const command = nudgeTimelineItem(currentBody, selectedClipId, selectedTrackId, deltaSec);
    if (!command.changed) return false;
    get().mutateProject(() => command.body);
    return true;
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
    return slipTimelineClip(body, state.selectedClipId, deltaSec).changed;
  },

  slipSelectedBy: (deltaSec) => {
    if (!get().canSlipSelectedBy(deltaSec)) return false;
    const selectedClipId = get().selectedClipId;
    const command = slipTimelineClip(useLiteCutEditorStore.getState().body, selectedClipId, deltaSec);
    if (!command.changed) return false;
    get().mutateProject(() => command.body);
    return true;
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
    const body = useLiteCutEditorStore.getState().body;
    return canMoveTimelineSelection(body, selectedIds, deltaSec).allowed;
  },

  moveSelectionBy: (deltaSec, { recordHistory = true } = {}) => {
    const selectedIds = activeSelectionIds(get());
    const currentBody = useLiteCutEditorStore.getState().body;
    const command = moveTimelineSelection(currentBody, selectedIds, deltaSec);
    if (!command.changed) return false;
    let moved = false;
    get().mutateProject(() => {
      moved = true;
      return command.body;
    }, { recordHistory });
    return moved;
  },

  moveTrackClipByDrag: (input, { recordHistory = true } = {}) => {
    const command = moveTimelineClipDrag(useLiteCutEditorStore.getState().body, input);
    if (!command.changed) return false;
    get().mutateProject(() => command.body, { recordHistory });
    set({
      selectedClipId: command.selectedClipId,
      selectedClipIds: command.selectedIds,
      selectedTrackId: command.selectedTrackId,
      selectedTransitionId: null,
    });
    return true;
  },

  selectClip: (clipId, trackId = "v1") => {
    const ids = relatedTimelineItemIds(useLiteCutEditorStore.getState().body, clipId);
    set({ selectedClipId: clipId, selectedClipIds: ids, selectedTrackId: trackId, selectedTransitionId: null });
  },

  canGroupSelectedItems: () => activeSelectionIds(get()).length >= 2,

  groupSelectedItems: () => {
    const ids = activeSelectionIds(get());
    if (ids.length < 2) return false;
    const groupId = `grp-${crypto.randomUUID().slice(0, 12)}`;
    const command = groupTimelineItems(useLiteCutEditorStore.getState().body, ids, groupId);
    if (!command.changed) return false;
    get().mutateProject(() => command.body);
    return command.changed;
  },

  canUngroupSelectedItems: () => {
    const body = useLiteCutEditorStore.getState().body;
    return activeSelectionIds(get()).some((id) => groupedTimelineItemIds(body, id).length > 1);
  },

  ungroupSelectedItems: () => {
    const body = useLiteCutEditorStore.getState().body;
    const command = ungroupTimelineItems(body, activeSelectionIds(get()));
    if (!command.changed) return false;
    get().mutateProject(() => command.body);
    return command.changed;
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
    set({ selectedClipId, selectedClipIds: ids, selectedTrackId, selectedTransitionId: null });
    return true;
  },

  canLinkSelectedClips: () => {
    const state = get();
    const ids = activeSelectionIds(state);
    if (state.selectedTrackId === "overlay") return false;
    const body = useLiteCutEditorStore.getState().body;
    return canLinkTimelineClips(body, ids).allowed;
  },

  linkSelectedClips: () => {
    if (!get().canLinkSelectedClips()) return false;
    const ids = activeSelectionIds(get());
    const command = linkTimelineClips(useLiteCutEditorStore.getState().body, ids);
    if (!command.changed) return false;
    get().mutateProject(() => command.body);
    return command.changed;
  },

  canUnlinkSelectedClips: () => get().canSelectLinkedClips(),

  unlinkSelectedClips: () => {
    const { selectedClipId, selectedTrackId } = get();
    if (!selectedClipId || selectedTrackId === "overlay") return false;
    const command = unlinkTimelineClips(useLiteCutEditorStore.getState().body, selectedClipId);
    if (!command.changed) return false;
    get().mutateProject(() => command.body);
    return command.changed;
  },

  selectTrack: (trackId) => {
    const track = getTrack(useLiteCutEditorStore.getState().body, trackId);
    if (!track) return false;
    set({ selectedClipId: null, selectedClipIds: [], selectedTrackId: trackId, selectedTransitionId: null });
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
        selectedTransitionId: null,
      };
    });
  },

  selectOverlay: (overlayId) => {
    const ids = relatedTimelineItemIds(useLiteCutEditorStore.getState().body, overlayId);
    set({ selectedClipId: overlayId, selectedClipIds: ids, selectedTrackId: "overlay", selectedTransitionId: null });
  },

  selectTransition: (transitionId) => {
    const body = useLiteCutEditorStore.getState().body;
    const raw = (body?.transitions || []).find((item) => String(item?.id) === String(transitionId));
    const event = resolveTransitionEvent(body, raw);
    if (!event) return false;
    const endpoint = event.to || event.from;
    set({
      selectedTransitionId: event.id,
      selectedClipId: endpoint.id,
      selectedClipIds: [String(endpoint.id)],
      selectedTrackId: endpoint.kind === "overlay" ? "overlay" : endpoint.track_id,
      playheadSec: event.cut_sec,
      isPlaying: false,
    });
    return true;
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
      selectedTransitionId: null,
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
      set({ selectedClipId: null, selectedClipIds: [], selectedTransitionId: null });
      return false;
    }
    set({ selectedClipId: primaryId, selectedClipIds: nextIds, selectedTrackId: primaryTrackId, selectedTransitionId: null });
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
      set({ selectedClipId: null, selectedClipIds: [], selectedTransitionId: null });
      return false;
    }
    set({ selectedClipId: primaryId, selectedClipIds: nextIds, selectedTrackId: primaryTrackId, selectedTransitionId: null });
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
      set({ selectedClipId: null, selectedClipIds: [], selectedTransitionId: null });
      return false;
    }
    set({ selectedClipId: primaryId, selectedClipIds: nextIds, selectedTrackId: primaryTrackId, selectedTransitionId: null });
    return true;
  },

  clearSelection: () => set({ selectedClipId: null, selectedClipIds: [], selectedTransitionId: null }),

  mutateProject: (mutator, { recordHistory = true } = {}) => {
    const editor = useLiteCutEditorStore.getState();
    const { body } = editor;
    if (!body) return null;
    if (recordHistory) useLiteCutHistoryStore.getState().push(body);
    const next = reconcileTransitionEvents(mutator(structuredClone(body)));
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
        if (mediaItem.is_looping_animation) {
          return get().addOverlayFromAsset(mediaItem, { x: 0.5, y: 0.5, atTime: playheadSec });
        }
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
        .filter((asset) => (
          asset?.kind === "video"
          && asset?.has_alpha
          && /\.mov$/i.test(String(asset?.name || asset?.path || asset?.file_path || ""))
        ))
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
        clip.transform = overlay.transform ? { ...overlay.transform } : { ...VIDEO_SCENE_TRANSFORM_DEFAULTS };
        clip.keyframes = Array.isArray(overlay.keyframes) ? overlay.keyframes : [];
        clip.flip_horizontal = Boolean(overlay.flip_horizontal);
        clip.flip_vertical = Boolean(overlay.flip_vertical);
        for (const transition of body.transitions || []) {
          for (const edge of ["from", "to"]) {
            const endpoint = transition?.[edge];
            if (endpoint?.kind === "overlay" && String(endpoint.id) === String(overlay.id)) {
              transition[edge] = clipTransitionRef(target.id, clip.id);
            }
          }
        }
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
    let replacementSelection = null;
    get().mutateProject((body) => {
      const targetTrack = getTrack(body, selectedTrackId);
      const index = targetTrack?.clips?.findIndex((clip) => clip.id === selectedClipId) ?? -1;
      if (index < 0) return body;
      const old = targetTrack.clips[index];
      const source = isAsset ? buildAssetClip(mediaItem, old.timeline_start) : buildRecordedClip(mediaItem, old.timeline_start);
      const oldSourceDuration = Math.max(0.1, Number(old.trim_out) - (Number(old.trim_in) || 0) || clipSourceDuration(old));
      const newSourceDuration = Math.max(0.1, clipSourceDuration(source));
      const replacement = {
        ...old,
        source_type: source.source_type,
        source_id: source.source_id,
        file_path: source.file_path,
        trim_in: 0,
        trim_out: Math.min(oldSourceDuration, newSourceDuration),
        speed_keyframes: [],
        muted: targetTrack.type === "video" ? true : old.muted,
        meta: source.meta,
      };
      targetTrack.clips[index] = replacement;

      if (targetTrack.type === "video") {
        const linkedAudioId = old.meta?.linked_audio_clip_id;
        const linkedAudioEntry = linkedAudioId ? findClipById(body, linkedAudioId) : { clip: null, trackId: null };
        const linkedAudioTrack = linkedAudioEntry.trackId ? getTrack(body, linkedAudioEntry.trackId) : null;
        if (linkedAudioEntry.clip && linkedAudioTrack?.type === "audio") {
          linkedAudioTrack.clips = linkedAudioTrack.clips.filter((clip) => String(clip.id) !== String(linkedAudioEntry.clip.id));
        }
        clearLinkedVideoClip(replacement);
        if (mediaItemHasAudio(mediaItem)) {
          const linkedAudio = appendLinkedAudioClip(body, replacement, ensurePairedMediaTrack(body, targetTrack.id));
          if (linkedAudio) {
            replacementSelection = [replacement.id, linkedAudio.id];
          }
        } else {
          replacementSelection = [replacement.id];
        }
      }
      replaced = true;
      return body;
    });
    if (replaced && replacementSelection) {
      set({ selectedClipId: replacementSelection[0], selectedClipIds: replacementSelection, selectedTrackId });
    }
    return replaced;
  },

  addMediaAtTime: (mediaItem, trackId, atTime, { createBelow = false, createAbove = false, createNewTrack = false, audioOnly = false } = {}) => {
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
    start = snapTimelinePosition(start, editor.body, { enabled: snapEnabled });
    let newId = null;
    let newIds = [];
    let placedTrackId = trackId;
    get().mutateProject((body) => {
      const sourceClip = isAsset ? buildAssetClip(mediaItem, start) : buildRecordedClip(mediaItem, start);
      const placeAsSourceAudio = Boolean(audioOnly && mediaItemHasAudio(mediaItem));
      const clip = placeAsSourceAudio ? buildStandaloneAudioClip(sourceClip, start) : sourceClip;
      if (!clip || (audioOnly && !placeAsSourceAudio)) return body;
      const dur = clipSourceDuration(clip);
      let targetTrackId = trackId || videoTracks(body)[0]?.id || "v1";
      const isAudioPlacement = placeAsSourceAudio || (isAsset && (mediaItem.kind || "") === "audio");
      const isVideoMedia = !isAudioPlacement;
      if (isAudioPlacement) {
        targetTrackId = trackId || audioTracks(body)[0]?.id || "a1";
      }
      const hasLinkedAudio = isVideoMedia && mediaItemHasAudio(mediaItem);
      let preferredAudioTrackId = null;

      if (createNewTrack) {
        if (isAudioPlacement) {
          targetTrackId = insertAudioTrack(body, targetTrackId);
        } else if (hasLinkedAudio) {
          const pair = insertPairedMediaTracks(body, "video", targetTrackId, { before: createAbove });
          targetTrackId = pair?.videoTrackId || targetTrackId;
          preferredAudioTrackId = pair?.audioTrackId || null;
        } else if (createAbove && targetTrackId) {
          targetTrackId = insertVideoTrackBefore(body, targetTrackId);
        } else if (createBelow && targetTrackId) {
          targetTrackId = insertVideoTrack(body, targetTrackId);
        } else {
          targetTrackId = insertVideoTrack(body, targetTrackId);
        }
      }

      let track = getTrack(body, targetTrackId);
      if (!track || (isAudioPlacement ? track.type !== "audio" : track.type !== "video")) return body;
      if (track.locked) return body;
      if (!canPlaceOnTrack(track.clips, start, dur)) {
        if (createNewTrack) {
          if (isAudioPlacement) {
            targetTrackId = insertAudioTrack(body, targetTrackId);
          } else if (hasLinkedAudio) {
            const pair = insertPairedMediaTracks(body, "video", targetTrackId);
            targetTrackId = pair?.videoTrackId || targetTrackId;
            preferredAudioTrackId = pair?.audioTrackId || null;
          } else {
            targetTrackId = insertVideoTrack(body, targetTrackId);
          }
          track = getTrack(body, targetTrackId);
          if (!track) return body;
        } else {
          start = nextAppendStart(track.clips);
          clip.timeline_start = start;
        }
      }
      track.clips = sortClips([...(track.clips || []), clip]);
      if (hasLinkedAudio) {
        preferredAudioTrackId ||= ensurePairedMediaTrack(body, targetTrackId);
        const audioClip = appendLinkedAudioClip(body, clip, preferredAudioTrackId);
        if (audioClip) {
          newIds = [clip.id, audioClip.id];
        }
      }
      placedTrackId = targetTrackId;
      newId = clip.id;
      if (!newIds.length) newIds = [clip.id];
      return body;
    });
    if (newId) set({ selectedClipId: newId, selectedClipIds: newIds, selectedTrackId: placedTrackId });
  },

  addOverlayFromAsset: (assetItem, { x = 0.5, y = 0.5, atTime = null, overlayTrackId = null } = {}) => {
    if (!assetItem?.path && !assetItem?.file_path) return;
    const { playheadSec, snapEnabled } = get();
    const editor = useLiteCutEditorStore.getState();
    let start = Math.max(0, Number(atTime ?? playheadSec) || 0);
    start = snapTimelinePosition(start, editor.body, { enabled: snapEnabled });
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
    const isLoopingAnimation = kind === "video" && (
      Boolean(assetItem.is_looping_animation)
      || /\.(gif|webp)$/i.test(String(assetItem.name || path))
    );
    const overlayDur = dur;
    let newId = null;
    get().mutateProject((body) => {
      const ov = {
        id: newOverlayId(),
        type: kind === "webm" || kind === "video" ? "webm" : "sticker",
        timeline_start: start,
        duration: overlayDur,
        transform: { x, y, scale: 1, rotation: 0, width: nativeWidth, height: nativeHeight, opacity: 1 },
        keyframes: [],
        crop: { x: 0, y: 0, width: 1, height: 1 },
        content_fit: "fill",
        color: { brightness: 0, contrast: 0, saturation: 0, filter_preset: null },
        flip_horizontal: false,
        flip_vertical: false,
        asset_path: path,
        meta: { asset_id: assetItem.id, name: assetItem.name, kind, duration_sec: dur, source_width: sourceWidth || null, source_height: sourceHeight || null, source_fps: Number(assetItem.fps) || null, codec_name: assetItem.codec_name || null, preview_proxy_required: Boolean(assetItem.preview_proxy_required), preview_proxy_mode: assetItem.preview_proxy_mode || "direct", preview_segment_step_sec: Number(assetItem.preview_segment_step_sec) || null, preview_proxy_version: assetItem.preview_proxy_version || null, has_alpha: Boolean(assetItem.has_alpha), is_looping_animation: isLoopingAnimation, overlay_track_id: overlayTrackId || get().selectedOverlayTrackId || "ot1" },
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
    fontWeight = 700,
    lineHeight = 1.2,
    align = "center",
    overlayTrackId = null,
  } = {}) => {
    const { playheadSec, snapEnabled } = get();
    const editor = useLiteCutEditorStore.getState();
    let start = Math.max(0, Number(atTime ?? playheadSec) || 0);
    start = snapTimelinePosition(start, editor.body, { enabled: snapEnabled });
    let newId = null;
    const content = String(text || "Text").slice(0, 160);
    get().mutateProject((body) => {
      const ov = {
        id: newOverlayId(),
        type: "text",
        timeline_start: start,
        duration: 3,
        transform: { x, y, scale: 1, rotation: 0, width: 0.65, height: 0.18, opacity: 1 },
        text: {
          content,
          font_family: fontFamily || "微软雅黑",
          font_file: fontFile || null,
          font_size: Math.max(12, Math.min(1000, Number(fontSize) || 64)),
          font_weight: Math.max(100, Math.min(900, Number(fontWeight) || 700)),
          line_height: Math.max(0.5, Math.min(4, Number(lineHeight) || 1.2)),
          letter_spacing: 0,
          align: ["left", "center", "right"].includes(align) ? align : "center",
          preset_id: presetId,
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
    const overlays = buildSubtitleTimelineItems(rawText, options);
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
    const command = pasteTimelineClipboard(
      useLiteCutEditorStore.getState().body,
      clipboard,
      playheadSec,
      selectedTrackId,
    );
    if (!command.changed) return false;
    get().mutateProject(() => command.body);
    set({
      selectedClipId: command.selectedClipId,
      selectedClipIds: command.selectedIds,
      selectedTrackId: command.selectedTrackId,
    });
    return true;
  },

  insertPasteClipboard: () => {
    const { clipboard, playheadSec, selectedTrackId } = get();
    if (!clipboard) return false;
    if (clipboard.type === "multi") return get().pasteClipboard();
    const command = pasteTimelineClipboard(
      useLiteCutEditorStore.getState().body,
      clipboard,
      playheadSec,
      selectedTrackId,
      { ripple: true },
    );
    if (!command.changed) return false;
    get().mutateProject(() => command.body);
    set({
      selectedClipId: command.selectedClipId,
      selectedClipIds: command.selectedIds,
      selectedTrackId: command.selectedTrackId,
    });
    return true;
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
    const { selectedClipId, selectedTrackId, playheadSec } = state;
    if (!selectedClipId) return;
    const command = splitTimelineSelection(
      useLiteCutEditorStore.getState().body,
      activeSelectionIds(state),
      playheadSec,
    );
    if (!command.changed) return false;
    get().mutateProject(() => command.body);
    set({
      selectedClipId: command.selectedClipId,
      selectedClipIds: command.selectedIds,
      selectedTrackId: command.selectedTrackId || selectedTrackId,
    });
    return true;
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
        for (const pair of overlayResult.splitPairs || []) rightIds.set(pair.id, pair.rightId);
        if (!firstNewId && overlayResult.newIds[0]) {
          firstNewId = overlayResult.newIds[0];
          firstTrackId = "overlay";
        }
      }
      restoreLinksAfterSplit(body, pairs, rightIds);
      rewireTransitionExitEndpointsAfterSplit(body, rightIds);
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
    const { playheadSec } = state;
    const body = useLiteCutEditorStore.getState().body;
    const command = trimTimelineSelection(body, selectedIds, "start", playheadSec);
    if (!command.changed) return false;
    get().mutateProject(() => command.body);
    return true;
  },

  trimSelectedEndToPlayhead: () => {
    if (!get().canTrimSelectedEndToPlayhead()) return false;
    const state = get();
    const selectedIds = activeSelectionIds(state);
    const { playheadSec } = state;
    const body = useLiteCutEditorStore.getState().body;
    const command = trimTimelineSelection(body, selectedIds, "end", playheadSec);
    if (!command.changed) return false;
    get().mutateProject(() => command.body);
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
      const idSet = new Set((selectedIds.length ? selectedIds : [selectedClipId]).map(String));
      for (const track of body.tracks || []) {
        if (track.locked || track.hidden) continue;
        for (const clip of track.clips || []) {
          if (!idSet.has(String(clip.id))) continue;
          const trackPatch = clipPatchForTrack(patch, track);
          const nodePatch = track.type === "video"
            ? visualPatchForNode(trackPatch, clip, { timelineClip: true })
            : trackPatch;
          if (Object.keys(nodePatch).length) Object.assign(clip, nodePatch);
        }
      }
      for (const overlay of body.overlays || []) {
        if (!idSet.has(String(overlay.id))) continue;
        const { track } = overlayTrackFor(body, overlay);
        if (track?.locked || track?.hidden) continue;
        const nodePatch = visualPatchForNode(patch, overlay);
        if (Object.keys(nodePatch).length) Object.assign(overlay, nodePatch);
      }
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
    const command = upsertTimelineAudioKeyframe(useLiteCutEditorStore.getState().body, { clipId, trackId, playheadSec });
    if (command.changed) get().mutateProject(() => command.body);
  },

  removeClipAudioKeyframe: (clipId, trackId, playheadSec) => {
    const command = removeTimelineAudioKeyframe(useLiteCutEditorStore.getState().body, { clipId, trackId, playheadSec });
    if (command.changed) get().mutateProject(() => command.body);
  },

  moveClipAudioKeyframe: (clipId, trackId, fromPlayheadSec, toPlayheadSec, { recordHistory = true } = {}) => {
    const command = moveTimelineAudioKeyframe(useLiteCutEditorStore.getState().body, {
      clipId,
      trackId,
      fromPlayheadSec,
      toPlayheadSec,
    });
    if (!command.changed) return false;
    get().mutateProject(() => command.body, { recordHistory });
    return true;
  },

  updateClipVolumeAtTime: (clipId, trackId, playheadSec, volume) => {
    const command = updateTimelineVolumeAtTime(useLiteCutEditorStore.getState().body, {
      clipId,
      trackId,
      playheadSec,
      volume,
    });
    if (command.changed) get().mutateProject(() => command.body, { recordHistory: false });
  },

  updateSelectedTransition: (type, durationSec = 0.4) => {
    const state = get();
    if (!state.selectedClipId) return;
    get().mutateProject((body) => {
      if (state.selectedTransitionId) {
        updateTransitionEvent(body, state.selectedTransitionId, { type, duration_sec: durationSec });
        return body;
      }
      for (const ref of selectedVisualTransitionRefs(body, state)) {
        setNodeEdgeTransition(body, ref, "out", type, durationSec);
      }
      return body;
    });
  },

  updateSelectedTransitionType: (type) => {
    const state = get();
    if (!state.selectedClipId) return;
    get().mutateProject((body) => {
      if (state.selectedTransitionId) {
        updateTransitionEvent(body, state.selectedTransitionId, { type });
        return body;
      }
      for (const ref of selectedVisualTransitionRefs(body, state)) {
        const incoming = transitionEventForNodeEdge(body, ref, "in");
        const outgoing = transitionEventForNodeEdge(body, ref, "out");
        setNodeEdgeTransition(body, ref, "in", type, incoming?.duration_sec || TRANSITION_DURATION_DEFAULT);
        setNodeEdgeTransition(body, ref, "out", type, outgoing?.duration_sec || TRANSITION_DURATION_DEFAULT);
      }
      return body;
    });
  },

  updateSelectedTransitionDuration: (edge, durationSec) => {
    const state = get();
    if (!state.selectedClipId || !["in", "out"].includes(edge)) return;
    get().mutateProject((body) => {
      if (state.selectedTransitionId) {
        updateTransitionEvent(body, state.selectedTransitionId, { duration_sec: durationSec });
        return body;
      }
      const ref = selectedVisualTransitionRef(body, state);
      if (!ref) return body;
      const existing = transitionEventForNodeEdge(body, ref, edge);
      const alternate = transitionEventForNodeEdge(body, ref, edge === "in" ? "out" : "in");
      setNodeEdgeTransition(body, ref, edge, existing?.type || alternate?.type || "fade", durationSec);
      return body;
    }, { recordHistory: false });
  },

  canApplySelectedTransitionToScope: (scope = "track", type = "fade", durationSec = 0.4) => {
    const body = useLiteCutEditorStore.getState().body;
    const state = get();
    const context = selectedEditableVisualContext(body, state);
    if (!context) return false;
    const target = normalizedTransitionStyle(type, durationSec);
    return visualStyleTargets(body, context, scope, "transition").some(({ ref }) => {
      const event = transitionEventForNodeEdge(body, ref, "out");
      return !transitionsMatch(event, target);
    });
  },

  applySelectedTransitionToScope: (scope = "track", type = "fade", durationSec = 0.4) => {
    if (!get().canApplySelectedTransitionToScope(scope, type, durationSec)) return false;
    const state = get();
    const target = normalizedTransitionStyle(type, durationSec);
    let changed = false;
    get().mutateProject((body) => {
      const context = selectedEditableVisualContext(body, state);
      if (!context) return body;
      for (const { ref } of visualStyleTargets(body, context, scope, "transition")) {
        if (transitionsMatch(transitionEventForNodeEdge(body, ref, "out"), target)) continue;
        setNodeEdgeTransition(body, ref, "out", target.type, target.duration_sec);
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
      const idSet = new Set((selectedIds.length ? selectedIds : [selectedClipId]).map(String));
      for (const track of body.tracks || []) {
        if (track.type !== "video" || track.locked || track.hidden) continue;
        for (const clip of track.clips || []) {
          if (!idSet.has(String(clip.id)) || !visualMaterialSupports(clip, "color", { timelineClip: true })) continue;
          clip.color = { ...(clip.color || {}), ...colorPatch };
        }
      }
      for (const overlay of body.overlays || []) {
        if (!idSet.has(String(overlay.id)) || !visualMaterialSupports(overlay, "color")) continue;
        const { track } = overlayTrackFor(body, overlay);
        if (track?.locked || track?.hidden) continue;
        overlay.color = { ...(overlay.color || {}), ...colorPatch };
      }
      return body;
    }, { recordHistory: false });
  },

  canApplySelectedColorToScope: (scope = "track", color = {}) => {
    const body = useLiteCutEditorStore.getState().body;
    const state = get();
    const context = selectedEditableVisualContext(body, state);
    if (!context) return false;
    const target = normalizedColorStyle(color);
    return visualStyleTargets(body, context, scope, "color").some(({ node }) => !colorsMatch(node.color, target));
  },

  applySelectedColorToScope: (scope = "track", color = {}) => {
    if (!get().canApplySelectedColorToScope(scope, color)) return false;
    const state = get();
    const target = normalizedColorStyle(color);
    let changed = false;
    get().mutateProject((body) => {
      const context = selectedEditableVisualContext(body, state);
      if (!context) return body;
      for (const { node } of visualStyleTargets(body, context, scope, "color")) {
        if (colorsMatch(node.color, target)) continue;
        node.color = { ...target };
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
        start = snapTimelinePosition(start, body, {
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
          start = snapTimelinePosition(start, body, { enabled: get().snapEnabled, playheadSec });
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
        start = snapTimelinePosition(start, body, { enabled: get().snapEnabled, playheadSec });
      }
      if (!canPlaceOnTrack(toTrack.clips, start, dur)) return body;
      fromTrack.clips = (fromTrack.clips || []).filter((c) => c.id !== clipId);
      clip.timeline_start = start;
      toTrack.clips = sortClips([...(toTrack.clips || []), clip]);
      ok = true;
      return body;
    }, { recordHistory });
    if (ok) {
      const selectedClipIds = linkedTimelineClipIds(useLiteCutEditorStore.getState().body, clipId);
      set({ selectedClipId: clipId, selectedClipIds: selectedClipIds.length ? selectedClipIds : [clipId], selectedTrackId: finalTrackId });
    }
  },

  moveOverlayToTime: (overlayId, newStart, { snap = true, recordHistory = true } = {}) => {
    const { playheadSec } = get();
    get().mutateProject((body) => {
      const ov = (body.overlays || []).find((o) => o.id === overlayId);
      if (!ov) return body;
      let start = Math.max(0, newStart);
      if (snap) {
        start = snapTimelinePosition(start, body, {
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
            const previousDuration = Number(candidate.meta?.duration_sec);
            const previousTrimOut = Number(candidate.trim_out);
            const usedPreviousSourceEnd = Number.isFinite(previousDuration)
              && previousDuration > 0.05
              && Number.isFinite(previousTrimOut)
              && Math.abs(previousTrimOut - previousDuration) <= 0.05;
            candidate.meta = { ...(candidate.meta || {}), duration_sec: real };
            const trimIn = Math.max(0, Math.min(Number(candidate.trim_in) || 0, Math.max(0, real - 0.1)));
            const trimOut = previousTrimOut;
            candidate.trim_in = trimIn;
            if (real > previousDuration + 0.05 && usedPreviousSourceEnd) {
              // When a fallback/proxy duration is corrected upward, a clip that
              // previously ended at that false source boundary was untrimmed.
              // Keep it untrimmed by moving the end to the real source duration.
              candidate.trim_out = real;
            } else if (!Number.isFinite(trimOut) || trimOut > real || trimOut <= trimIn) {
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
    const command = upsertTimelineTransformKeyframe(useLiteCutEditorStore.getState().body, {
      kind: "overlay", itemId: overlayId, playheadSec,
    });
    if (command.changed) get().mutateProject(() => command.body);
  },

  removeOverlayKeyframe: (overlayId, playheadSec) => {
    const command = removeTimelineTransformKeyframe(useLiteCutEditorStore.getState().body, {
      kind: "overlay", itemId: overlayId, playheadSec,
    });
    if (command.changed) get().mutateProject(() => command.body);
  },

  moveOverlayKeyframe: (overlayId, fromPlayheadSec, toPlayheadSec, { recordHistory = true } = {}) => {
    const command = moveTimelineTransformKeyframe(useLiteCutEditorStore.getState().body, {
      kind: "overlay", itemId: overlayId, fromPlayheadSec, toPlayheadSec,
    });
    if (!command.changed) return false;
    get().mutateProject(() => command.body, { recordHistory });
    return true;
  },

  updateOverlayTransformAtTime: (overlayId, playheadSec, patch) => {
    const command = updateTimelineTransformAtTime(useLiteCutEditorStore.getState().body, {
      kind: "overlay", itemId: overlayId, playheadSec, patch,
    });
    if (command.changed) get().mutateProject(() => command.body, { recordHistory: false });
  },

  applyOverlayMotionPreset: (overlayId, preset) => {
    const command = applyTimelineMotionPreset(useLiteCutEditorStore.getState().body, {
      kind: "overlay", itemId: overlayId, preset,
    });
    if (!command.changed) return false;
    get().mutateProject(() => command.body);
    return true;
  },

  upsertClipKeyframe: (clipId, trackId, playheadSec) => {
    const command = upsertTimelineTransformKeyframe(useLiteCutEditorStore.getState().body, {
      kind: "clip", itemId: clipId, trackId, playheadSec,
    });
    if (command.changed) get().mutateProject(() => command.body);
  },

  removeClipKeyframe: (clipId, trackId, playheadSec) => {
    const command = removeTimelineTransformKeyframe(useLiteCutEditorStore.getState().body, {
      kind: "clip", itemId: clipId, trackId, playheadSec,
    });
    if (command.changed) get().mutateProject(() => command.body);
  },

  moveClipKeyframe: (clipId, trackId, fromPlayheadSec, toPlayheadSec, { recordHistory = true } = {}) => {
    const command = moveTimelineTransformKeyframe(useLiteCutEditorStore.getState().body, {
      kind: "clip", itemId: clipId, trackId, fromPlayheadSec, toPlayheadSec,
    });
    if (!command.changed) return false;
    get().mutateProject(() => command.body, { recordHistory });
    return true;
  },

  updateClipTransformAtTime: (clipId, trackId, playheadSec, patch) => {
    const command = updateTimelineTransformAtTime(useLiteCutEditorStore.getState().body, {
      kind: "clip", itemId: clipId, trackId, playheadSec, patch,
    });
    if (command.changed) get().mutateProject(() => command.body, { recordHistory: false });
  },

  applyClipMotionPreset: (clipId, trackId, preset) => {
    const command = applyTimelineMotionPreset(useLiteCutEditorStore.getState().body, {
      kind: "clip", itemId: clipId, trackId, preset,
    });
    if (!command.changed) return false;
    get().mutateProject(() => command.body);
    return true;
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
