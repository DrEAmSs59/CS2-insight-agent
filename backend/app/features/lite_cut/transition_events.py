"""Canonical LiteCut transition events and timeline projection.

Transitions are first-class edit-point objects. They never belong to an
individual material. A boundary event binds two visual nodes; an enter/exit
event binds one node and an implicit transparent canvas endpoint.
"""

from __future__ import annotations

from copy import deepcopy
from dataclasses import dataclass
from typing import Any

from .effect_contract import load_effect_contract
from .timeline_math import clip_timeline_duration_sec


_CONTRACT = load_effect_contract().get("transition_model", {})
_LIMITS = _CONTRACT.get("limits", {})
TRANSITION_MODEL_VERSION = int(_CONTRACT.get("version") or 1)
TRANSITION_DURATION_MIN = float(_LIMITS.get("duration_min") or 0.05)
TRANSITION_DURATION_MAX = float(_LIMITS.get("duration_max") or 10.0)
TRANSITION_DURATION_DEFAULT = float(_LIMITS.get("duration_default") or 0.4)
TRANSITION_BOUNDARY_EPSILON = float(_LIMITS.get("boundary_epsilon") or 0.05)
TRANSITION_TYPES = tuple(str(item.get("id")) for item in _CONTRACT.get("types", []) if isinstance(item, dict))
TRANSITION_TYPE_SET = set(TRANSITION_TYPES)


def _clamp(value: Any, minimum: float, maximum: float) -> float:
    try:
        number = float(value)
    except (TypeError, ValueError):
        number = 0.0
    return max(minimum, min(maximum, number))


def normalize_transition_type(value: Any) -> str:
    raw = str(value or "fade").lower()
    return raw if raw in TRANSITION_TYPE_SET else "fade"


def normalize_transition_spec(transition_type: Any, duration_sec: Any = TRANSITION_DURATION_DEFAULT) -> dict[str, Any]:
    kind = normalize_transition_type(transition_type)
    if kind == "cut":
        return {"type": "cut", "duration_sec": 0.0, "easing": "linear"}
    return {
        "type": kind,
        "duration_sec": _clamp(duration_sec, TRANSITION_DURATION_MIN, TRANSITION_DURATION_MAX),
        "easing": "linear",
    }


def normalize_transition_ref(value: Any) -> dict[str, str] | None:
    if not isinstance(value, dict):
        return None
    kind = str(value.get("kind") or "")
    node_id = str(value.get("id") or "")
    if kind not in {"clip", "overlay"} or not node_id:
        return None
    return {
        "kind": kind,
        "track_id": str(value.get("track_id") or ("ot1" if kind == "overlay" else "")),
        "id": node_id,
    }


def transition_ref_key(value: Any) -> str:
    ref = normalize_transition_ref(value)
    return f"{ref['kind']}:{ref['track_id']}:{ref['id']}" if ref else ""


def _event_id(from_ref: Any, to_ref: Any, suffix: str) -> str:
    raw = f"tr-{suffix}-{transition_ref_key(from_ref) or 'canvas'}-{transition_ref_key(to_ref) or 'canvas'}"
    return "".join(char if char.isalnum() or char in "-_" else "-" for char in raw)[:150]


def normalize_transition_event(raw: Any, index: int = 0) -> dict[str, Any] | None:
    if not isinstance(raw, dict):
        return None
    from_ref = normalize_transition_ref(raw.get("from"))
    to_ref = normalize_transition_ref(raw.get("to"))
    if not from_ref and not to_ref:
        return None
    spec = normalize_transition_spec(raw.get("type"), raw.get("duration_sec"))
    if spec["type"] == "cut":
        return None
    return {
        "id": str(raw.get("id") or _event_id(from_ref, to_ref, str(index))),
        **spec,
        "from": from_ref,
        "to": to_ref,
    }


def _clip_duration(clip: dict[str, Any]) -> float:
    return clip_timeline_duration_sec(clip)


