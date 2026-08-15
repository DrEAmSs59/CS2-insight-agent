import effectContract from "../../../../../backend/app/features/lite_cut/contracts/lite_cut_effect_contract.json";
import { clipSourceDuration } from "../domain/timelineMath.js";

const contract = effectContract.transition_model || {};
const limits = contract.limits || {};

export const TRANSITION_MODEL_VERSION = Number(contract.version) || 1;
export const TRANSITION_DURATION_MIN = Number(limits.duration_min) || 0.05;
export const TRANSITION_DURATION_MAX = Number(limits.duration_max) || 10;
export const TRANSITION_DURATION_DEFAULT = Number(limits.duration_default) || 0.4;
export const TRANSITION_BOUNDARY_EPSILON = Number(limits.boundary_epsilon) || 0.05;
export const TRANSITION_TYPES = Object.freeze((contract.types || []).map((item) => String(item.id)));
export const TRANSITION_TYPE_SET = new Set(TRANSITION_TYPES);

function clamp(value, min, max) {
  return Math.max(min, Math.min(max, Number(value) || 0));
}

function normalizeTransitionType(value) {
  const raw = String(value || "fade").toLowerCase();
  return TRANSITION_TYPE_SET.has(raw) ? raw : "fade";
}

export function normalizeTransitionSpec(type, durationSec = TRANSITION_DURATION_DEFAULT) {
  const normalizedType = normalizeTransitionType(type);
  if (normalizedType === "cut") return { type: "cut", duration_sec: 0, easing: "linear" };
  return {
    type: normalizedType,
    duration_sec: clamp(durationSec, TRANSITION_DURATION_MIN, TRANSITION_DURATION_MAX),
    easing: "linear",
  };
}

export function transitionRefKey(ref) {
  if (!ref || !ref.kind || !ref.id) return "";
  return `${String(ref.kind)}:${String(ref.track_id || "")}:${String(ref.id)}`;
}

export function transitionRefsEqual(left, right) {
  return transitionRefKey(left) === transitionRefKey(right);
}

export function clipTransitionRef(trackId, clipId) {
  return { kind: "clip", track_id: String(trackId), id: String(clipId) };
}

export function overlayTransitionRef(overlay) {
  return {
    kind: "overlay",
    track_id: String(overlay?.meta?.overlay_track_id || "ot1"),
    id: String(overlay?.id || ""),
  };
}

export function visualTransitionNodes(body) {
  const nodes = [];
  let layer = 0;
  // Project tracks are stored in UI top-to-bottom order, while the scene is
  // composited bottom-to-top. Every clip on one row shares its z layer.
  for (const track of [...(body?.tracks || [])].reverse()) {
    if (track?.type !== "video") continue;
    for (const clip of track.clips || []) {
      const start = Math.max(0, Number(clip?.timeline_start) || 0);
      const duration = Math.max(0, clipSourceDuration(clip));
      nodes.push({
        ref: clipTransitionRef(track.id, clip.id),
        node: clip,
        track,
        rowId: String(track.id),
        start,
        end: start + duration,
        duration,
        layer,
      });
    }
    layer += 1;
  }
  for (const overlay of body?.overlays || []) {
    const start = Math.max(0, Number(overlay?.timeline_start) || 0);
    const duration = Math.max(0, Number(overlay?.duration) || 0);
    nodes.push({
      ref: overlayTransitionRef(overlay),
      node: overlay,
      track: null,
      rowId: String(overlay?.meta?.overlay_track_id || "ot1"),
      start,
      end: start + duration,
      duration,
      layer: layer++,
    });
  }
  return nodes;
}

export function findVisualTransitionNode(body, ref) {
  const key = transitionRefKey(ref);
  return key ? visualTransitionNodes(body).find((entry) => transitionRefKey(entry.ref) === key) || null : null;
}

function eventId(from, to, suffix = "event") {
  const left = transitionRefKey(from) || "canvas";
  const right = transitionRefKey(to) || "canvas";
  return `tr-${suffix}-${left}-${right}`.replace(/[^a-zA-Z0-9_-]+/g, "-").slice(0, 150);
}

function normalizeRef(ref) {
  if (!ref || !["clip", "overlay"].includes(String(ref.kind)) || !String(ref.id || "")) return null;
  return {
    kind: String(ref.kind),
    track_id: String(ref.track_id || (ref.kind === "overlay" ? "ot1" : "")),
    id: String(ref.id),
  };
}

