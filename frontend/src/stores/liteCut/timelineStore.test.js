/** @vitest-environment jsdom */
import { beforeEach, describe, expect, it } from "vitest";
import { useLiteCutEditorStore } from "../liteCutEditorStore.js";
import { useLiteCutHistoryStore } from "./historyStore.js";
import { useLiteCutTimelineStore } from "./timelineStore.js";

function clip(id, extra = {}) {
  return { id, timeline_start: 0, trim_in: 0, trim_out: 4, ...extra };
}

function setProject(body, selectedClipId = "a", selectedTrackId = "v1") {
  useLiteCutEditorStore.setState({ body: structuredClone(body), dirty: false });
  useLiteCutHistoryStore.setState({ past: [], future: [] });
  useLiteCutTimelineStore.setState({
    selectedClipId,
    selectedClipIds: selectedClipId ? [selectedClipId] : [],
    selectedTrackId,
    playheadSec: 0,
    lastUserSeekAt: 0,
    isPlaying: false,
    clipboard: null,
    propertyEditActive: false,
  });
}

describe("liteCut timeline store scoped style sync", () => {
  beforeEach(() => {
    setProject({ tracks: [{ id: "v1", type: "video", clips: [] }], overlays: [] }, null, "v1");
  });

  it("pauses playback after a manual playhead seek and does not resume automatically", () => {
    useLiteCutTimelineStore.setState({ isPlaying: true, playheadSec: 2, lastUserSeekAt: 0 });

    useLiteCutTimelineStore.getState().seekPlayhead(8.5);

    expect(useLiteCutTimelineStore.getState()).toMatchObject({
      playheadSec: 8.5,
      isPlaying: false,
    });
    expect(useLiteCutTimelineStore.getState().lastUserSeekAt).toBeGreaterThan(0);
  });

  it("applies the selected transition to every editable video track only", () => {
    setProject({
      tracks: [
        {
          id: "v1",
          type: "video",
          locked: false,
          hidden: false,
          clips: [clip("a", { transition_out: { type: "flash", duration_sec: 0.5 } }), clip("b")],
        },
        { id: "v2", type: "video", locked: false, hidden: false, clips: [clip("c")] },
        { id: "v3", type: "video", locked: true, hidden: false, clips: [clip("locked")] },
        { id: "v4", type: "video", locked: false, hidden: true, clips: [clip("hidden")] },
        { id: "a1", type: "audio", locked: false, hidden: false, clips: [clip("audio")] },
      ],
      overlays: [],
    });

    const store = useLiteCutTimelineStore.getState();
    expect(store.canApplySelectedTransitionToScope("all", "flash", 0.5)).toBe(true);
    expect(store.applySelectedTransitionToScope("all", "flash", 0.5)).toBe(true);

    const tracks = useLiteCutEditorStore.getState().body.tracks;
    const byId = Object.fromEntries(tracks.flatMap((track) => (track.clips || []).map((c) => [c.id, c])));
    expect(byId.a.transition_out).toEqual({ type: "flash", duration_sec: 0.5 });
    expect(byId.b.transition_out).toEqual({ type: "flash", duration_sec: 0.5 });
    expect(byId.c.transition_out).toEqual({ type: "flash", duration_sec: 0.5 });
    expect(byId.locked.transition_out).toBeUndefined();
    expect(byId.hidden.transition_out).toBeUndefined();
    expect(byId.audio.transition_out).toBeUndefined();
    expect(useLiteCutHistoryStore.getState().past).toHaveLength(1);
  });

  it("applies color only to the selected track when requested", () => {
    const color = { brightness: 12, contrast: -5, saturation: 30, filter_preset: "esports" };
    setProject({
      tracks: [
        {
          id: "v1",
          type: "video",
          locked: false,
          hidden: false,
          clips: [clip("a", { color }), clip("b")],
        },
        { id: "v2", type: "video", locked: false, hidden: false, clips: [clip("c")] },
      ],
      overlays: [],
    });

    const store = useLiteCutTimelineStore.getState();
    expect(store.canApplySelectedColorToScope("track", color)).toBe(true);
    expect(store.applySelectedColorToScope("track", color)).toBe(true);

    const [v1, v2] = useLiteCutEditorStore.getState().body.tracks;
    expect(v1.clips[0].color).toEqual(color);
    expect(v1.clips[1].color).toEqual(color);
    expect(v2.clips[0].color).toBeUndefined();
    expect(store.canApplySelectedColorToScope("track", color)).toBe(false);
    expect(store.canApplySelectedColorToScope("all", color)).toBe(true);
  });

  it("does not push history when scoped sync would be a no-op", () => {
    const transition = { type: "cut", duration_sec: 0 };
    setProject({
      tracks: [
        {
          id: "v1",
          type: "video",
          locked: false,
          hidden: false,
          clips: [clip("a", { transition_out: transition }), clip("b", { transition_out: transition })],
        },
      ],
      overlays: [],
    });

    const store = useLiteCutTimelineStore.getState();
    expect(store.applySelectedTransitionToScope("track", "cut", 0)).toBe(false);
    expect(useLiteCutHistoryStore.getState().past).toHaveLength(0);
  });
});

describe("liteCut timeline store property edit history", () => {
  it("records one undo snapshot for a continuous property edit", () => {
    setProject({ tracks: [{ id: "v1", type: "video", clips: [clip("a", { volume: 1 })] }], overlays: [] });
    const store = useLiteCutTimelineStore.getState();
    expect(store.beginPropertyEdit()).toBe(true);
    expect(store.beginPropertyEdit()).toBe(false);
    store.updateSelectedClip({ volume: 0.4 });
    store.updateSelectedClip({ volume: 0.2 });
    store.endPropertyEdit();

    expect(useLiteCutHistoryStore.getState().past).toHaveLength(1);
    store.undo();
    expect(useLiteCutEditorStore.getState().body.tracks[0].clips[0].volume).toBe(1);
  });
});

describe("liteCut timeline store track audio controls", () => {
  beforeEach(() => {
    setProject(
      {
        tracks: [
          { id: "v1", type: "video", clips: [] },
          { id: "a1", type: "audio", solo: false, clips: [] },
        ],
        overlays: [],
      },
      null,
      "v1",
    );
  });

  it("toggles solo only for audio tracks", () => {
    const store = useLiteCutTimelineStore.getState();
    store.toggleTrackSolo("a1");
    store.toggleTrackSolo("v1");

    const tracks = useLiteCutEditorStore.getState().body.tracks;
    expect(tracks.find((track) => track.id === "a1").solo).toBe(true);
    expect(tracks.find((track) => track.id === "v1").solo).toBeUndefined();
    expect(useLiteCutHistoryStore.getState().past).toHaveLength(1);
  });
});

describe("liteCut timeline store cross-track clip moves", () => {
  it("moves a V2 clip onto V1 and keeps its timeline position", () => {
    setProject({
      tracks: [
        { id: "v1", type: "video", clips: [clip("v1-clip", { timeline_start: 0, trim_out: 8 })] },
        { id: "v2", type: "video", clips: [clip("v2-clip", { timeline_start: 12, trim_out: 4 })] },
      ],
      overlays: [],
    }, "v2-clip", "v2");

    useLiteCutTimelineStore.getState().moveClipToTrack("v2-clip", "v2", "v1", 12, { snap: false });

    const [v1, v2] = useLiteCutEditorStore.getState().body.tracks;
    expect(v1.clips.map((item) => item.id)).toEqual(["v1-clip", "v2-clip"]);
    expect(v1.clips.find((item) => item.id === "v2-clip").timeline_start).toBe(12);
    expect(v2.clips).toEqual([]);
    expect(useLiteCutTimelineStore.getState()).toMatchObject({ selectedClipId: "v2-clip", selectedTrackId: "v1" });
  });
});

describe("liteCut timeline store track names", () => {
  beforeEach(() => {
    setProject(
      {
        tracks: [
          { id: "v1", type: "video", label: "V1", clips: [] },
          { id: "a1", type: "audio", label: "A1", clips: [] },
        ],
        overlays: [],
      },
      null,
      "v1",
    );
  });

  it("stores a normalized custom name without changing the default label", () => {
    const store = useLiteCutTimelineStore.getState();
    expect(store.renameTrack("a1", "  Main   commentary  ")).toBe(true);
    expect(store.renameTrack("a1", "Main commentary")).toBe(false);
    expect(useLiteCutEditorStore.getState().body.tracks.find((track) => track.id === "a1")).toMatchObject({
      label: "A1",
      name: "Main commentary",
    });
    expect(useLiteCutHistoryStore.getState().past).toHaveLength(1);
  });

  it("clears a custom name back to the default label and rejects overlay rows", () => {
    const store = useLiteCutTimelineStore.getState();
    store.renameTrack("v1", "Main camera");
    expect(store.renameTrack("v1", "")).toBe(true);
    expect(store.renameTrack("overlay", "Titles")).toBe(false);
    expect(useLiteCutEditorStore.getState().body.tracks.find((track) => track.id === "v1").name).toBeNull();
  });
});