@dataclass(frozen=True)
class VisualTransitionNode:
    ref: dict[str, str]
    node: dict[str, Any]
    row_id: str
    start: float
    end: float
    duration: float
    layer: int


def visual_transition_nodes(body: dict[str, Any]) -> list[VisualTransitionNode]:
    nodes: list[VisualTransitionNode] = []
    layer = 0
    # Track storage follows the UI's top-to-bottom order. Rendering happens
    # bottom-to-top, so layer numbers must be assigned in reverse track order.
    for track in reversed(body.get("tracks") or []):
        if not isinstance(track, dict) or track.get("type") != "video":
            continue
        track_id = str(track.get("id") or "")
        for clip in track.get("clips") or []:
            if not isinstance(clip, dict):
                continue
            start = max(0.0, float(clip.get("timeline_start") or 0.0))
            duration = _clip_duration(clip)
            nodes.append(VisualTransitionNode(
                ref={"kind": "clip", "track_id": track_id, "id": str(clip.get("id") or "")},
                node=clip,
                row_id=track_id,
                start=start,
                end=start + duration,
                duration=duration,
                layer=layer,
            ))
        layer += 1
    for overlay in body.get("overlays") or []:
        if not isinstance(overlay, dict):
            continue
        meta = overlay.get("meta") if isinstance(overlay.get("meta"), dict) else {}
        row_id = str(meta.get("overlay_track_id") or "ot1")
        start = max(0.0, float(overlay.get("timeline_start") or 0.0))
        duration = max(0.0, float(overlay.get("duration") or 0.0))
        nodes.append(VisualTransitionNode(
            ref={"kind": "overlay", "track_id": row_id, "id": str(overlay.get("id") or "")},
            node=overlay,
            row_id=row_id,
            start=start,
            end=start + duration,
            duration=duration,
            layer=layer,
        ))
        layer += 1
    return nodes


def find_visual_transition_node(body: dict[str, Any], ref: Any) -> VisualTransitionNode | None:
    key = transition_ref_key(ref)
    return next((node for node in visual_transition_nodes(body) if transition_ref_key(node.ref) == key), None)


def resolve_transition_event(body: dict[str, Any], raw_event: Any) -> dict[str, Any] | None:
    event = normalize_transition_event(raw_event)
    if not event:
        return None
    from_node = find_visual_transition_node(body, event.get("from")) if event.get("from") else None
    to_node = find_visual_transition_node(body, event.get("to")) if event.get("to") else None
    if (event.get("from") and not from_node) or (event.get("to") and not to_node):
        return None

    if from_node and to_node:
        if abs(from_node.end - to_node.start) > TRANSITION_BOUNDARY_EPSILON:
            return None
        mode = "boundary"
        cut_sec = (from_node.end + to_node.start) / 2.0
        max_duration = max(TRANSITION_DURATION_MIN, min(TRANSITION_DURATION_MAX, from_node.duration * 2.0, to_node.duration * 2.0))
    elif from_node:
        mode = "exit"
        cut_sec = from_node.end
        max_duration = from_node.duration
    else:
        mode = "enter"
        cut_sec = to_node.start if to_node else 0.0
        max_duration = to_node.duration if to_node else TRANSITION_DURATION_MAX
    duration = _clamp(event["duration_sec"], TRANSITION_DURATION_MIN, max(TRANSITION_DURATION_MIN, max_duration))
    start_sec = cut_sec - duration / 2.0 if mode == "boundary" else cut_sec if mode == "enter" else cut_sec - duration
    end_sec = cut_sec + duration / 2.0 if mode == "boundary" else cut_sec + duration if mode == "enter" else cut_sec
    return {
        **event,
        "duration_sec": duration,
        "mode": mode,
        "cut_sec": cut_sec,
        "start_sec": start_sec,
        "end_sec": end_sec,
        "from_node": from_node,
        "to_node": to_node,
    }


def resolved_transition_events(body: dict[str, Any]) -> list[dict[str, Any]]:
    return [event for raw in body.get("transitions") or [] if (event := resolve_transition_event(body, raw))]


