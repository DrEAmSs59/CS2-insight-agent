import {
  canPlaceOnTrack,
  ensurePairedMediaTrack,
  findClipById,
  getTrack,
  insertAudioTrack,
  insertPairedMediaTracks,
  insertVideoTrack,
  linkedTimelineClipIds,
  sortClips,
} from "../state/timelineUtils.js";
import { clipSourceDuration } from "./timelineMath.js";

function unchanged(body, reason, selectedIds = []) {
  return {
    changed: false,
    body,
    reason,
    selectedIds,
    selectedClipId: null,
    selectedTrackId: null,
  };
}

function clipEntries(body) {
  const entries = new Map();
  for (const track of body?.tracks || []) {
    for (const clip of track.clips || []) {
      entries.set(String(clip.id), { track, clip });
    }
  }
  return entries;
}

/**
 * One atomic command for V/A clip dragging.
 *
 * The grabbed clip may change to another track of the same type. Its linked
 * A/V counterpart moves to the corresponding opposite-type track while every
 * other selected clip keeps its own track. Collision checks run against the
 * complete final arrangement before any change is returned.
 */
export function moveTimelineClipDrag(body, {
  clipId,
  fromTrackId,
  toTrackId,
  newStart,
  selectionIds = [],
  createBelow = false,
} = {}) {
  const primaryId = String(clipId || "");
  const source = findClipById(body, primaryId);
  const sourceTrack = getTrack(body, fromTrackId);
  const targetTrack = getTrack(body, toTrackId);
  if (!primaryId || !source.clip || !sourceTrack || String(source.trackId) !== String(fromTrackId)) {
    return unchanged(body, "clip_not_found", primaryId ? [primaryId] : []);
  }
  if (!targetTrack) return unchanged(body, "target_track_not_found", [primaryId]);
  if (!["video", "audio"].includes(sourceTrack.type) || targetTrack.type !== sourceTrack.type) {
    return unchanged(body, "track_type_mismatch", [primaryId]);
  }
  if (sourceTrack.locked || targetTrack.locked) return unchanged(body, "track_locked", [primaryId]);

  const start = Number(newStart);
  if (!Number.isFinite(start) || start < 0) return unchanged(body, "before_timeline_start", [primaryId]);
  const delta = start - (Number(source.clip.timeline_start) || 0);

  const requested = (selectionIds || []).map(String);
  const selectedContainsPrimary = requested.includes(primaryId);
  const linkedIds = linkedTimelineClipIds(body, primaryId).map(String);
  const movedIds = new Set([
    ...linkedIds,
    ...(selectedContainsPrimary ? requested : [primaryId]),
  ]);

  const entries = clipEntries(body);
  const linkedCounterpartIds = new Set(
    linkedIds.filter((id) => {
      const entry = entries.get(id);
      return id !== primaryId && entry?.track?.type && entry.track.type !== sourceTrack.type;
    }),
  );
  for (const id of [...movedIds]) {
    const entry = entries.get(id);
    if (!entry) {
      movedIds.delete(id);
      continue;
    }
    if (entry.track.locked) return unchanged(body, "track_locked", [...movedIds]);
  }
  movedIds.add(primaryId);

  const changesTrack = createBelow || String(fromTrackId) !== String(toTrackId);
  if (!changesTrack && Math.abs(delta) <= 1e-6) {
    return unchanged(body, "no_change", [...movedIds]);
  }

  const next = structuredClone(body);
  let finalTrackId = String(toTrackId);
  let counterpartTrackId = null;
  if (createBelow) {
    if (linkedCounterpartIds.size) {
      const pair = insertPairedMediaTracks(next, sourceTrack.type, toTrackId);
      finalTrackId = pair?.primaryTrackId || finalTrackId;
      counterpartTrackId = pair?.counterpartTrackId || null;
    } else {
      finalTrackId = sourceTrack.type === "audio"
        ? insertAudioTrack(next, toTrackId)
        : insertVideoTrack(next, toTrackId);
    }
  } else if (changesTrack && linkedCounterpartIds.size) {
    counterpartTrackId = ensurePairedMediaTrack(next, finalTrackId);
  }

  const movingEntries = clipEntries(next);
  const affectedTrackIds = new Set();
  for (const id of movedIds) affectedTrackIds.add(String(movingEntries.get(id)?.track?.id || ""));
  affectedTrackIds.add(finalTrackId);
  if (counterpartTrackId) affectedTrackIds.add(counterpartTrackId);

  const placements = new Map();
  for (const id of movedIds) {
    const entry = movingEntries.get(id);
    if (!entry) continue;
    placements.set(id, {
      clip: entry.clip,
      trackId: id === primaryId
        ? finalTrackId
        : changesTrack && linkedCounterpartIds.has(id) && counterpartTrackId
          ? counterpartTrackId
          : String(entry.track.id),
      start: (Number(entry.clip.timeline_start) || 0) + delta,
    });
  }

  for (const placement of placements.values()) {
    if (placement.start < -1e-6) return unchanged(body, "before_timeline_start", [...movedIds]);
    const destination = getTrack(next, placement.trackId);
    if (!destination || destination.locked) return unchanged(body, "track_locked", [...movedIds]);
  }

  for (const trackId of affectedTrackIds) {
    if (!trackId) continue;
    const track = getTrack(next, trackId);
    if (!track) return unchanged(body, "target_track_not_found", [...movedIds]);
    const arranged = (track.clips || []).filter((clip) => !movedIds.has(String(clip.id)));
    const incoming = [...placements.values()]
      .filter((placement) => placement.trackId === trackId)
      .sort((left, right) => left.start - right.start);
    for (const placement of incoming) {
      const duration = clipSourceDuration(placement.clip);
      if (!canPlaceOnTrack(arranged, placement.start, duration)) {
        return unchanged(body, "track_collision", [...movedIds]);
      }
      placement.clip.timeline_start = Math.max(0, placement.start);
      arranged.push(placement.clip);
    }
    track.clips = sortClips(arranged);
  }

  return {
    changed: true,
    body: next,
    reason: null,
    selectedIds: [...movedIds],
    selectedClipId: primaryId,
    selectedTrackId: finalTrackId,
  };
}