describe("liteCut timeline store track ordering", () => {
  beforeEach(() => {
    setProject(
      {
        tracks: [
          { id: "v1", type: "video", label: "V1", clips: [] },
          { id: "a1", type: "audio", label: "A1", clips: [] },
          { id: "v2", type: "video", label: "V2", name: "Top angle", clips: [] },
          { id: "a2", type: "audio", label: "A2", clips: [] },
        ],
        overlays: [],
      },
      null,
      "v2",
    );
  });

  it("moves the whole track within its type while preserving its identity", () => {
    const store = useLiteCutTimelineStore.getState();
    expect(store.canMoveTrack("v2", "up")).toBe(true);
    expect(store.moveTrack("v2", "up")).toBe(true);

    const tracks = useLiteCutEditorStore.getState().body.tracks;
    expect(tracks.map((track) => track.id)).toEqual(["v2", "a1", "v1", "a2"]);
    expect(tracks.find((track) => track.id === "v2")).toMatchObject({ label: "V2", name: "Top angle" });
    expect(tracks.find((track) => track.id === "v1").label).toBe("V1");
    expect(useLiteCutHistoryStore.getState().past).toHaveLength(1);
  });

  it("rejects boundaries and can select an empty track", () => {
    const store = useLiteCutTimelineStore.getState();
    expect(store.moveTrack("v1", "up")).toBe(false);
    expect(store.selectTrack("a2")).toBe(true);
    expect(useLiteCutTimelineStore.getState()).toMatchObject({ selectedClipId: null, selectedTrackId: "a2" });
  });

  it("inserts a track before or after a same-type target in one undoable action", () => {
    const store = useLiteCutTimelineStore.getState();
    expect(store.canMoveTrackTo("v2", "v1", "before")).toBe(true);
    expect(store.moveTrackTo("v2", "v1", "before")).toBe(true);
    expect(useLiteCutEditorStore.getState().body.tracks.map((track) => track.id)).toEqual(["v2", "a1", "v1", "a2"]);
    expect(store.moveTrackTo("a2", "a1", "before")).toBe(true);
    expect(useLiteCutEditorStore.getState().body.tracks.map((track) => track.id)).toEqual(["v2", "a2", "v1", "a1"]);
    expect(useLiteCutHistoryStore.getState().past).toHaveLength(2);
  });

  it("rejects a no-op or a cross-type track insertion", () => {
    const store = useLiteCutTimelineStore.getState();
    expect(store.canMoveTrackTo("v1", "a1", "before")).toBe(false);
    expect(store.moveTrackTo("v1", "v2", "before")).toBe(false);
    expect(useLiteCutHistoryStore.getState().past).toHaveLength(0);
  });
});

describe("liteCut timeline store slip edits", () => {
  beforeEach(() => {
    setProject({
      tracks: [
        {
          id: "v1",
          type: "video",
          clips: [clip("a", { timeline_start: 3, trim_in: 1, trim_out: 5, meta: { duration_sec: 10 } })],
        },
      ],
      overlays: [{ id: "ov", timeline_start: 0, duration: 2 }],
    });
  });

  it("slips the selected clip and records one history entry", () => {
    const store = useLiteCutTimelineStore.getState();
    expect(store.canSlipSelectedBy(1)).toBe(true);
    expect(store.slipSelectedBy(1)).toBe(true);
    const next = useLiteCutEditorStore.getState().body.tracks[0].clips[0];
    expect(next).toMatchObject({ timeline_start: 3, trim_in: 2, trim_out: 6 });
    expect(useLiteCutHistoryStore.getState().past).toHaveLength(1);
  });

  it("rejects overlays, multi-selection, and source boundaries", () => {
    const store = useLiteCutTimelineStore.getState();
    useLiteCutTimelineStore.setState({ selectedTrackId: "overlay", selectedClipId: "ov", selectedClipIds: ["ov"] });
    expect(store.slipSelectedBy(1)).toBe(false);

    useLiteCutTimelineStore.setState({ selectedTrackId: "v1", selectedClipId: "a", selectedClipIds: ["a", "ov"] });
    expect(store.slipSelectedBy(1)).toBe(false);

    useLiteCutTimelineStore.setState({ selectedClipIds: ["a"] });
    expect(store.slipSelectedBy(-10)).toBe(true);
    expect(store.slipSelectedBy(-1)).toBe(false);
  });
});

describe("liteCut timeline store source duration backfill", () => {
  beforeEach(() => {
    setProject({
      tracks: [
        {
          id: "v1",
          type: "video",
          clips: [
            clip("a", { source_type: "recorded_clip", source_id: 7, trim_out: 5, meta: { duration_sec: 5 } }),
            clip("b", { source_type: "recorded_clip", source_id: 7, timeline_start: 6, trim_out: 5, meta: { duration_sec: 5 } }),
            clip("other", { source_type: "recorded_clip", source_id: 8, timeline_start: 12, trim_out: 4, meta: { duration_sec: 4 } }),
          ],
        },
      ],
      overlays: [],
    });
  });

  it("corrects the fallback source duration for every clip sharing the source", () => {
    const store = useLiteCutTimelineStore.getState();
    expect(store.backfillClipSourceDuration("a", 18.4)).toBe(true);
    const clips = useLiteCutEditorStore.getState().body.tracks[0].clips;
    expect(clips[0].meta.duration_sec).toBeCloseTo(18.4);
    expect(clips[1].meta.duration_sec).toBeCloseTo(18.4);
    expect(clips[2].meta.duration_sec).toBe(4);
    expect(useLiteCutHistoryStore.getState().past).toHaveLength(0);
  });

  it("unlocks right-edge trims beyond the 5s fallback after the backfill", () => {
    const store = useLiteCutTimelineStore.getState();
    store.backfillClipSourceDuration("a", 18.4);
    store.trimClipRight("a", "v1", 12);
    const next = useLiteCutEditorStore.getState().body.tracks[0].clips[0];
    expect(next.trim_out).toBeCloseTo(12);
  });

  it("shrinks stale recorded clips when the database duration exceeds the media file", () => {
    setProject({
      tracks: [{
        id: "v1",
        type: "video",
        clips: [
          clip("a", { source_type: "recorded_clip", source_id: 7, trim_out: 16, meta: { duration_sec: 16 } }),
          clip("b", { source_type: "recorded_clip", source_id: 7, timeline_start: 20, trim_in: 2, trim_out: 7, meta: { duration_sec: 16 } }),
        ],
      }],
      overlays: [],
    });
    const store = useLiteCutTimelineStore.getState();
    expect(store.backfillClipSourceDuration("a", 8)).toBe(true);
    const clips = useLiteCutEditorStore.getState().body.tracks[0].clips;
    expect(clips[0].trim_out).toBe(8);
    expect(clips[0].meta.duration_sec).toBe(8);
    expect(clips[1].trim_in).toBe(2);
    expect(clips[1].trim_out).toBe(7);
    expect(clips[1].meta.duration_sec).toBe(8);
  });

  it("skips no-op updates and invalid durations", () => {
    const store = useLiteCutTimelineStore.getState();
    expect(store.backfillClipSourceDuration("a", 5.01)).toBe(false);
    expect(store.backfillClipSourceDuration("a", Number.NaN)).toBe(false);
    expect(store.backfillClipSourceDuration("missing", 12)).toBe(false);
    expect(useLiteCutEditorStore.getState().body.tracks[0].clips[0].meta.duration_sec).toBe(5);
  });
});

describe("liteCut timeline store video layer transform", () => {
  beforeEach(() => {
    setProject(
      {
        tracks: [
          { id: "v1", type: "video", clips: [clip("base")] },
          { id: "v2", type: "video", clips: [clip("layer")] },
        ],
        overlays: [],
      },
      "layer",
      "v2",
    );
  });

  it("persists a transform patch on an upper video layer", () => {
    const store = useLiteCutTimelineStore.getState();
    store.updateSelectedClip({
      transform: { x: 0.7, y: 0.3, width: 0.5, scale: 1.25, rotation: 12, opacity: 0.8 },
    });
    expect(useLiteCutEditorStore.getState().body.tracks[1].clips[0].transform).toEqual({
      x: 0.7,
      y: 0.3,
      width: 0.5,
      scale: 1.25,
      rotation: 12,
      opacity: 0.8,
    });
  });
});

