import { describe, expect, it } from "vitest";
import {
  activeTransitionEvents,
  clipTransitionRef,
  normalizeTransitionSpec,
  reconcileTransitionEvents,
  resolveTransitionEvent,
  setNodeEdgeTransition,
  transitionMarkersForNode,
} from "./transitionModel.js";

function project() {
  return {
    tracks: [
      { id: "v2", type: "video", clips: [{ id: "b", timeline_start: 4, trim_in: 0, trim_out: 6 }] },
      { id: "v1", type: "video", clips: [{ id: "a", timeline_start: 0, trim_in: 0, trim_out: 4 }] },
    ],
    overlays: [
      { id: "title-a", type: "text", timeline_start: 1, duration: 2, meta: { overlay_track_id: "ot1" }, text: { content: "A" } },
      { id: "title-b", type: "text", timeline_start: 3, duration: 2, meta: { overlay_track_id: "ot1" }, text: { content: "B" } },
    ],
    transitions: [],
  };
}

describe("unified transition event model", () => {
  it("creates one centered cross-track event and annotates half on each material", () => {
    const body = project();
    const event = setNodeEdgeTransition(body, clipTransitionRef("v1", "a"), "out", "fade", 2);
    expect(event).toMatchObject({ from: { id: "a" }, to: { id: "b" }, duration_sec: 2 });
    const resolved = resolveTransitionEvent(body, event);
    expect(resolved).toMatchObject({ mode: "boundary", cut_sec: 4, start_sec: 3, end_sec: 5 });
    expect(transitionMarkersForNode(body, clipTransitionRef("v1", "a"))[0]).toMatchObject({ edge: "out", duration: 1, totalDuration: 2, paired: true });
    expect(transitionMarkersForNode(body, clipTransitionRef("v2", "b"))[0]).toMatchObject({ edge: "in", duration: 1, totalDuration: 2, paired: true });
  });

  it("keeps an unpaired material transition wholly inside the material", () => {
    const body = project();
    const event = setNodeEdgeTransition(body, clipTransitionRef("v1", "a"), "in", "zoom", 1.25);
    expect(resolveTransitionEvent(body, event)).toMatchObject({ mode: "enter", start_sec: 0, end_sec: 1.25 });
    expect(transitionMarkersForNode(body, clipTransitionRef("v1", "a"))[0]).toMatchObject({ duration: 1.25, paired: false });
  });

  it("uses one event for adjacent text materials", () => {
    const body = project();
    const first = { kind: "overlay", track_id: "ot1", id: "title-a" };
    const event = setNodeEdgeTransition(body, first, "out", "wipe_l", 0.8);
    expect(event).toMatchObject({ from: { id: "title-a" }, to: { id: "title-b" } });
    expect(activeTransitionEvents(body, 3)[0]).toMatchObject({ mode: "boundary", progress: 0.5 });
  });

  it("uses zero duration only for the canonical cut effect", () => {
    expect(normalizeTransitionSpec("cut", 0.8)).toEqual({ type: "cut", duration_sec: 0, easing: "linear" });
    expect(normalizeTransitionSpec("flash", 0)).toMatchObject({ type: "flash", duration_sec: 0.05 });
    expect(normalizeTransitionSpec("flashwhite", 0.6)).toMatchObject({ type: "fade", duration_sec: 0.6 });
  });

  it("drops a paired event when its endpoints are no longer attached", () => {
    const body = project();
    setNodeEdgeTransition(body, clipTransitionRef("v1", "a"), "out", "fade", 1);
    body.tracks[0].clips[0].timeline_start = 5;
    reconcileTransitionEvents(body);
    expect(body.transitions).toEqual([]);
  });

  it("persists the same effective duration used by markers, preview, and export", () => {
    const body = project();
    body.transitions = [{ id: "a-enter", type: "fade", duration_sec: 10, from: null, to: clipTransitionRef("v1", "a") }];
    reconcileTransitionEvents(body);
    expect(body.transitions[0].duration_sec).toBe(4);
    expect(resolveTransitionEvent(body, body.transitions[0]).duration_sec).toBe(4);
  });

  it("keeps exactly one canonical owner for each material edge", () => {
    const body = project();
    body.transitions = [
      { id: "first", type: "fade", duration_sec: 1, from: clipTransitionRef("v1", "a"), to: clipTransitionRef("v2", "b") },
      { id: "duplicate-out", type: "flash", duration_sec: 1, from: clipTransitionRef("v1", "a"), to: null },
      { id: "duplicate-in", type: "zoom", duration_sec: 1, from: null, to: clipTransitionRef("v2", "b") },
    ];
    reconcileTransitionEvents(body);
    expect(body.transitions.map((event) => event.id)).toEqual(["first"]);
  });
});