export function normalizeTransitionEvent(raw, index = 0) {
  if (!raw || typeof raw !== "object") return null;
  const from = normalizeRef(raw.from);
  const to = normalizeRef(raw.to);
  if (!from && !to) return null;
  const spec = normalizeTransitionSpec(raw.type, raw.duration_sec);
  if (spec.type === "cut") return null;
  return {
    id: String(raw.id || eventId(from, to, String(index))),
    type: spec.type,
    duration_sec: spec.duration_sec,
    easing: "linear",
    from,
    to,
  };
}

export function resolveTransitionEvent(body, rawEvent) {
  const event = normalizeTransitionEvent(rawEvent);
  if (!event) return null;
  const fromNode = event.from ? findVisualTransitionNode(body, event.from) : null;
  const toNode = event.to ? findVisualTransitionNode(body, event.to) : null;
  if ((event.from && !fromNode) || (event.to && !toNode)) return null;

  let mode = "enter";
  let cutSec = toNode?.start ?? 0;
  let maxDuration = toNode?.duration ?? TRANSITION_DURATION_MAX;
  if (fromNode && toNode) {
    if (Math.abs(fromNode.end - toNode.start) > TRANSITION_BOUNDARY_EPSILON) return null;
    mode = "boundary";
    cutSec = (fromNode.end + toNode.start) / 2;
    maxDuration = Math.max(
      TRANSITION_DURATION_MIN,
      Math.min(TRANSITION_DURATION_MAX, fromNode.duration * 2, toNode.duration * 2),
    );
  } else if (fromNode) {
    mode = "exit";
    cutSec = fromNode.end;
    maxDuration = fromNode.duration;
  }
  const duration = clamp(event.duration_sec, TRANSITION_DURATION_MIN, Math.max(TRANSITION_DURATION_MIN, maxDuration));
  const startSec = mode === "boundary" ? cutSec - duration / 2 : mode === "enter" ? cutSec : cutSec - duration;
  const endSec = mode === "boundary" ? cutSec + duration / 2 : mode === "enter" ? cutSec + duration : cutSec;
  return { ...event, duration_sec: duration, mode, cut_sec: cutSec, start_sec: startSec, end_sec: endSec, fromNode, toNode };
}

export function resolvedTransitionEvents(body) {
  return (body?.transitions || []).map((event) => resolveTransitionEvent(body, event)).filter(Boolean);
}

export function transitionEventsForNode(body, ref) {
  const key = transitionRefKey(ref);
  return resolvedTransitionEvents(body).filter(
    (event) => transitionRefKey(event.from) === key || transitionRefKey(event.to) === key,
  );
}

export function transitionEventForNodeEdge(body, ref, edge) {
  const key = transitionRefKey(ref);
  return resolvedTransitionEvents(body).find((event) => (
    edge === "in" ? transitionRefKey(event.to) === key : transitionRefKey(event.from) === key
  )) || null;
}

export function activeTransitionEvents(body, timelineSec) {
  const time = Number(timelineSec) || 0;
  return resolvedTransitionEvents(body).filter(
    (event) => time >= event.start_sec - 0.000001 && time <= event.end_sec + 0.000001,
  ).map((event) => ({
    ...event,
    progress: clamp((time - event.start_sec) / Math.max(0.000001, event.end_sec - event.start_sec), 0, 1),
  }));
}

export function transitionStateForNode(body, ref, timelineSec) {
  const key = transitionRefKey(ref);
  for (const event of activeTransitionEvents(body, timelineSec)) {
    if (transitionRefKey(event.from) === key) return { event, role: "from", progress: event.progress };
    if (transitionRefKey(event.to) === key) return { event, role: "to", progress: event.progress };
  }
  return null;
}

export function transitionMarkersForNode(body, ref) {
  const key = transitionRefKey(ref);
  return resolvedTransitionEvents(body).flatMap((event) => {
    const paired = event.mode === "boundary";
    if (transitionRefKey(event.to) === key) return [{
      eventId: event.id,
      edge: "in",
      type: event.type,
      duration: paired ? event.duration_sec / 2 : event.duration_sec,
      totalDuration: event.duration_sec,
      paired,
    }];
    if (transitionRefKey(event.from) === key) return [{
      eventId: event.id,
      edge: "out",
      type: event.type,
      duration: paired ? event.duration_sec / 2 : event.duration_sec,
      totalDuration: event.duration_sec,
      paired,
    }];
    return [];
  });
}

