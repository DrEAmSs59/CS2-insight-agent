/** @vitest-environment node */
import { describe, expect, it } from "vitest";
import {
  computeClipMoveTarget,
  computeMediaDropTarget,
  getTrackAtY,
  orderedTimelineRows,
} from "./dropTargetUtils.js";

const body = {
  tracks: [
    { id: "v1", type: "video", clips: [{ id: "c1", timeline_start: 0, trim_in: 0, trim_out: 10 }] },
    { id: "v2", type: "video", clips: [] },
    { id: "overlay", type: "overlay", clips: [] },
    { id: "a1", type: "audio", clips: [] },
  ],
  overlays: [],
};

describe("dropTargetUtils", () => {
  it("orders overlay row first, then visible video, audio", () => {
    const rows = orderedTimelineRows(body);
    expect(rows.map((r) => r.id)).toEqual(["ov", "v1", "v2", "a1"]);
  });

  it("resolves track from Y", () => {
    const rows = orderedTimelineRows(body);
    const hit = getTrackAtY(10, rows);
    expect(hit?.row.id).toBe("ov");
  });

  it("places media on new video track when v1 occupied", () => {
    const target = computeMediaDropTarget({
      body,
      mouseY: 55,
      startTime: 2,
      mediaItem: { id: 1, duration: 5 },
    });
    expect(target?.isNewTrack).toBe(true);
  });

  it("creates new track when overlapping", () => {
    const target = computeMediaDropTarget({
      body,
      mouseY: 55,
      startTime: 5,
      mediaItem: { id: 2, duration: 5 },
    });
    expect(target?.isNewTrack).toBe(true);
  });

  it("routes overlay assets to ov row", () => {
    const target = computeMediaDropTarget({
      body,
      mouseY: 5,
      startTime: 1,
      mediaItem: { mediaKind: "asset", kind: "image", duration_sec: 3 },
    });
    expect(target?.trackId).toBe("ov");
  });

  it("keeps transparent MOV video assets on video tracks", () => {
    const target = computeMediaDropTarget({
      body,
      mouseY: 55,
      startTime: 12,
      mediaItem: { mediaKind: "asset", kind: "video", has_alpha: true, duration_sec: 3 },
    });
    expect(target?.trackId).toBe("v1");
  });

  it("routes audio assets to audio rows", () => {
    const target = computeMediaDropTarget({
      body,
      mouseY: 124,
      startTime: 1,
      mediaItem: { mediaKind: "asset", kind: "audio", duration_sec: 3 },
    });
    expect(target?.trackId).toBe("a1");
    expect(target?.isNewTrack).toBe(false);
  });

  it("creates a new audio track when audio overlaps", () => {
    const audioBody = {
      ...body,
      tracks: body.tracks.map((t) =>
        t.id === "a1"
          ? { ...t, clips: [{ id: "a", timeline_start: 0, trim_in: 0, trim_out: 10 }] }
          : t,
      ),
    };
    const target = computeMediaDropTarget({
      body: audioBody,
      mouseY: 124,
      startTime: 2,
      mediaItem: { mediaKind: "asset", kind: "audio", duration_sec: 4 },
    });
    expect(target?.trackId).toBe("a1");
    expect(target?.isNewTrack).toBe(true);
  });

  it("creates a new track instead of dropping media onto a locked video row", () => {
    const lockedBody = {
      ...body,
      tracks: body.tracks.map((t) => (t.id === "v1" ? { ...t, locked: true } : t)),
    };
    const target = computeMediaDropTarget({
      body: lockedBody,
      mouseY: 55,
      startTime: 12,
      mediaItem: { id: 3, duration: 4 },
    });
    expect(target?.trackId).toBe("v1");
    expect(target?.isNewTrack).toBe(true);
  });

  it("keeps clip on same track while dragging horizontally", () => {
    const target = computeClipMoveTarget({
      body,
      mouseY: 55,
      startTime: 12,
      fromTrackId: "v1",
      clipId: "c1",
      clipDuration: 10,
    });
    expect(target?.trackId).toBe("v1");
    expect(target?.isNewTrack).toBe(false);
  });

  it("targets V1 when a V2 clip is dragged into available space on V1", () => {
    const moveBody = {
      ...body,
      tracks: body.tracks.map((track) =>
        track.id === "v2"
          ? { ...track, clips: [{ id: "c2", timeline_start: 12, trim_in: 0, trim_out: 4 }] }
          : track,
      ),
    };
    const target = computeClipMoveTarget({
      body: moveBody,
      mouseY: 45,
      startTime: 12,
      fromTrackId: "v2",
      clipId: "c2",
      clipDuration: 4,
    });

    expect(target).toMatchObject({ trackId: "v1", isNewTrack: false });
  });

  it("does not move clips onto the middle of a locked target track", () => {
    const lockedTargetBody = {
      ...body,
      tracks: [
        body.tracks[0],
        {
          id: "v2",
          type: "video",
          locked: true,
          clips: [{ id: "c2", timeline_start: 20, trim_in: 0, trim_out: 5 }],
        },
        body.tracks[2],
        body.tracks[3],
      ],
    };
    const target = computeClipMoveTarget({
      body: lockedTargetBody,
      mouseY: 90,
      startTime: 12,
      fromTrackId: "v1",
      clipId: "c1",
      clipDuration: 10,
    });
    expect(target).toBeNull();
  });
});
