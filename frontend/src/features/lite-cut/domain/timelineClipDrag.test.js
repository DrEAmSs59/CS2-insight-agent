/** @vitest-environment node */
import { describe, expect, it } from "vitest";
import { moveTimelineClipDrag } from "./timelineClipDrag.js";

function clip(id, start = 4, duration = 4, meta = {}) {
  return { id, timeline_start: start, trim_in: 0, trim_out: duration, meta };
}

function linkedBody() {
  return {
    tracks: [
      { id: "v1", type: "video", label: "V1", clips: [clip("video", 4, 4, { linked_audio_clip_id: "audio" })] },
      { id: "v2", type: "video", label: "V2", clips: [] },
      { id: "a1", type: "audio", label: "A1", clips: [clip("audio", 4, 4, { source_clip_id: "video", linked_from_video: true })] },
      { id: "a2", type: "audio", label: "A2", clips: [] },
    ],
    overlays: [],
  };
}

describe("atomic V/A timeline clip drag", () => {
  it("moves V1 to V2 and moves its linked audio to A2 with the same time delta", () => {
    const body = linkedBody();
    const original = structuredClone(body);
    const result = moveTimelineClipDrag(body, {
      clipId: "video",
      fromTrackId: "v1",
      toTrackId: "v2",
      newStart: 6,
      selectionIds: ["video", "audio"],
    });

    expect(result).toMatchObject({ changed: true, selectedClipId: "video", selectedTrackId: "v2" });
    expect(result.body.tracks.find((track) => track.id === "v1").clips).toEqual([]);
    expect(result.body.tracks.find((track) => track.id === "v2").clips[0]).toMatchObject({ id: "video", timeline_start: 6 });
    expect(result.body.tracks.find((track) => track.id === "a1").clips).toEqual([]);
    expect(result.body.tracks.find((track) => track.id === "a2").clips[0]).toMatchObject({ id: "audio", timeline_start: 6 });
    expect(body).toEqual(original);
  });

  it("moves A1 to A2 and moves its linked video to V2", () => {
    const result = moveTimelineClipDrag(linkedBody(), {
      clipId: "audio",
      fromTrackId: "a1",
      toTrackId: "a2",
      newStart: 4,
      selectionIds: ["video", "audio"],
    });

    expect(result).toMatchObject({ changed: true, selectedClipId: "audio", selectedTrackId: "a2" });
    expect(result.body.tracks.find((track) => track.id === "a1").clips).toEqual([]);
    expect(result.body.tracks.find((track) => track.id === "a2").clips[0]).toMatchObject({ id: "audio", timeline_start: 4 });
    expect(result.body.tracks.find((track) => track.id === "v1").clips).toEqual([]);
    expect(result.body.tracks.find((track) => track.id === "v2").clips[0]).toMatchObject({ id: "video", timeline_start: 4 });
  });

  it("rejects a collision atomically without moving either linked clip", () => {
    const body = linkedBody();
    body.tracks.find((track) => track.id === "v2").clips.push(clip("occupied", 5, 4));
    const result = moveTimelineClipDrag(body, {
      clipId: "video",
      fromTrackId: "v1",
      toTrackId: "v2",
      newStart: 6,
      selectionIds: ["video", "audio"],
    });

    expect(result).toMatchObject({ changed: false, body, reason: "track_collision" });
    expect(body.tracks.find((track) => track.id === "v1").clips[0].timeline_start).toBe(4);
    expect(body.tracks.find((track) => track.id === "a1").clips[0].timeline_start).toBe(4);
  });

  it("creates a new paired V/A lane and moves both linked clips into it", () => {
    const result = moveTimelineClipDrag(linkedBody(), {
      clipId: "video",
      fromTrackId: "v1",
      toTrackId: "v2",
      newStart: 4,
      selectionIds: ["video", "audio"],
      createBelow: true,
    });

    const videos = result.body.tracks.filter((track) => track.type === "video");
    const audios = result.body.tracks.filter((track) => track.type === "audio");
    expect(result.changed).toBe(true);
    expect(videos).toHaveLength(3);
    expect(audios).toHaveLength(3);
    expect(result.body.tracks.map((track) => track.type)).toEqual(["video", "video", "video", "audio", "audio", "audio"]);
    expect(videos[2].clips.map((item) => item.id)).toEqual(["video"]);
    expect(audios[2].clips.map((item) => item.id)).toEqual(["audio"]);
  });

  it("creates a missing counterpart track when moving a linked pair to an unmatched lane", () => {
    const body = linkedBody();
    body.tracks = body.tracks.filter((track) => track.id !== "a2");
    const result = moveTimelineClipDrag(body, {
      clipId: "video",
      fromTrackId: "v1",
      toTrackId: "v2",
      newStart: 4,
      selectionIds: ["video", "audio"],
    });

    const audios = result.body.tracks.filter((track) => track.type === "audio");
    expect(result.changed).toBe(true);
    expect(audios).toHaveLength(2);
    expect(audios[1]).toMatchObject({ label: "A2" });
    expect(audios[1].clips.map((item) => item.id)).toEqual(["audio"]);
  });

  it("never permits a clip to cross between V and A track types", () => {
    const body = linkedBody();
    expect(moveTimelineClipDrag(body, {
      clipId: "video",
      fromTrackId: "v1",
      toTrackId: "a2",
      newStart: 4,
    })).toMatchObject({ changed: false, body, reason: "track_type_mismatch" });
  });
});
