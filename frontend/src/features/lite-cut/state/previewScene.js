import {
  resolveAudioPreviewItems,
  resolveAudioPreviewPreloadItems,
  resolveBaseVideoTrackId,
  resolveTopVideoPlaybackAt,
  resolveTransitionEndpointPlayback,
  resolveVideoUnderlayPlaybackAt,
  resolveVideoUnderlayPlaybacksAt,
} from "./playbackUtils.js";
import { overlaysActiveAt } from "./timelineUtils.js";
import {
  activeTransitionEvents,
  overlayTransitionRef,
  transitionRefKey,
} from "./transitionModel.js";

function transitionPreviewProjection(body, time, normalTop) {
  const events = activeTransitionEvents(body, time);
  const event = events[0] || null;
  if (!event) return { event: null, top: normalTop, companion: null };

  const fromPlayback = event.from?.kind === "clip"
    ? resolveTransitionEndpointPlayback(body, event.from, time)
    : null;
  const toPlayback = event.to?.kind === "clip"
    ? resolveTransitionEndpointPlayback(body, event.to, time)
    : null;

  if (fromPlayback && toPlayback) {
    const sameTrack = event.from?.track_id === event.to?.track_id;
    const fromUpper = Number(event.fromNode?.layer) > Number(event.toNode?.layer);
    // A same-track boundary owns one stable primary decoder for the complete
    // event.  Keeping the outgoing clip primary prevents the transition-start
    // frame from replacing A with a newly mounted B player.  B is the stable
    // companion that was already prewarmed before the event and is promoted
    // only after the transition has fully completed.
    const topRole = sameTrack ? "from" : fromUpper ? "from" : "to";
    const topPlayback = topRole === "from" ? fromPlayback : toPlayback;
    const companionPlayback = topRole === "from" ? toPlayback : fromPlayback;
    const companionRole = topRole === "from" ? "to" : "from";
    return {
      event,
      top: topPlayback,
      companion: {
        ...companionPlayback,
        transitionEventId: event.id,
        transitionType: event.type,
        transitionDuration: event.duration_sec,
        transitionRole: companionRole,
        progress: event.progress,
        freezePlayback: Boolean(companionPlayback.freezePlayback),
      },
      nodeTransition: { type: event.type, role: topRole, progress: event.progress, eventId: event.id, mode: event.mode, stack: "upper" },
      kernel: sameTrack ? "canvas" : "stack",
    };
  }
  const top = toPlayback || fromPlayback || normalTop;
  const role = toPlayback ? "to" : fromPlayback ? "from" : null;
  const currentNode = role ? event[`${role}Node`] : null;
  const otherNode = role ? event[role === "to" ? "fromNode" : "toNode"] : null;
  const stack = event.mode === "boundary" && currentNode && otherNode
    ? (Number(currentNode.layer) > Number(otherNode.layer) || (Number(currentNode.layer) === Number(otherNode.layer) && role === "to") ? "upper" : "lower")
    : null;
  return {
    event,
    top,
    companion: null,
    nodeTransition: role ? { type: event.type, role, progress: event.progress, eventId: event.id, mode: event.mode, stack } : null,
  };
}

function transitionAwareOverlays(body, time, events) {
  const active = overlaysActiveAt(body, time);
  const byId = new Map(active.map((overlay) => [String(overlay.id), overlay]));
  for (const event of events) {
    for (const endpoint of [event.from, event.to]) {
      if (endpoint?.kind !== "overlay") continue;
      const overlay = (body?.overlays || []).find((item) => String(item?.id) === String(endpoint.id));
      if (overlay) byId.set(String(overlay.id), overlay);
    }
  }
  return [...byId.values()].map((overlay) => {
    const key = transitionRefKey(overlayTransitionRef(overlay));
    for (const event of events) {
      if (transitionRefKey(event.from) === key) return { ...overlay, _transition_state: { type: event.type, role: "from", progress: event.progress, eventId: event.id, mode: event.mode, stack: event.mode === "boundary" ? (Number(event.fromNode?.layer) > Number(event.toNode?.layer) ? "upper" : "lower") : null } };
      if (transitionRefKey(event.to) === key) return { ...overlay, _transition_state: { type: event.type, role: "to", progress: event.progress, eventId: event.id, mode: event.mode, stack: event.mode === "boundary" ? (Number(event.toNode?.layer) >= Number(event.fromNode?.layer) ? "upper" : "lower") : null } };
    }
    return overlay;
  });
}

/** Pure project + time projection shared by every preview adapter. */
export function buildPreviewScene(
  body,
  timelineSec,
  { masterVolume = 1, audioPreloadLeadSec = 1.5 } = {},
) {
  const time = Math.max(0, Number(timelineSec) || 0);
  const normalTop = resolveTopVideoPlaybackAt(body, time);
  const transitionProjection = transitionPreviewProjection(body, time, normalTop);
  const top = transitionProjection.top;
  const transitionEvents = activeTransitionEvents(body, time);
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
    overlays: transitionAwareOverlays(body, time, transitionEvents),
    transitionEvent: transitionProjection.event,
    transitionCompanion: transitionProjection.companion,
    nodeTransition: transitionProjection.nodeTransition || null,
    transitionKernel: transitionProjection.kernel || "node",
    audio: activeAudio,
    audioPreload,
  };
}
