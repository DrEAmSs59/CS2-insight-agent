import { describe, expect, it } from "vitest";
import {
  resolveAudioPreviewItems,
  resolveAudioPreviewPreloadItems,
  resolveTopVideoPlaybackAt,
  resolveVideoUnderlayPlaybacksAt,
} from "./playbackUtils.js";
import { overlaysActiveAt } from "./timelineUtils.js";
import { buildPreviewScene } from "./previewScene.js";

const body = {
  audio: { master_volume: 1 },
  tracks: [
    {
      id: "v2",
      type: "video",
      clips: [{ id: "top", timeline_start: 1, trim_in: 0, trim_out: 3, source_type: "file" }],
    },
    {
      id: "v1",
      type: "video",
      clips: [{ id: "base", timeline_start: 0, trim_in: 0, trim_out: 5, source_type: "file" }],
    },
    {
      id: "a1",
      type: "audio",
      clips: [{ id: "sound", timeline_start: 1, trim_in: 0, trim_out: 2, source_type: "file" }],
    },
  ],
  overlays: [{ id: "title", type: "text", timeline_start: 1, duration: 2 }],
  transitions: [{
    id: "top-enter",
    type: "fade",
    duration_sec: 0.5,
    from: null,
    to: { kind: "clip", track_id: "v2", id: "top" },
  }],
};

describe("buildPreviewScene", () => {
  it("keeps all preview timing selectors equivalent at a frame", () => {
    const time = 1.25;
    const scene = buildPreviewScene(body, time, { masterVolume: 0.8 });
    const top = resolveTopVideoPlaybackAt(body, time);

    expect(scene.top).toEqual(top);
    expect(scene.underlays).toEqual(resolveVideoUnderlayPlaybacksAt(body, time, top));
    expect(scene.overlays).toEqual(overlaysActiveAt(body, time));
    expect(scene.transitionCompanion).toBeNull();
    expect(scene.transitionEvent).toMatchObject({ id: "top-enter", mode: "enter", progress: 0.5 });
    expect(scene.nodeTransition).toEqual({ type: "fade", role: "to", progress: 0.5, eventId: "top-enter", mode: "enter", stack: null });
    expect(scene.audio).toEqual(resolveAudioPreviewItems(body, time, 0.8));
    expect(scene.audioPreload).toEqual(resolveAudioPreviewPreloadItems(body, time, 0.8, 1.5));
  });

  it("models a single-node transition against the transparent canvas", () => {
    const scene = buildPreviewScene(body, 1.25);
    expect(scene.transitionKernel).toBe("node");
    expect(scene.nodeTransition).toMatchObject({ type: "fade", role: "to", progress: 0.5 });
  });

  it("keeps the upper outgoing track above a lower incoming track", () => {
    const crossBody = {
      tracks: [
        { id: "v2", type: "video", clips: [{ id: "upper", timeline_start: 0, trim_in: 0, trim_out: 2, source_type: "file" }] },
        { id: "v1", type: "video", clips: [{ id: "lower", timeline_start: 2, trim_in: 0, trim_out: 2, source_type: "file" }] },
      ],
      overlays: [],
      transitions: [{ id: "cross", type: "fade", duration_sec: 1, from: { kind: "clip", track_id: "v2", id: "upper" }, to: { kind: "clip", track_id: "v1", id: "lower" } }],
    };
    const scene = buildPreviewScene(crossBody, 2.25);
    expect(scene.top).toMatchObject({ trackId: "v2", clip: { id: "upper" }, freezePlayback: true });
    expect(scene.transitionCompanion).toMatchObject({ trackId: "v1", clip: { id: "lower" }, freezePlayback: false, transitionRole: "to" });
    expect(scene.nodeTransition).toMatchObject({ role: "from", mode: "boundary", stack: "upper", progress: 0.75 });
    expect(scene.transitionKernel).toBe("stack");
  });

  it("keeps same-track decoder ownership stable for the complete boundary event", () => {
    const sameTrackBody = {
      tracks: [{
        id: "v1",
        type: "video",
        clips: [
          { id: "a", timeline_start: 0, trim_in: 0, trim_out: 4, source_type: "file" },
          { id: "b", timeline_start: 4, trim_in: 0, trim_out: 4, source_type: "file" },
        ],
      }],
      overlays: [],
      transitions: [{
        id: "ab",
        type: "fade",
        duration_sec: 2,
        from: { kind: "clip", track_id: "v1", id: "a" },
        to: { kind: "clip", track_id: "v1", id: "b" },
      }],
    };

    const before = buildPreviewScene(sameTrackBody, 2.99);
    const entering = buildPreviewScene(sameTrackBody, 3);
    const afterCut = buildPreviewScene(sameTrackBody, 4.25);
    const complete = buildPreviewScene(sameTrackBody, 5.01);

    expect(before.top?.clip?.id).toBe("a");
    expect(before.transitionCompanion).toBeNull();
    expect(entering.top).toMatchObject({ clip: { id: "a" } });
    expect(entering.top.freezePlayback).not.toBe(true);
    expect(entering.transitionCompanion).toMatchObject({ clip: { id: "b" }, transitionRole: "to", freezePlayback: true });
    expect(entering.nodeTransition).toMatchObject({ role: "from", progress: 0 });
    expect(afterCut.top).toMatchObject({ clip: { id: "a" }, freezePlayback: true });
    expect(afterCut.transitionCompanion).toMatchObject({ clip: { id: "b" }, transitionRole: "to", freezePlayback: false });
    expect(complete.top?.clip?.id).toBe("b");
    expect(complete.transitionCompanion).toBeNull();
  });
});