describe("liteCut timeline store detached audio selection", () => {
  beforeEach(() => {
    setProject({
      tracks: [
        { id: "v1", type: "video", clips: [clip("video")] },
        { id: "a1", type: "audio", clips: [clip("audio", { meta: { source_clip_id: "video", detached_from_video: true } })] },
      ],
      overlays: [],
    }, "audio", "a1");
  });

  it("selects the detached audio pair as one editing selection", () => {
    const store = useLiteCutTimelineStore.getState();
    expect(store.canSelectLinkedClips()).toBe(true);
    expect(store.selectLinkedClips()).toBe(true);
    expect(useLiteCutTimelineStore.getState().selectedClipIds).toEqual(["video", "audio"]);
  });

  it("automatically selects both sides when either linked clip is clicked", () => {
    const body = useLiteCutEditorStore.getState().body;
    body.tracks[0].clips[0].meta = { linked_audio_clip_id: "audio" };
    useLiteCutEditorStore.setState({ body });

    useLiteCutTimelineStore.getState().selectClip("video", "v1");
    expect(useLiteCutTimelineStore.getState().selectedClipIds).toEqual(["video", "audio"]);
    useLiteCutTimelineStore.getState().selectClip("audio", "a1");
    expect(useLiteCutTimelineStore.getState().selectedClipIds).toEqual(["audio", "video"]);
  });

  it("detaches recorded audio with a streamable source id and keeps the pair selected", () => {
    setProject({
      tracks: [
        {
          id: "v1",
          type: "video",
          clips: [clip("recorded", {
            source_type: "recorded_clip",
            source_id: 91,
            meta: { duration_sec: 5, output_path: "C:/recordings/clip-91.mp4" },
          })],
        },
        { id: "a1", type: "audio", clips: [] },
      ],
      overlays: [],
    }, "recorded", "v1");

    expect(useLiteCutTimelineStore.getState().detachSelectedAudio()).toBe(true);
    const body = useLiteCutEditorStore.getState().body;
    const video = body.tracks[0].clips[0];
    const audio = body.tracks[1].clips[0];
    expect(video.muted).toBe(true);
    expect(audio).toMatchObject({ source_type: "file", source_id: 91, file_path: "C:/recordings/clip-91.mp4" });
    expect(useLiteCutTimelineStore.getState().selectedClipIds).toEqual([audio.id, video.id]);
  });

  it("unlinks the audio while retaining both timeline clips", () => {
    const store = useLiteCutTimelineStore.getState();
    const body = useLiteCutEditorStore.getState().body;
    body.tracks[0].clips[0].meta = { linked_audio_clip_id: "audio" };
    useLiteCutEditorStore.setState({ body });
    expect(store.unlinkSelectedClips()).toBe(true);
    const [video] = useLiteCutEditorStore.getState().body.tracks[0].clips;
    const [audio] = useLiteCutEditorStore.getState().body.tracks[1].clips;
    expect(video.meta?.linked_audio_clip_id).toBeUndefined();
    expect(audio.meta?.source_clip_id).toBeUndefined();
    expect(useLiteCutEditorStore.getState().body.tracks.flatMap((track) => track.clips).map((item) => item.id)).toEqual(["video", "audio"]);
  });

  it("links a selected video and audio pair", () => {
    setProject({
      tracks: [
        { id: "v1", type: "video", clips: [clip("video")] },
        { id: "a1", type: "audio", clips: [clip("audio", { meta: { kind: "audio" } })] },
      ],
      overlays: [],
    }, "video", "v1");
    useLiteCutTimelineStore.setState({ selectedClipIds: ["video", "audio"] });
    const store = useLiteCutTimelineStore.getState();
    expect(store.canLinkSelectedClips()).toBe(true);
    expect(store.linkSelectedClips()).toBe(true);
    const [video] = useLiteCutEditorStore.getState().body.tracks[0].clips;
    const [audio] = useLiteCutEditorStore.getState().body.tracks[1].clips;
    expect(video.meta?.linked_audio_clip_id).toBe("audio");
    expect(audio.meta?.source_clip_id).toBe("video");
  });

  it("splits a linked pair together and rebuilds both right-side links", () => {
    const body = useLiteCutEditorStore.getState().body;
    body.tracks[0].clips[0].meta = { linked_audio_clip_id: "audio" };
    useLiteCutEditorStore.setState({ body });
    useLiteCutTimelineStore.setState({ playheadSec: 2 });

    expect(useLiteCutTimelineStore.getState().splitAtPlayhead()).toBe(true);

    const [videoLeft, videoRight] = useLiteCutEditorStore.getState().body.tracks[0].clips;
    const [audioLeft, audioRight] = useLiteCutEditorStore.getState().body.tracks[1].clips;
    expect(videoLeft.meta?.linked_audio_clip_id).toBe(audioLeft.id);
    expect(audioLeft.meta?.source_clip_id).toBe(videoLeft.id);
    expect(videoRight.meta?.linked_audio_clip_id).toBe(audioRight.id);
    expect(audioRight.meta?.source_clip_id).toBe(videoRight.id);
    expect(useLiteCutTimelineStore.getState().selectedClipIds).toEqual([videoRight.id, audioRight.id]);
  });
});

describe("liteCut timeline store marker editing", () => {
  beforeEach(() => {
    setProject(
      {
        tracks: [{ id: "v1", type: "video", clips: [] }],
        overlays: [],
        markers: [{ id: "m1", time_sec: 4, label: "opening", color: "#f59e0b" }],
      },
      null,
      "v1",
    );
  });

  it("updates marker label and color without recording no-op edits", () => {
    const store = useLiteCutTimelineStore.getState();
    expect(store.updateMarker("m1", { label: "ace", color: "#22d3ee" })).toBe(true);
    expect(store.updateMarker("m1", { label: "ace", color: "#22d3ee" })).toBe(false);

    const marker = useLiteCutEditorStore.getState().body.markers[0];
    expect(marker).toMatchObject({ id: "m1", time_sec: 4, label: "ace", color: "#22d3ee" });
    expect(useLiteCutHistoryStore.getState().past).toHaveLength(1);
  });

  it("deletes a marker by id", () => {
    expect(useLiteCutTimelineStore.getState().deleteMarker("m1")).toBe(true);
    expect(useLiteCutEditorStore.getState().body.markers).toEqual([]);
    expect(useLiteCutTimelineStore.getState().deleteMarker("m1")).toBe(false);
  });
});

describe("liteCut timeline store export range", () => {
  beforeEach(() => {
    setProject(
      {
        output: { range_mode: "full", range_start_sec: 0, range_end_sec: null },
        tracks: [{ id: "v1", type: "video", clips: [] }],
        overlays: [],
      },
      null,
      "v1",
    );
  });

  it("records only meaningful export range changes", () => {
    const store = useLiteCutTimelineStore.getState();
    const patch = { range_mode: "custom", range_start_sec: 2, range_end_sec: 8 };
    expect(store.setExportRange(patch)).toBe(true);
    expect(store.setExportRange(patch)).toBe(false);
    expect(useLiteCutEditorStore.getState().body.output).toMatchObject(patch);
    expect(useLiteCutHistoryStore.getState().past).toHaveLength(1);
  });
});