function candidateForEdge(body, targetNode, edge) {
  const candidates = visualTransitionNodes(body).filter((entry) => {
    if (transitionRefsEqual(entry.ref, targetNode.ref)) return false;
    return edge === "in"
      ? Math.abs(entry.end - targetNode.start) <= TRANSITION_BOUNDARY_EPSILON
      : Math.abs(entry.start - targetNode.end) <= TRANSITION_BOUNDARY_EPSILON;
  });
  candidates.sort((left, right) => {
    const leftSame = left.rowId === targetNode.rowId ? 0 : 1;
    const rightSame = right.rowId === targetNode.rowId ? 0 : 1;
    if (leftSame !== rightSame) return leftSame - rightSame;
    return Math.abs(left.layer - targetNode.layer) - Math.abs(right.layer - targetNode.layer);
  });
  return candidates[0] || null;
}

export function setNodeEdgeTransition(body, ref, edge, type, durationSec = 0.4) {
  if (!body || !["in", "out"].includes(edge)) return null;
  if (!Array.isArray(body.transitions)) body.transitions = [];
  const target = findVisualTransitionNode(body, ref);
  if (!target) return null;
  const existing = transitionEventForNodeEdge(body, ref, edge);
  const spec = normalizeTransitionSpec(type, durationSec);
  if (spec.type === "cut") {
    if (existing) body.transitions = body.transitions.filter((item) => String(item?.id) !== String(existing.id));
    return null;
  }
  if (existing) {
    const stored = body.transitions.find((item) => String(item?.id) === String(existing.id));
    if (stored) Object.assign(stored, spec);
    return stored || existing;
  }
  const candidate = candidateForEdge(body, target, edge);
  const from = edge === "in" ? candidate?.ref || null : target.ref;
  const to = edge === "in" ? target.ref : candidate?.ref || null;
  const next = {
    id: `${eventId(from, to, globalThis.crypto?.randomUUID?.()?.slice?.(0, 8) || Date.now())}`,
    ...spec,
    from,
    to,
  };
  body.transitions.push(next);
  return next;
}

export function updateTransitionEvent(body, eventIdValue, patch = {}) {
  if (!Array.isArray(body?.transitions)) return null;
  const event = body.transitions.find((item) => String(item?.id) === String(eventIdValue));
  if (!event) return null;
  const spec = normalizeTransitionSpec(patch.type ?? event.type, patch.duration_sec ?? event.duration_sec);
  if (spec.type === "cut") {
    body.transitions = body.transitions.filter((item) => String(item?.id) !== String(eventIdValue));
    return null;
  }
  Object.assign(event, spec);
  return event;
}

export function rewireTransitionExitEndpointsAfterSplit(body, rightIds) {
  if (!Array.isArray(body?.transitions) || !rightIds) return body;
  const lookup = rightIds instanceof Map ? rightIds : new Map(Object.entries(rightIds));
  for (const event of body.transitions) {
    const originalId = String(event?.from?.id || "");
    const rightId = lookup.get(originalId);
    if (rightId) event.from = { ...event.from, id: String(rightId) };
  }
  return body;
}

export function reconcileTransitionEvents(body) {
  if (!body || typeof body !== "object") return body;
  if (!Array.isArray(body.transitions)) body.transitions = [];
  const normalized = [];
  const usedFrom = new Set();
  const usedTo = new Set();
  for (const [index, raw] of (body.transitions || []).entries()) {
    const event = normalizeTransitionEvent(raw, index);
    const resolved = event ? resolveTransitionEvent(body, event) : null;
    if (!resolved) continue;
    const fromKey = transitionRefKey(event.from);
    const toKey = transitionRefKey(event.to);
    // One visual edge has exactly one owner. Keeping the first valid event
    // makes malformed/imported projects deterministic across preview/export.
    if ((fromKey && usedFrom.has(fromKey)) || (toKey && usedTo.has(toKey))) continue;
    if (fromKey) usedFrom.add(fromKey);
    if (toKey) usedTo.add(toKey);
    normalized.push({ ...event, duration_sec: resolved.duration_sec });
  }
  body.transitions = normalized;
  body.transition_model_version = TRANSITION_MODEL_VERSION;
  return body;
}