def transition_events_for_node(body: dict[str, Any], ref: Any) -> list[dict[str, Any]]:
    key = transition_ref_key(ref)
    return [
        event for event in resolved_transition_events(body)
        if transition_ref_key(event.get("from")) == key or transition_ref_key(event.get("to")) == key
    ]


def _candidate_for_edge(body: dict[str, Any], target: VisualTransitionNode, edge: str) -> VisualTransitionNode | None:
    candidates = [
        node for node in visual_transition_nodes(body)
        if transition_ref_key(node.ref) != transition_ref_key(target.ref)
        and abs((node.end if edge == "in" else node.start) - (target.start if edge == "in" else target.end)) <= TRANSITION_BOUNDARY_EPSILON
    ]
    candidates.sort(key=lambda node: (0 if node.row_id == target.row_id else 1, abs(node.layer - target.layer)))
    return candidates[0] if candidates else None


def normalized_transition_project(raw_body: dict[str, Any]) -> dict[str, Any]:
    body = deepcopy(raw_body)
    normalized_events: list[dict[str, Any]] = []
    used_from: set[str] = set()
    used_to: set[str] = set()
    for index, raw in enumerate(body.get("transitions") or []):
        normalized = normalize_transition_event(raw, index)
        resolved = resolve_transition_event(body, normalized) if normalized else None
        if resolved:
            from_key = transition_ref_key(normalized.get("from"))
            to_key = transition_ref_key(normalized.get("to"))
            # An edge is owned by exactly one event. Preserve the first valid
            # event so repaired/imported projects resolve identically everywhere.
            if (from_key and from_key in used_from) or (to_key and to_key in used_to):
                continue
            if from_key:
                used_from.add(from_key)
            if to_key:
                used_to.add(to_key)
            normalized_events.append({**normalized, "duration_sec": resolved["duration_sec"]})
    body["transitions"] = normalized_events
    body["transition_model_version"] = TRANSITION_MODEL_VERSION
    return body


def project_events_to_render_nodes(raw_body: dict[str, Any]) -> dict[str, Any]:
    """Attach resolved envelopes to render copies without restoring legacy ownership."""
    body = normalized_transition_project(raw_body)
    events = resolved_transition_events(body)
    by_key: dict[str, list[dict[str, Any]]] = {}
    for event in events:
        for role, ref in (("from", event.get("from")), ("to", event.get("to"))):
            key = transition_ref_key(ref)
            if not key:
                continue
            current_node = event.get(f"{role}_node")
            other_node = event.get("to_node" if role == "from" else "from_node")
            stack = None
            if event.get("mode") == "boundary" and current_node and other_node:
                stack = "upper" if (
                    current_node.layer > other_node.layer
                    or (current_node.layer == other_node.layer and role == "to")
                ) else "lower"
            by_key.setdefault(key, []).append({
                "id": event["id"],
                "type": event["type"],
                "role": role,
                "mode": event["mode"],
                "duration_sec": event["duration_sec"],
                "start_sec": event["start_sec"],
                "end_sec": event["end_sec"],
                "cut_sec": event["cut_sec"],
                "stack": stack,
            })
    for track in body.get("tracks") or []:
        if not isinstance(track, dict) or track.get("type") != "video":
            continue
        track_id = str(track.get("id") or "")
        for clip in track.get("clips") or []:
            if isinstance(clip, dict):
                clip["_transition_events"] = by_key.get(transition_ref_key({"kind": "clip", "track_id": track_id, "id": clip.get("id")}), [])
    for overlay in body.get("overlays") or []:
        if not isinstance(overlay, dict):
            continue
        meta = overlay.get("meta") if isinstance(overlay.get("meta"), dict) else {}
        overlay["_transition_events"] = by_key.get(transition_ref_key({
            "kind": "overlay",
            "track_id": meta.get("overlay_track_id") or "ot1",
            "id": overlay.get("id"),
        }), [])
    return body
