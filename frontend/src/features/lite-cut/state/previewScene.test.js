import { describe, expect, it } from "vitest";
import {
  resolveAudioPreviewItems,
  resolveAudioPreviewPreloadItems,
  resolveIncomingTransitionPlayback,
  resolveOutgoingTransitionPreload,
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
      clips: [{ id: "top", timeline_start: 1, trim_in: 0, trim_out: 3, source_type: "file", transition_in: { type: "fade", duration_sec: 0.5 } }],
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
};

describe("buildPreviewScene", () => {
  it("keeps all preview timing selectors equivalent at a frame", () => {
    const time = 1.25;
    const scene = buildPreviewScene(body, time, { masterVolume: 0.8 });
    const top = resolveTopVideoPlaybackAt(body, time);

    expect(scene.top).toEqual(top);
    expect(scene.underlays).toEqual(resolveVideoUnderlayPlaybacksAt(body, time, top));
    expect(scene.overlays).toEqual(overlaysActiveAt(body, time));
    expect(scene.incomingTransition).toEqual(resolveIncomingTransitionPlayback(body, top));
    expect(scene.outgoingTransitionPreload).toEqual(resolveOutgoingTransitionPreload(body, top, 2));
    expect(scene.audio).toEqual(resolveAudioPreviewItems(body, time, 0.8));
    expect(scene.audioPreload).toEqual(resolveAudioPreviewPreloadItems(body, time, 0.8, 1.5));
  });

  it("describes first/last clip background fades without producing UI styles", () => {
    expect(buildPreviewScene(body, 1.25).backgroundTransition).toEqual({
      type: "fade",
      phase: "in",
      duration: 0.5,
      startLocalTime: 0,
      progress: 0.5,
    });
  });
});