describe("liteCut timeline store multi selection", () => {
  beforeEach(() => {
    setProject({ tracks: [{ id: "v1", type: "video", clips: [] }], overlays: [] }, null, "v1");
  });

  it("selects all actionable timeline items", () => {
    setProject({
      tracks: [
        { id: "v1", type: "video", locked: false, hidden: false, clips: [clip("a"), clip("b", { timeline_start: 5 })] },
        { id: "a1", type: "audio", locked: false, hidden: false, clips: [clip("music", { timeline_start: 1 })] },
        { id: "v2", type: "video", locked: true, hidden: false, clips: [clip("locked", { timeline_start: 2 })] },
        { id: "v3", type: "video", locked: false, hidden: true, clips: [clip("hidden", { timeline_start: 3 })] },
      ],
      overlays: [{ id: "title", type: "text", timeline_start: 2, duration: 3 }],
    }, null, "v1");

    expect(useLiteCutTimelineStore.getState().selectAllTimelineItems()).toBe(true);

    const state = useLiteCutTimelineStore.getState();
    expect(state.selectedClipId).toBe("a");
    expect(state.selectedTrackId).toBe("v1");
    expect(state.selectedClipIds).toEqual(["a", "b", "music", "title"]);
  });

  it("clears selection when selecting all on an empty timeline", () => {
    setProject({
      tracks: [
        { id: "v1", type: "video", locked: false, hidden: false, clips: [] },
        { id: "v2", type: "video", locked: true, hidden: false, clips: [clip("locked")] },
      ],
      overlays: [],
    }, "locked", "v2");

    expect(useLiteCutTimelineStore.getState().selectAllTimelineItems()).toBe(false);
    expect(useLiteCutTimelineStore.getState().selectedClipIds).toEqual([]);
    expect(useLiteCutTimelineStore.getState().selectedClipId).toBeNull();
  });

  it("selects timeline items to the right of the playhead", () => {
    setProject({
      tracks: [
        {
          id: "v1",
          type: "video",
          locked: false,
          hidden: false,
          clips: [
            clip("left", { timeline_start: 0, trim_out: 2 }),
            clip("cross", { timeline_start: 3, trim_out: 5 }),
            clip("right", { timeline_start: 8, trim_out: 10 }),
          ],
        },
        { id: "a1", type: "audio", locked: false, hidden: false, clips: [clip("music", { timeline_start: 6, trim_out: 8 })] },
        { id: "v2", type: "video", locked: true, hidden: false, clips: [clip("locked", { timeline_start: 9 })] },
        { id: "v3", type: "video", locked: false, hidden: true, clips: [clip("hidden", { timeline_start: 9 })] },
      ],
      overlays: [
        { id: "title", type: "text", timeline_start: 4, duration: 3 },
        { id: "endcard", type: "text", timeline_start: 11, duration: 2 },
      ],
    }, null, "v1");
    useLiteCutTimelineStore.setState({ playheadSec: 4 });

    expect(useLiteCutTimelineStore.getState().selectTimelineItemsFromPlayhead("right")).toBe(true);

    const state = useLiteCutTimelineStore.getState();
    expect(state.selectedClipId).toBe("cross");
    expect(state.selectedTrackId).toBe("v1");
    expect(state.selectedClipIds).toEqual(["cross", "right", "music", "title", "endcard"]);
  });

  it("selects timeline items to the left of the playhead", () => {
    setProject({
      tracks: [
        {
          id: "v1",
          type: "video",
          locked: false,
          hidden: false,
          clips: [
            clip("left", { timeline_start: 0, trim_out: 2 }),
            clip("cross", { timeline_start: 3, trim_out: 5 }),
            clip("right", { timeline_start: 8, trim_out: 10 }),
          ],
        },
        { id: "a1", type: "audio", locked: false, hidden: false, clips: [clip("music", { timeline_start: 1, trim_out: 3 })] },
      ],
      overlays: [
        { id: "title", type: "text", timeline_start: 4, duration: 3 },
        { id: "future", type: "text", timeline_start: 9, duration: 2 },
      ],
    }, null, "v1");
    useLiteCutTimelineStore.setState({ playheadSec: 4 });

    expect(useLiteCutTimelineStore.getState().selectTimelineItemsFromPlayhead("left")).toBe(true);

    const state = useLiteCutTimelineStore.getState();
    expect(state.selectedClipId).toBe("left");
    expect(state.selectedTrackId).toBe("v1");
    expect(state.selectedClipIds).toEqual(["left", "cross", "music"]);
  });

  it("selects left or right items from the selected clip end boundary", () => {
    setProject({
      tracks: [{
        id: "v1",
        type: "video",
        clips: [
          clip("anchor", { timeline_start: 2, trim_out: 3 }),
          clip("before-end", { timeline_start: 4, trim_out: 2 }),
          clip("at-end", { timeline_start: 5, trim_out: 2 }),
          clip("later", { timeline_start: 9, trim_out: 2 }),
        ],
      }],
      overlays: [{ id: "title", type: "text", timeline_start: 1, duration: 2 }],
    }, "anchor", "v1");
    useLiteCutTimelineStore.setState({ playheadSec: 2.25 });

    const store = useLiteCutTimelineStore.getState();
    expect(store.selectTimelineItemsRelativeToClip("anchor", "left")).toBe(true);
    expect(useLiteCutTimelineStore.getState().selectedClipIds).toEqual(["anchor", "before-end", "title"]);
    expect(useLiteCutTimelineStore.getState().selectTimelineItemsRelativeToClip("anchor", "right")).toBe(true);
    expect(useLiteCutTimelineStore.getState().selectedClipIds).toEqual(["at-end", "later"]);
  });

  it("toggles multiple clips and deletes them together", () => {
    setProject({
      tracks: [
        { id: "v1", type: "video", locked: false, clips: [clip("a"), clip("b", { timeline_start: 5 })] },
        { id: "a1", type: "audio", locked: false, clips: [clip("music", { timeline_start: 1 })] },
      ],
      overlays: [{ id: "title", type: "text", timeline_start: 2, duration: 3 }],
    });

    const store = useLiteCutTimelineStore.getState();
    store.toggleClipSelection("b", "v1");
    store.toggleClipSelection("title", "overlay");
    expect(useLiteCutTimelineStore.getState().selectedClipIds).toEqual(["a", "b", "title"]);

    useLiteCutTimelineStore.getState().deleteSelected();
    const body = useLiteCutEditorStore.getState().body;
    expect(body.tracks[0].clips).toEqual([]);
    expect(body.tracks[1].clips.map((c) => c.id)).toEqual(["music"]);
    expect(body.overlays).toEqual([]);
    expect(useLiteCutTimelineStore.getState().selectedClipIds).toEqual([]);
  });

  it("copies and pastes a multi selection while preserving offsets", () => {
    setProject({
      tracks: [{ id: "v1", type: "video", locked: false, clips: [clip("a"), clip("b", { timeline_start: 5 })] }],
      overlays: [{ id: "title", type: "text", timeline_start: 2, duration: 3 }],
    });
    const store = useLiteCutTimelineStore.getState();
    store.toggleClipSelection("b", "v1");
    store.toggleClipSelection("title", "overlay");
    expect(store.copySelected()).toBe(true);
    useLiteCutTimelineStore.setState({ playheadSec: 12 });
    expect(useLiteCutTimelineStore.getState().pasteClipboard()).toBe(true);

    const body = useLiteCutEditorStore.getState().body;
    const pastedClips = body.tracks.flatMap((track) => track.clips).filter((c) => !["a", "b"].includes(c.id));
    const pastedOverlay = body.overlays.find((o) => o.id !== "title");
    expect(pastedClips.map((c) => c.timeline_start).sort((a, b) => a - b)).toEqual([12, 17]);
    expect(pastedOverlay.timeline_start).toBe(14);
    expect(useLiteCutTimelineStore.getState().selectedClipIds).toHaveLength(3);
  });

  it("nudges selected clips together without colliding with unselected clips", () => {
    setProject({
      tracks: [
        {
          id: "v1",
          type: "video",
          locked: false,
          clips: [clip("a", { timeline_start: 2 }), clip("b", { timeline_start: 7 }), clip("wall", { timeline_start: 12 })],
        },
      ],
      overlays: [],
    });
    const store = useLiteCutTimelineStore.getState();
    store.toggleClipSelection("b", "v1");
    expect(useLiteCutTimelineStore.getState().nudgeSelectedBy(1)).toBe(true);
    expect(useLiteCutEditorStore.getState().body.tracks[0].clips.map((c) => [c.id, c.timeline_start])).toEqual([
      ["a", 3],
      ["b", 8],
      ["wall", 12],
    ]);
    expect(useLiteCutTimelineStore.getState().nudgeSelectedBy(2)).toBe(false);
  });

  it("moves a multi selection by a drag delta", () => {
    setProject({
      tracks: [
        { id: "v1", type: "video", locked: false, clips: [clip("a", { timeline_start: 2 }), clip("b", { timeline_start: 8 })] },
        { id: "a1", type: "audio", locked: false, clips: [clip("music", { timeline_start: 4 })] },
      ],
      overlays: [{ id: "title", type: "text", timeline_start: 6, duration: 2 }],
    });
    const store = useLiteCutTimelineStore.getState();
    store.toggleClipSelection("music", "a1");
    store.toggleOverlaySelection("title");

    expect(useLiteCutTimelineStore.getState().canMoveSelectionBy(1.5)).toBe(true);
    expect(useLiteCutTimelineStore.getState().moveSelectionBy(1.5)).toBe(true);

    const body = useLiteCutEditorStore.getState().body;
    expect(body.tracks[0].clips.find((c) => c.id === "a").timeline_start).toBe(3.5);
    expect(body.tracks[1].clips.find((c) => c.id === "music").timeline_start).toBe(5.5);
    expect(body.overlays.find((o) => o.id === "title").timeline_start).toBe(7.5);
  });

  it("blocks a multi selection drag that would collide with unselected clips", () => {
    setProject({
      tracks: [
        {
          id: "v1",
          type: "video",
          locked: false,
          clips: [clip("a", { timeline_start: 0 }), clip("b", { timeline_start: 5 }), clip("wall", { timeline_start: 10 })],
        },
      ],
      overlays: [],
    });
    const store = useLiteCutTimelineStore.getState();
    store.toggleClipSelection("b", "v1");

    expect(useLiteCutTimelineStore.getState().canMoveSelectionBy(2)).toBe(false);
    expect(useLiteCutTimelineStore.getState().moveSelectionBy(2)).toBe(false);
    expect(useLiteCutEditorStore.getState().body.tracks[0].clips.map((c) => [c.id, c.timeline_start])).toEqual([
      ["a", 0],
      ["b", 5],
      ["wall", 10],
    ]);
  });

  it("splits only selected clips and overlays at the playhead", () => {
    setProject({
      tracks: [
        {
          id: "v1",
          type: "video",
          locked: false,
          clips: [
            clip("a", { timeline_start: 0, trim_in: 0, trim_out: 8 }),
            clip("unselected", { timeline_start: 10, trim_in: 0, trim_out: 8 }),
          ],
        },
        { id: "a1", type: "audio", locked: false, clips: [clip("music", { timeline_start: 1, trim_in: 0, trim_out: 9 })] },
      ],
      overlays: [
        { id: "title", type: "text", timeline_start: 2, duration: 6 },
        { id: "later-title", type: "text", timeline_start: 12, duration: 3 },
      ],
    });
    useLiteCutTimelineStore.setState({ playheadSec: 4 });
    const store = useLiteCutTimelineStore.getState();
    store.toggleClipSelection("music", "a1");
    store.toggleOverlaySelection("title");

    expect(useLiteCutTimelineStore.getState().splitAtPlayhead()).toBe(true);

    const body = useLiteCutEditorStore.getState().body;
    const v1 = body.tracks.find((t) => t.id === "v1");
    const a1 = body.tracks.find((t) => t.id === "a1");
    expect(v1.clips).toHaveLength(3);
    expect(v1.clips.find((c) => c.id === "a").trim_out).toBe(4);
    expect(v1.clips.find((c) => c.id === "unselected").trim_out).toBe(8);
    expect(a1.clips).toHaveLength(2);
    expect(body.overlays.map((o) => [o.id, o.timeline_start, o.duration])).toEqual([
      ["title", 2, 2],
      [expect.any(String), 4, 4],
      ["later-title", 12, 3],
    ]);
    expect(useLiteCutTimelineStore.getState().selectedClipIds).toHaveLength(3);
  });

  it("does not push a meaningful split when no selected clip crosses playhead", () => {
    setProject({
      tracks: [{ id: "v1", type: "video", locked: false, clips: [clip("a", { timeline_start: 0, trim_in: 0, trim_out: 3 })] }],
      overlays: [{ id: "title", type: "text", timeline_start: 5, duration: 2 }],
    });
    useLiteCutTimelineStore.setState({ playheadSec: 4 });
    const store = useLiteCutTimelineStore.getState();
    store.toggleOverlaySelection("title");

    expect(useLiteCutTimelineStore.getState().splitAtPlayhead()).toBe(false);
    expect(useLiteCutEditorStore.getState().body.tracks[0].clips).toHaveLength(1);
    expect(useLiteCutEditorStore.getState().body.overlays).toHaveLength(1);
  });

  it("left-trims selected clips and overlays to the playhead", () => {
    setProject({
      tracks: [
        {
          id: "v1",
          type: "video",
          locked: false,
          clips: [
            clip("a", { timeline_start: 0, trim_in: 0, trim_out: 8 }),
            clip("unselected", { timeline_start: 10, trim_in: 0, trim_out: 8 }),
          ],
        },
        { id: "a1", type: "audio", locked: false, clips: [clip("music", { timeline_start: 1, trim_in: 0, trim_out: 9 })] },
      ],
      overlays: [{ id: "title", type: "text", timeline_start: 2, duration: 6 }],
    });
    useLiteCutTimelineStore.setState({ playheadSec: 4 });
    const store = useLiteCutTimelineStore.getState();
    store.toggleClipSelection("music", "a1");
    store.toggleOverlaySelection("title");

    expect(useLiteCutTimelineStore.getState().canTrimSelectedStartToPlayhead()).toBe(true);
    expect(useLiteCutTimelineStore.getState().trimSelectedStartToPlayhead()).toBe(true);

    const body = useLiteCutEditorStore.getState().body;
    const a = body.tracks[0].clips.find((c) => c.id === "a");
    const unselected = body.tracks[0].clips.find((c) => c.id === "unselected");
    const music = body.tracks[1].clips.find((c) => c.id === "music");
    const title = body.overlays.find((o) => o.id === "title");
    expect(a.timeline_start).toBe(4);
    expect(a.trim_in).toBe(4);
    expect(a.trim_out).toBe(8);
    expect(unselected.timeline_start).toBe(10);
    expect(music.timeline_start).toBe(4);
    expect(music.trim_in).toBe(3);
    expect(title.timeline_start).toBe(4);
    expect(title.duration).toBe(4);
    expect(useLiteCutTimelineStore.getState().selectedClipIds).toEqual(["a", "music", "title"]);
  });

  it("right-trims selected clips and overlays to the playhead", () => {
    setProject({
      tracks: [
        { id: "v1", type: "video", locked: false, clips: [clip("a", { timeline_start: 0, trim_in: 0, trim_out: 8 })] },
        { id: "a1", type: "audio", locked: false, clips: [clip("music", { timeline_start: 1, trim_in: 0, trim_out: 9 })] },
      ],
      overlays: [
        { id: "title", type: "text", timeline_start: 2, duration: 6 },
        { id: "later-title", type: "text", timeline_start: 8, duration: 3 },
      ],
    });
    useLiteCutTimelineStore.setState({ playheadSec: 4 });
    const store = useLiteCutTimelineStore.getState();
    store.toggleClipSelection("music", "a1");
    store.toggleOverlaySelection("title");
    store.toggleOverlaySelection("later-title");

    expect(useLiteCutTimelineStore.getState().canTrimSelectedEndToPlayhead()).toBe(true);
    expect(useLiteCutTimelineStore.getState().trimSelectedEndToPlayhead()).toBe(true);

    const body = useLiteCutEditorStore.getState().body;
    expect(body.tracks[0].clips.find((c) => c.id === "a").trim_out).toBe(4);
    expect(body.tracks[1].clips.find((c) => c.id === "music").trim_out).toBe(3);
    expect(body.overlays.find((o) => o.id === "title").duration).toBe(2);
    expect(body.overlays.find((o) => o.id === "later-title").duration).toBe(3);
  });

  it("ripple deletes selected clips per track and closes later gaps", () => {
    setProject({
      tracks: [
        {
          id: "v1",
          type: "video",
          locked: false,
          clips: [
            clip("a", { timeline_start: 0, trim_out: 2 }),
            clip("b", { timeline_start: 4, trim_out: 3 }),
            clip("c", { timeline_start: 10, trim_out: 2 }),
          ],
        },
        {
          id: "a1",
          type: "audio",
          locked: false,
          clips: [
            clip("music-a", { timeline_start: 1, trim_out: 2 }),
            clip("music-b", { timeline_start: 6, trim_out: 2 }),
          ],
        },
      ],
      overlays: [
        { id: "title", type: "text", timeline_start: 2, duration: 2 },
        { id: "badge", type: "text", timeline_start: 8, duration: 1 },
      ],
    });
    const store = useLiteCutTimelineStore.getState();
    store.toggleClipSelection("b", "v1");
    store.toggleClipSelection("music-a", "a1");
    store.toggleOverlaySelection("title");

    expect(useLiteCutTimelineStore.getState().canRippleDeleteSelected()).toBe(true);
    expect(useLiteCutTimelineStore.getState().rippleDeleteSelected()).toBe(true);

    const body = useLiteCutEditorStore.getState().body;
    expect(body.tracks[0].clips.map((c) => [c.id, c.timeline_start])).toEqual([["c", 5]]);
    expect(body.tracks[1].clips.map((c) => [c.id, c.timeline_start])).toEqual([
      ["music-b", 4],
    ]);
    expect(body.overlays.map((o) => [o.id, o.timeline_start])).toEqual([
      ["badge", 6],
    ]);
    expect(useLiteCutTimelineStore.getState().selectedClipIds).toEqual([]);
  });

  it("does not ripple delete selected clips from locked tracks", () => {
    setProject({
      tracks: [
        {
          id: "v1",
          type: "video",
          locked: false,
          clips: [clip("a", { timeline_start: 0, trim_out: 2 }), clip("b", { timeline_start: 5, trim_out: 2 })],
        },
        {
          id: "v2",
          type: "video",
          locked: true,
          clips: [clip("locked", { timeline_start: 0, trim_out: 2 }), clip("locked-next", { timeline_start: 5, trim_out: 2 })],
        },
      ],
      overlays: [],
    });
    const store = useLiteCutTimelineStore.getState();
    store.toggleClipSelection("locked", "v2");

    expect(useLiteCutTimelineStore.getState().rippleDeleteSelected()).toBe(true);
    const body = useLiteCutEditorStore.getState().body;
    expect(body.tracks.find((t) => t.id === "v1").clips.map((c) => [c.id, c.timeline_start])).toEqual([["b", 3]]);
    expect(body.tracks.find((t) => t.id === "v2").clips.map((c) => [c.id, c.timeline_start])).toEqual([
      ["locked", 0],
      ["locked-next", 5],
    ]);
  });

  it("applies clip property patches to selected timeline clips only", () => {
    setProject({
      tracks: [
        {
          id: "v1",
          type: "video",
          locked: false,
          clips: [clip("a", { volume: 1, speed: 1 }), clip("b", { timeline_start: 5, volume: 1, speed: 1 })],
        },
        {
          id: "a1",
          type: "audio",
          locked: false,
          clips: [clip("music", { timeline_start: 1, volume: 1, speed: 1 })],
        },
        {
          id: "v2",
          type: "video",
          locked: true,
          clips: [clip("locked", { timeline_start: 2, volume: 1, speed: 1 })],
        },
      ],
      overlays: [{ id: "title", type: "text", timeline_start: 2, duration: 3, volume: 1 }],
    });
    const store = useLiteCutTimelineStore.getState();
    store.toggleClipSelection("music", "a1");
    store.toggleClipSelection("locked", "v2");
    store.toggleOverlaySelection("title");

    useLiteCutTimelineStore.getState().updateSelectedClip({
      volume: 0.35,
      speed: 1.5,
      canvas_fit: "cover",
      crop: { x: 0.1, y: 0.2, width: 0.8, height: 0.7 },
    });

    const body = useLiteCutEditorStore.getState().body;
    expect(body.tracks.find((t) => t.id === "v1").clips.find((c) => c.id === "a")).toMatchObject({
      volume: 0.35,
      speed: 1.5,
      canvas_fit: "cover",
      crop: { x: 0.1, y: 0.2, width: 0.8, height: 0.7 },
    });
    expect(body.tracks.find((t) => t.id === "v1").clips.find((c) => c.id === "b")).toMatchObject({
      volume: 1,
      speed: 1,
    });
    expect(body.tracks.find((t) => t.id === "a1").clips.find((c) => c.id === "music")).toMatchObject({
      volume: 0.35,
      speed: 1.5,
    });
    expect(body.tracks.find((t) => t.id === "a1").clips.find((c) => c.id === "music").canvas_fit).toBeUndefined();
    expect(body.tracks.find((t) => t.id === "a1").clips.find((c) => c.id === "music").crop).toBeUndefined();
    expect(body.tracks.find((t) => t.id === "v2").clips.find((c) => c.id === "locked")).toMatchObject({
      volume: 1,
      speed: 1,
    });
    expect(body.overlays.find((o) => o.id === "title").volume).toBe(1);
  });

  it("does not apply video-only clip patches to a selected audio clip", () => {
    setProject({
      tracks: [
        { id: "v1", type: "video", locked: false, clips: [clip("a")] },
        { id: "a1", type: "audio", locked: false, clips: [clip("music", { timeline_start: 1, volume: 1 })] },
      ],
      overlays: [],
    }, "music", "a1");

    useLiteCutTimelineStore.getState().updateSelectedClip({ canvas_fit: "blur", crop: { width: 0.5 } });

    const music = useLiteCutEditorStore.getState().body.tracks.find((t) => t.id === "a1").clips[0];
    expect(music.canvas_fit).toBeUndefined();
    expect(music.crop).toBeUndefined();
    expect(music.volume).toBe(1);
  });

  it("applies transition patches to selected editable video clips only", () => {
    setProject({
      tracks: [
        {
          id: "v1",
          type: "video",
          locked: false,
          clips: [clip("a"), clip("b", { timeline_start: 5 })],
        },
        {
          id: "a1",
          type: "audio",
          locked: false,
          clips: [clip("music", { timeline_start: 1 })],
        },
        {
          id: "v2",
          type: "video",
          locked: true,
          clips: [clip("locked", { timeline_start: 2 })],
        },
      ],
      overlays: [{ id: "title", type: "text", timeline_start: 2, duration: 3 }],
    });
    const store = useLiteCutTimelineStore.getState();
    store.toggleClipSelection("music", "a1");
    store.toggleClipSelection("locked", "v2");
    store.toggleOverlaySelection("title");

    useLiteCutTimelineStore.getState().updateSelectedTransition("flash", 0.75);

    const body = useLiteCutEditorStore.getState().body;
    expect(body.tracks.find((t) => t.id === "v1").clips.find((c) => c.id === "a").transition_out).toEqual({
      type: "flash",
      duration_sec: 0.75,
    });
    expect(body.tracks.find((t) => t.id === "v1").clips.find((c) => c.id === "b").transition_out).toBeUndefined();
    expect(body.tracks.find((t) => t.id === "a1").clips.find((c) => c.id === "music").transition_out).toBeUndefined();
    expect(body.tracks.find((t) => t.id === "v2").clips.find((c) => c.id === "locked").transition_out).toBeUndefined();
    expect(body.overlays.find((o) => o.id === "title").transition_out).toBeUndefined();
  });

  it("normalizes cut transition when applying to a multi selection", () => {
    setProject({
      tracks: [{ id: "v1", type: "video", locked: false, clips: [clip("a"), clip("b", { timeline_start: 5 })] }],
      overlays: [],
    });
    useLiteCutTimelineStore.getState().toggleClipSelection("b", "v1");

    useLiteCutTimelineStore.getState().updateSelectedTransition("none", 0.75);

    const body = useLiteCutEditorStore.getState().body;
    expect(body.tracks[0].clips.map((c) => c.transition_out)).toEqual([
      { type: "cut", duration_sec: 0 },
      { type: "cut", duration_sec: 0 },
    ]);
  });

  it("applies color patches to selected editable video clips only", () => {
    setProject({
      tracks: [
        {
          id: "v1",
          type: "video",
          locked: false,
          clips: [
            clip("a", { color: { brightness: 2, contrast: 4, saturation: 6, filter_preset: null } }),
            clip("b", { timeline_start: 5, color: { brightness: 0, contrast: 0, saturation: 0, filter_preset: null } }),
          ],
        },
        {
          id: "a1",
          type: "audio",
          locked: false,
          clips: [clip("music", { timeline_start: 1, color: { brightness: 1 } })],
        },
        {
          id: "v2",
          type: "video",
          locked: true,
          clips: [clip("locked", { timeline_start: 2, color: { brightness: 3 } })],
        },
        {
          id: "v3",
          type: "video",
          hidden: true,
          clips: [clip("hidden", { timeline_start: 8, color: { brightness: 4 } })],
        },
      ],
      overlays: [{ id: "title", type: "text", timeline_start: 2, duration: 3, color: { brightness: 5 } }],
    });
    const store = useLiteCutTimelineStore.getState();
    store.toggleClipSelection("music", "a1");
    store.toggleClipSelection("locked", "v2");
    store.toggleClipSelection("hidden", "v3");
    store.toggleOverlaySelection("title");

    useLiteCutTimelineStore.getState().updateSelectedColor({ brightness: 18, filter_preset: "esports" });

    const body = useLiteCutEditorStore.getState().body;
    expect(body.tracks.find((t) => t.id === "v1").clips.find((c) => c.id === "a").color).toEqual({
      brightness: 18,
      contrast: 4,
      saturation: 6,
      filter_preset: "esports",
    });
    expect(body.tracks.find((t) => t.id === "v1").clips.find((c) => c.id === "b").color).toEqual({
      brightness: 0,
      contrast: 0,
      saturation: 0,
      filter_preset: null,
    });
    expect(body.tracks.find((t) => t.id === "a1").clips.find((c) => c.id === "music").color).toEqual({ brightness: 1 });
    expect(body.tracks.find((t) => t.id === "v2").clips.find((c) => c.id === "locked").color).toEqual({ brightness: 3 });
    expect(body.tracks.find((t) => t.id === "v3").clips.find((c) => c.id === "hidden").color).toEqual({ brightness: 4 });
    expect(body.overlays.find((o) => o.id === "title").color).toEqual({ brightness: 5 });
  });

  it("merges color patches across a video multi selection", () => {
    setProject({
      tracks: [
        {
          id: "v1",
          type: "video",
          locked: false,
          clips: [
            clip("a", { color: { brightness: 1, contrast: 2, saturation: 3, filter_preset: null } }),
            clip("b", { timeline_start: 5, color: { brightness: 4, contrast: 5, saturation: 6, filter_preset: "warm" } }),
          ],
        },
      ],
      overlays: [],
    });
    useLiteCutTimelineStore.getState().toggleClipSelection("b", "v1");

    useLiteCutTimelineStore.getState().updateSelectedColor({ contrast: 24 });

    const body = useLiteCutEditorStore.getState().body;
    expect(body.tracks[0].clips.map((c) => c.color)).toEqual([
      { brightness: 1, contrast: 24, saturation: 3, filter_preset: null },
      { brightness: 4, contrast: 24, saturation: 6, filter_preset: "warm" },
    ]);
  });

  it("replaces a selected video source without discarding its edit settings", () => {
    setProject({
      tracks: [
        {
          id: "v1",
          type: "video",
          locked: false,
          clips: [
            clip("keep", {
              source_id: 1,
              timeline_start: 4,
              trim_in: 1,
              trim_out: 7,
              speed: 1.5,
              speed_keyframes: [{ source_sec: 1, speed: 0.5 }, { source_sec: 5, speed: 2 }],
              volume: 0.4,
              color: { brightness: 8, contrast: 0, saturation: 0 },
              meta: { title: "old", duration_sec: 12 },
            }),
          ],
        },
      ],
      overlays: [],
    });
    useLiteCutTimelineStore.getState().selectClip("keep", "v1");

    expect(
      useLiteCutTimelineStore.getState().replaceSelectedClipSource({
        id: 21,
        mediaKind: "asset",
        kind: "video",
        name: "replacement.mp4",
        path: "C:/assets/replacement.mp4",
        duration_sec: 4,
      }),
    ).toBe(true);

    const next = useLiteCutEditorStore.getState().body.tracks[0].clips[0];
    expect(next).toMatchObject({
      id: "keep",
      source_type: "file",
      file_path: "C:/assets/replacement.mp4",
      timeline_start: 4,
      trim_in: 0,
      trim_out: 4,
      speed: 1.5,
      speed_keyframes: [],
      volume: 0.4,
      color: { brightness: 8, contrast: 0, saturation: 0 },
      meta: { asset_id: 21, name: "replacement.mp4", kind: "video" },
    });
  });

  it("edits a video layer keyframe at the playhead without changing its base transform", () => {
    setProject({
      tracks: [
        {
          id: "v2",
          type: "video",
          locked: false,
          clips: [
            clip("layer", {
              timeline_start: 2,
              trim_out: 8,
              transform: { x: 0.2, y: 0.5, width: 1, scale: 1 },
            }),
          ],
        },
      ],
      overlays: [],
    }, "layer", "v2");
    const store = useLiteCutTimelineStore.getState();
    store.upsertClipKeyframe("layer", "v2", 5);
    store.updateClipTransformAtTime("layer", "v2", 5, { x: 0.8, scale: 1.4 });

    const layer = useLiteCutEditorStore.getState().body.tracks[0].clips[0];
    expect(layer.transform).toMatchObject({ x: 0.2, scale: 1 });
    expect(layer.keyframes).toEqual([
      expect.objectContaining({ time_sec: 3, transform: expect.objectContaining({ x: 0.8, scale: 1.4, width: 1 }) }),
    ]);
  });

  it("edits clip volume at an audio keyframe without changing the base volume", () => {
    setProject({
      tracks: [{ id: "a1", type: "audio", locked: false, clips: [clip("voice", { timeline_start: 2, volume: 0.8 })] }],
      overlays: [],
    }, "voice", "a1");
    const store = useLiteCutTimelineStore.getState();
    store.upsertClipAudioKeyframe("voice", "a1", 3);
    store.updateClipVolumeAtTime("voice", "a1", 3, 0.35);
    const voice = useLiteCutEditorStore.getState().body.tracks[0].clips[0];
    expect(voice.volume).toBe(0.8);
    expect(voice.audio_keyframes).toEqual([{ time_sec: 1, volume: 0.35 }]);
    store.removeClipAudioKeyframe("voice", "a1", 3);
    expect(useLiteCutEditorStore.getState().body.tracks[0].clips[0].audio_keyframes).toEqual([]);
  });

  it("adds and edits a detached audio keyframe while its linked video is selected too", () => {
    setProject({
      tracks: [
        {
          id: "v1",
          type: "video",
          locked: false,
          clips: [clip(101, { meta: { linked_audio_clip_id: 202 } })],
        },
        {
          id: "a1",
          type: "audio",
          locked: false,
          clips: [clip(202, { timeline_start: 2, volume: 0.8, meta: { kind: "audio", source_clip_id: 101 } })],
        },
      ],
      overlays: [],
    }, 202, "a1");

    const store = useLiteCutTimelineStore.getState();
    store.selectClipIds(["101", "202"], "202", "a1");
    const selected = useLiteCutTimelineStore.getState();
    selected.upsertClipAudioKeyframe(selected.selectedClipId, selected.selectedTrackId, 3);
    selected.updateClipVolumeAtTime(selected.selectedClipId, selected.selectedTrackId, 3, 0.35);

    const audio = useLiteCutEditorStore.getState().body.tracks[1].clips[0];
    expect(audio.volume).toBe(0.8);
    expect(audio.audio_keyframes).toEqual([{ time_sec: 1, volume: 0.35 }]);
  });

  it("moves transform and audio keyframes while preserving their values", () => {
    setProject({
      output: { fps: 60 },
      tracks: [{ id: "v2", type: "video", locked: false, clips: [clip("layer", {
        timeline_start: 2,
        trim_out: 8,
        keyframes: [{ time_sec: 1, transform: { x: 0.8, y: 0.4, scale: 1.2 } }],
        audio_keyframes: [{ time_sec: 1.5, volume: 0.35 }],
      })] }],
      overlays: [{ id: "title", type: "text", timeline_start: 4, duration: 3, transform: { x: 0.5 }, keyframes: [{ time_sec: 1, transform: { x: 0.2 } }] }],
    }, "layer", "v2");
    const store = useLiteCutTimelineStore.getState();

    expect(store.moveClipKeyframe("layer", "v2", 3, 4.25)).toBe(true);
    expect(store.moveClipAudioKeyframe("layer", "v2", 3.5, 5)).toBe(true);
    expect(store.moveOverlayKeyframe("title", 5, 6.5)).toBe(true);

    const next = useLiteCutEditorStore.getState().body;
    expect(next.tracks[0].clips[0].keyframes).toEqual([
      expect.objectContaining({ time_sec: 2.25, transform: expect.objectContaining({ x: 0.8, scale: 1.2 }) }),
    ]);
    expect(next.tracks[0].clips[0].audio_keyframes).toEqual([{ time_sec: 3, volume: 0.35 }]);
    expect(next.overlays[0].keyframes).toEqual([
      expect.objectContaining({ time_sec: 2.5, transform: expect.objectContaining({ x: 0.2 }) }),
    ]);
  });

  it("groups mixed timeline items and expands selection from any group member", () => {
    setProject({
      tracks: [{ id: "v1", type: "video", locked: false, clips: [clip("video"), clip("other", { timeline_start: 5 })] }],
      overlays: [{ id: "title", type: "text", timeline_start: 1, duration: 2, meta: {} }],
    }, "video", "v1");
    const store = useLiteCutTimelineStore.getState();
    store.toggleOverlaySelection("title");
    expect(store.canGroupSelectedItems()).toBe(true);
    expect(store.groupSelectedItems()).toBe(true);

    const body = useLiteCutEditorStore.getState().body;
    const groupId = body.tracks[0].clips[0].meta.group_id;
    expect(groupId).toMatch(/^grp-/);
    expect(body.overlays[0].meta.group_id).toBe(groupId);

    store.selectOverlay("title");
    expect(useLiteCutTimelineStore.getState().selectedClipIds.sort()).toEqual(["title", "video"]);
    expect(store.ungroupSelectedItems()).toBe(true);
    expect(useLiteCutEditorStore.getState().body.overlays[0].meta.group_id).toBeUndefined();
    expect(useLiteCutEditorStore.getState().body.tracks[0].clips[0].meta.group_id).toBeUndefined();
  });

  it("applies motion presets as exportable endpoint keyframes", () => {
    setProject({
      tracks: [{ id: "v2", type: "video", locked: false, clips: [clip("layer", { trim_out: 4, transform: { x: 0.5, width: 1, scale: 1 } })] }],
      overlays: [{ id: "title", type: "text", timeline_start: 2, duration: 3, transform: { x: 0.5, width: 0.33, scale: 1 } }],
    }, "layer", "v2");
    const store = useLiteCutTimelineStore.getState();
    expect(store.applyClipMotionPreset("layer", "v2", "zoom_in")).toBe(true);
    expect(useLiteCutEditorStore.getState().body.tracks[0].clips[0].keyframes).toMatchObject([
      { time_sec: 0, transform: { scale: 1 } },
      { time_sec: 4, transform: { scale: 1.25 } },
    ]);
    expect(store.applyOverlayMotionPreset("title", "pan_left")).toBe(true);
    expect(useLiteCutEditorStore.getState().body.overlays[0].keyframes).toMatchObject([
      { time_sec: 0, transform: { x: 0.72 } },
      { time_sec: 3, transform: { x: 0.28 } },
    ]);
  });

  it("applies a text style patch to subtitle overlays without touching ordinary text", () => {
    setProject({
      tracks: [{ id: "v1", type: "video", clips: [] }],
      overlays: [
        { id: "sub-1", type: "text", timeline_start: 1, duration: 2, text: { content: "First", preset_id: "plain" }, meta: { subtitle: true } },
        { id: "sub-2", type: "text", timeline_start: 4, duration: 2, text: { content: "Second", preset_id: "plain" }, meta: { subtitle: true } },
        { id: "title", type: "text", timeline_start: 0, duration: 2, text: { content: "TITLE", preset_id: "title" }, meta: {} },
      ],
    }, "sub-1", "overlay");
    const count = useLiteCutTimelineStore.getState().applyTextPatchToSubtitles({
      preset_id: "clutch",
      font_family: "Rajdhani Bold",
      font_size: 62,
    });
    const overlays = useLiteCutEditorStore.getState().body.overlays;
    expect(count).toBe(2);
    expect(overlays[0]).toMatchObject({ text: { content: "First", preset_id: "clutch", font_size: 62 }, meta: { subtitle: true, textStyleId: "clutch" } });
    expect(overlays[1]).toMatchObject({ text: { content: "Second", preset_id: "clutch", font_size: 62 } });
    expect(overlays[2].text).toMatchObject({ content: "TITLE", preset_id: "title" });
    expect(useLiteCutHistoryStore.getState().past).toHaveLength(1);
  });

  it("deletes everything left of the playhead and ripples remaining content to zero", () => {
    setProject({
      tracks: [{ id: "v1", type: "video", clips: [
        clip("gone", { timeline_start: 0, trim_out: 2 }),
        clip("crossing", { timeline_start: 3, trim_out: 6 }),
        clip("later", { timeline_start: 8, trim_out: 10 }),
      ] }],
      overlays: [{ id: "title", timeline_start: 7, duration: 2 }],
    }, null, "v1");
    useLiteCutTimelineStore.setState({ playheadSec: 5 });

    expect(useLiteCutTimelineStore.getState().deleteTimelineSide("left")).toBe(true);
    const next = useLiteCutEditorStore.getState().body;
    expect(next.tracks[0].clips.map((item) => [item.id, item.timeline_start])).toEqual([
      ["crossing", 0],
      ["later", 3],
    ]);
    expect(next.overlays[0].timeline_start).toBe(2);
    expect(useLiteCutTimelineStore.getState().playheadSec).toBe(0);
  });

  it("deletes everything right of the playhead and trims crossing content", () => {
    setProject({
      tracks: [{ id: "v1", type: "video", clips: [
        clip("crossing", { timeline_start: 1, trim_out: 8 }),
        clip("gone", { timeline_start: 8, trim_out: 10 }),
      ] }],
      overlays: [{ id: "title", timeline_start: 3, duration: 5 }],
    }, null, "v1");
    useLiteCutTimelineStore.setState({ playheadSec: 5 });

    expect(useLiteCutTimelineStore.getState().deleteTimelineSide("right")).toBe(true);
    const next = useLiteCutEditorStore.getState().body;
    expect(next.tracks[0].clips).toHaveLength(1);
    expect(next.tracks[0].clips[0]).toMatchObject({ id: "crossing", timeline_start: 1, trim_out: 4 });
    expect(next.overlays[0]).toMatchObject({ id: "title", duration: 2 });
  });

  it("moves legacy alpha MOV overlays from text tracks to a video track", () => {
    setProject({
      tracks: [{ id: "v1", type: "video", label: "V1", clips: [clip("base")] }],
      overlays: [{
        id: "alpha-mov",
        type: "webm",
        timeline_start: 1,
        duration: 2.5,
        asset_path: "C:/assets/title.mov",
        transform: { x: 0.5, y: 0.4, width: 1, height: 1, scale: 1, rotation: 0, opacity: 1 },
        meta: { asset_id: 54, name: "title.mov", kind: "webm", overlay_track_id: "ot1" },
      }],
    }, null, "v1");

    const moved = useLiteCutTimelineStore.getState().migrateAlphaMovOverlaysToVideoTracks([
      { id: 54, name: "title.mov", kind: "video", has_alpha: true, path: "C:/assets/title.mov", duration_sec: 2.5 },
    ]);

    expect(moved).toBe(1);
    const next = useLiteCutEditorStore.getState().body;
    expect(next.overlays).toHaveLength(0);
    const alphaTrack = next.tracks.find((track) => track.name === "透明视频轨");
    expect(alphaTrack?.type).toBe("video");
    expect(alphaTrack?.clips[0]).toMatchObject({ timeline_start: 1, trim_out: 2.5, meta: { asset_id: 54, kind: "video" } });
  });

  it("creates V2 below an occupied V1 for a smart external drop", () => {
    setProject({
      tracks: [
        { id: "v1", type: "video", label: "V1", locked: false, hidden: false, clips: [clip("base", { trim_out: 8 })] },
        { id: "a1", type: "audio", label: "A1", locked: false, hidden: false, clips: [] },
      ],
      overlays: [],
    }, null, "v1");
    useLiteCutTimelineStore.setState({ playheadSec: 9.25 });

    useLiteCutTimelineStore.getState().addMediaAtTime(
      { id: 88, mediaKind: "asset", kind: "video", name: "angle.mp4", path: "C:/angle.mp4", duration_sec: 3 },
      "v1",
      1.5,
      { createNewTrack: true, createBelow: true },
    );

    const videoTracks = useLiteCutEditorStore.getState().body.tracks.filter((track) => track.type === "video");
    expect(videoTracks.map((track) => track.label)).toEqual(["V1", "V2"]);
    expect(videoTracks[1].clips[0]).toMatchObject({ timeline_start: 1.5, meta: { asset_id: 88, kind: "video" } });
    expect(useLiteCutTimelineStore.getState().playheadSec).toBe(9.25);
  });

  it("keeps the playhead fixed when dropping video and audio media", () => {
    setProject({
      tracks: [
        { id: "v1", type: "video", clips: [] },
        { id: "a1", type: "audio", clips: [] },
      ],
      overlays: [],
    }, null, "v1");
    useLiteCutTimelineStore.setState({ playheadSec: 12.5 });

    const store = useLiteCutTimelineStore.getState();
    store.addMediaAtTime(
      { id: 90, mediaKind: "asset", kind: "video", name: "video.mp4", path: "C:/video.mp4", duration_sec: 3 },
      "v1",
      4,
    );
    useLiteCutTimelineStore.getState().addMediaAtTime(
      { id: 91, mediaKind: "asset", kind: "audio", name: "audio.mp3", path: "C:/audio.mp3", duration_sec: 3 },
      "a1",
      7,
    );

    expect(useLiteCutTimelineStore.getState().playheadSec).toBe(12.5);
    const nextBody = useLiteCutEditorStore.getState().body;
    expect(nextBody.tracks.find((track) => track.id === "v1").clips[0].timeline_start).toBe(4);
    expect(nextBody.tracks.find((track) => track.id === "a1").clips[0].timeline_start).toBe(7);
  });

  it("can expand both clip edges again after shortening them", () => {
    setProject({
      tracks: [{ id: "v1", type: "video", clips: [clip("trim-me", { trim_out: 10, meta: { duration_sec: 10 } })] }],
      overlays: [],
    }, "trim-me", "v1");

    let store = useLiteCutTimelineStore.getState();
    store.trimClipRight("trim-me", "v1", 6);
    store.trimClipRight("trim-me", "v1", 9);
    store.trimClipLeft("trim-me", "v1", 2);
    store.trimClipLeft("trim-me", "v1", 0.5);

    const trimmed = useLiteCutEditorStore.getState().body.tracks[0].clips[0];
    expect(trimmed.timeline_start).toBeCloseTo(0.5);
    expect(trimmed.trim_in).toBeCloseTo(0.5);
    expect(trimmed.trim_out).toBeCloseTo(9);
    expect(trimmed.timeline_start + (trimmed.trim_out - trimmed.trim_in)).toBeCloseTo(9);
  });

  it("hides, locks, and removes empty overlay tracks", () => {
    setProject({
      tracks: [{ id: "v1", type: "video", clips: [] }],
      overlay_tracks: [{ id: "ot1", label: "文字轨1" }, { id: "ot2", label: "文字轨2" }],
      overlays: [],
    }, null, "v1");

    const store = useLiteCutTimelineStore.getState();
    store.toggleTrackHidden("ot1");
    store.toggleTrackLocked("ot2");
    expect(useLiteCutEditorStore.getState().body.overlay_tracks).toMatchObject([
      { id: "ot1", hidden: true },
      { id: "ot2", locked: true },
    ]);
    expect(store.canRemoveTrack("ot2")).toBe(false);
    store.toggleTrackLocked("ot2");
    expect(useLiteCutTimelineStore.getState().removeTrack("ot2")).toBe(true);
    expect(useLiteCutEditorStore.getState().body.overlay_tracks.map((track) => track.id)).toEqual(["ot1"]);
  });
});
