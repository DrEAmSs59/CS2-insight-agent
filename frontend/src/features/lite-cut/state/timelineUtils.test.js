/** @vitest-environment node */
import { describe, expect, it } from "vitest";
import {
  clipMaxTimelineEnd,
  clipCanvasFit,
  buildDetachedAudioClip,
  buildAssetClip,
  buildRecordedClip,
  canDetachClipAudio,
  canRemoveTrack,
  canSplitOverlaysAtPlayhead,
  canSplitTrackClipsAtPlayhead,
  canSplitTimelineClipAt,
  canTrimClipEndToPlayhead,
  canTrimClipStartToPlayhead,
  canTrimOverlayToPlayhead,
  canTrimTimelineClip,
  canPlaceOnTrack,
  cloneOverlayForPaste,
  cloneTimelineClipForPaste,
  clipPlaybackSpeed,
  clipMediaTimelineDuration,
  clipSourceTimeForTimeline,
  clipTimelineTimeForSource,
  clipSpeedSegments,
  clipSourceDuration,
  clipTrimmedSourceDuration,
  clipTimelineEnd,
  compactTrackGaps,
  insertAudioTrack,
  insertClipIntoTrackWithRipple,
  insertOverlayWithRipple,
  insertVideoTrack,
  isMainFileVideoClip,
  linkedTimelineClipIds,
  resolveAudioEditingTarget,
  mainVideoClips,
  markerNearTime,
  nextEditPoint,
  nextMarker,
  nudgeClipInTrack,
  slipClipInTrack,
  nudgeOverlayInList,
  overlayTimelineEnd,
  parseSubtitleText,
  parseSubtitleTimecode,
  previousEditPoint,
  previousMarker,
  projectFrameStepSec,
  resizeOverlayDraft,
  rebaseTimelineClipKeyframes,
  removeTrackById,
  rippleDeleteClipFromTrack,
  rippleDeleteOverlayFromList,
  buildSubtitleOverlays,
  snapTimelineSec,
  splitOverlayAt,
  splitOverlaysAtPlayhead,
  splitClipAt,
  splitTrackClipsAtPlayhead,
  timelineTotalSec,
  timelineEditPoints,
  sortedMarkers,
  selectedTimelineRange,
  trimClipEndDraft,
  trimClipStartDraft,
  visibleVideoTracks,
} from "./timelineUtils.js";

describe("timelineUtils", () => {
  it("treats common uploaded video containers as main-track clips", () => {
    for (const filePath of ["C:/assets/capture.mkv", "C:/assets/capture.m4v", "C:/assets/legacy.avi"]) {
      expect(isMainFileVideoClip({ source_type: "file", file_path: filePath })).toBe(true);
    }
  });

  it("computes clip duration from trim", () => {
    const clip = { trim_in: 0, trim_out: 12.5 };
    expect(clipSourceDuration(clip)).toBe(12.5);
  });

  it("computes timeline duration from playback speed", () => {
    const clip = { trim_in: 0, trim_out: 12, speed: 2 };
    expect(clipPlaybackSpeed(clip)).toBe(2);
    expect(clipTrimmedSourceDuration(clip)).toBe(12);
    expect(clipSourceDuration(clip)).toBe(6);
  });

  it("maps piecewise speed ramps between source and timeline time", () => {
    const clip = {
      trim_in: 2,
      trim_out: 12,
      speed: 1,
      speed_keyframes: [
        { source_sec: 2, speed: 0.5 },
        { source_sec: 6, speed: 2 },
        { source_sec: 12, speed: 2 },
      ],
    };
    expect(clipSpeedSegments(clip)).toEqual([
      { sourceStart: 2, sourceEnd: 6, speed: 0.5 },
      { sourceStart: 6, sourceEnd: 12, speed: 2 },
    ]);
    expect(clipMediaTimelineDuration(clip)).toBe(11);
    expect(clipSourceTimeForTimeline(clip, 7)).toBeCloseTo(5.5);
    expect(clipSourceTimeForTimeline(clip, 9)).toBeCloseTo(8);
    expect(clipTimelineTimeForSource(clip, 8)).toBeCloseTo(9);
  });

  it("splits a speed ramp at the matching source frame", () => {
    const clip = {
      id: "ramp",
      timeline_start: 4,
      trim_in: 0,
      trim_out: 10,
      speed_keyframes: [{ source_sec: 0, speed: 0.5 }, { source_sec: 5, speed: 2 }, { source_sec: 10, speed: 2 }],
    };
    const [left, right] = splitClipAt(clip, 10.25);
    expect(left.trim_out).toBeCloseTo(5.5);
    expect(right.trim_in).toBeCloseTo(5.5);
    expect(left.speed_keyframes).toHaveLength(3);
    expect(right.speed_keyframes).toHaveLength(3);
  });

  it("extends a clip timeline with a final-frame hold without consuming source media", () => {
    const clip = { trim_in: 0, trim_out: 8, speed: 2, freeze_frame_sec: 1.5 };
    expect(clipMediaTimelineDuration(clip)).toBe(4);
    expect(clipSourceDuration(clip)).toBe(5.5);
    expect(clipMaxTimelineEnd({ ...clip, timeline_start: 2 })).toBe(7.5);
    expect(trimClipEndDraft({ ...clip, timeline_start: 2 }, 6)).toMatchObject({ freeze_frame_sec: 0, trim_out: 8 });
    expect(trimClipEndDraft({ ...clip, timeline_start: 2 }, 6.8)).toMatchObject({ freeze_frame_sec: 0.8, trim_out: 8 });
  });

  it("restores source media after trimming either edge shorter", () => {
    const source = { timeline_start: 0, trim_in: 0, trim_out: 10, meta: { duration_sec: 10 }, speed: 1 };
    const rightShort = trimClipEndDraft(source, 6);
    expect(rightShort.trim_out).toBeCloseTo(6);
    expect(trimClipEndDraft(rightShort, 9).trim_out).toBeCloseTo(9);

    const leftShort = trimClipStartDraft(source, 2);
    expect(leftShort).toMatchObject({ timeline_start: 2, trim_in: 2 });
    expect(trimClipStartDraft(leftShort, 0.5)).toMatchObject({ timeline_start: 0.5, trim_in: 0.5 });
  });

  it("bounds playback speed to the export-supported range", () => {
    expect(clipPlaybackSpeed({ speed: 12 })).toBe(4);
    expect(clipPlaybackSpeed({ speed: 0.01 })).toBe(0.25);
  });

  it("initializes clip audio controls", () => {
    const recorded = buildRecordedClip({ id: 1, duration: 10, _raw: { duration_sec: 10 } }, 0);
    const audio = buildAssetClip({ id: 2, kind: "audio", name: "beat.mp3", path: "C:/x/beat.mp3", duration_sec: 12 }, 1);
    expect(recorded.volume).toBe(1);
    expect(recorded.muted).toBe(false);
    expect(recorded.canvas_fit).toBe(null);
    expect(recorded.preserve_pitch).toBe(true);
    expect(recorded.reverse).toBe(false);
    expect(audio.volume).toBe(1);
    expect(audio.muted).toBe(false);
    expect(audio.canvas_fit).toBe(null);
    expect(audio.preserve_pitch).toBe(true);
    expect(audio.reverse).toBe(false);
    expect(audio.fade_in_sec).toBe(0);
    expect(audio.fade_out_sec).toBe(0);
  });

  it("keeps audio automation continuous when splitting and trimming", () => {
    const original = {
      id: "audio",
      timeline_start: 2,
      trim_in: 0,
      trim_out: 6,
      volume: 1,
      audio_keyframes: [{ time_sec: 0, volume: 0.2 }, { time_sec: 3, volume: 1.2 }, { time_sec: 6, volume: 0.4 }],
    };
    const [left, right] = splitClipAt(original, 3);
    expect(left.audio_keyframes.at(-1)).toMatchObject({ time_sec: 3, volume: 1.2 });
    expect(right.audio_keyframes[0]).toMatchObject({ time_sec: 0, volume: 1.2 });
    const trimmed = rebaseTimelineClipKeyframes(original, { ...original, timeline_start: 3, trim_in: 1 });
    expect(trimmed.audio_keyframes[0]).toMatchObject({ time_sec: 0, volume: expect.closeTo(0.533333, 4) });
  });

  it("resolves clip canvas fit from override or project fallback", () => {
    expect(clipCanvasFit({ canvas_fit: "cover" }, "contain")).toBe("cover");
    expect(clipCanvasFit({ canvas_fit: "blur" }, "cover")).toBe("blur");
    expect(clipCanvasFit({ canvas_fit: null }, "cover")).toBe("cover");
    expect(clipCanvasFit({ canvas_fit: "bad" }, "bad")).toBe("contain");
  });

  it("detaches uploaded video audio as an editable audio clip", () => {
    const video = buildAssetClip({ id: 2, kind: "video", name: "angle.mp4", path: "C:/x/angle.mp4", duration_sec: 12 }, 4);
    video.trim_in = 2;
    video.trim_out = 10;
    video.speed = 2;
    video.preserve_pitch = false;
    video.reverse = true;
    video.volume = 0.75;
    expect(canDetachClipAudio(video, "video")).toBe(true);
    const audio = buildDetachedAudioClip(video);
    expect(audio).toMatchObject({
      source_type: "file",
      file_path: "C:/x/angle.mp4",
      timeline_start: 4,
      trim_in: 2,
      trim_out: 10,
      speed: 2,
      preserve_pitch: false,
      reverse: true,
      volume: 0.75,
      muted: false,
      meta: { kind: "audio", source_clip_id: video.id, detached_from_video: true },
    });
    expect(clipSourceDuration(audio)).toBe(4);
  });

  it("allows detaching recorded clip audio when the recording path is known", () => {
    const recorded = buildRecordedClip(
      { id: 1, duration: 8, _raw: { duration_sec: 8, output_path: "C:/recordings/ace.mp4", player_name: "me" } },
      1,
    );
    expect(canDetachClipAudio(recorded, "video")).toBe(true);
    const detached = buildDetachedAudioClip(recorded);
    expect(detached?.file_path).toBe("C:/recordings/ace.mp4");
    expect(detached?.source_id).toBe(1);
    expect(canDetachClipAudio({ ...recorded, meta: { duration_sec: 8 } }, "video")).toBe(false);
  });

  it("finds a video clip and its detached audio counterpart", () => {
    const body = {
      tracks: [
        { id: "v1", type: "video", clips: [{ id: "video", meta: {} }] },
        { id: "a1", type: "audio", clips: [{ id: "audio", meta: { source_clip_id: "video", detached_from_video: true } }] },
      ],
    };
    expect(linkedTimelineClipIds(body, "video")).toEqual(["video", "audio"]);
    expect(linkedTimelineClipIds(body, "audio")).toEqual(["video", "audio"]);
  });

  it("always resolves linked audio controls to the detached A-track clip", () => {
    const body = {
      tracks: [
        { id: "v1", type: "video", clips: [{ id: 101, muted: true, meta: { linked_audio_clip_id: 202 } }] },
        { id: "a1", type: "audio", clips: [{ id: 202, muted: false, meta: { source_clip_id: 101, detached_from_video: true } }] },
      ],
    };

    expect(resolveAudioEditingTarget(body, "101", "v1")).toMatchObject({ trackId: "a1", clip: { id: 202 } });
    expect(resolveAudioEditingTarget(body, "202", "a1")).toMatchObject({ trackId: "a1", clip: { id: 202 } });
  });

  it("allows trimming recorded, uploaded video, and audio timeline clips", () => {
    const recorded = buildRecordedClip({ id: 1, duration: 10, _raw: { duration_sec: 10 } }, 0);
    const uploaded = buildAssetClip({ id: 2, kind: "video", name: "angle.mp4", path: "C:/x/angle.mp4", duration_sec: 12 }, 1);
    const audio = buildAssetClip({ id: 3, kind: "audio", name: "beat.mp3", path: "C:/x/beat.mp3", duration_sec: 8 }, 2);
    expect(canTrimTimelineClip(recorded, "video")).toBe(true);
    expect(canTrimTimelineClip(uploaded, "video")).toBe(true);
    expect(canTrimTimelineClip(audio, "audio")).toBe(true);
  });

  it("allows trim-to-playhead only inside a timeline clip", () => {
    const clip = buildRecordedClip({ id: 1, duration: 10, _raw: { duration_sec: 10 } }, 2);
    expect(canTrimClipStartToPlayhead(clip, "video", 6)).toBe(true);
    expect(canTrimClipEndToPlayhead(clip, "video", 6)).toBe(true);
    expect(canTrimClipStartToPlayhead(clip, "video", 2)).toBe(false);
    expect(canTrimClipEndToPlayhead(clip, "video", 12)).toBe(false);
  });

  it("rejects trim-to-playhead for non-video file clips on video tracks", () => {
    const clip = {
      id: "sticker",
      source_type: "file",
      file_path: "C:/x/sticker.png",
      timeline_start: 0,
      trim_in: 0,
      trim_out: 3,
      meta: { kind: "image" },
    };
    expect(canTrimClipStartToPlayhead(clip, "video", 1)).toBe(false);
    expect(canTrimClipEndToPlayhead(clip, "video", 1)).toBe(false);
  });

  it("allows trim-to-playhead for overlays only inside the overlay span", () => {
    const overlay = { id: "ov", timeline_start: 4, duration: 5 };
    expect(canTrimOverlayToPlayhead(overlay, "start", 6)).toBe(true);
    expect(canTrimOverlayToPlayhead(overlay, "end", 6)).toBe(true);
    expect(canTrimOverlayToPlayhead(overlay, "start", 4)).toBe(false);
    expect(canTrimOverlayToPlayhead(overlay, "end", 9)).toBe(false);
  });

  it("does not show main clip trim handles for non-video file overlays on video tracks", () => {
    expect(
      canTrimTimelineClip(
        {
          id: "sticker",
          source_type: "file",
          file_path: "C:/x/sticker.png",
          meta: { kind: "image" },
        },
        "video",
      ),
    ).toBe(false);
  });

  it("prevents overlapping placement", () => {
    const clips = [{ id: "a", timeline_start: 0, trim_in: 0, trim_out: 10 }];
    expect(canPlaceOnTrack(clips, 5, 5)).toBe(false);
    expect(canPlaceOnTrack(clips, 10, 5)).toBe(true);
  });

  it("compacts gaps on a track using timeline durations", () => {
    const result = compactTrackGaps({
      clips: [
        { id: "a", timeline_start: 5, trim_in: 0, trim_out: 4 },
        { id: "b", timeline_start: 12, trim_in: 0, trim_out: 8, speed: 2 },
        { id: "c", timeline_start: 30, trim_in: 0, trim_out: 2 },
      ],
    });
    expect(result.changed).toBe(true);
    expect(result.clips.map((c) => [c.id, c.timeline_start])).toEqual([
      ["a", 0],
      ["b", 4],
      ["c", 8],
    ]);
  });

  it("does not mark an already compact track as changed", () => {
    const result = compactTrackGaps({
      clips: [
        { id: "a", timeline_start: 0, trim_in: 0, trim_out: 4 },
        { id: "b", timeline_start: 4, trim_in: 0, trim_out: 2 },
      ],
    });
    expect(result.changed).toBe(false);
    expect(result.clips.map((c) => c.timeline_start)).toEqual([0, 4]);
  });

  it("split produces two clips", () => {
    const clip = {
      id: "x",
      timeline_start: 0,
      trim_in: 0,
      trim_out: 10,
      transition_out: { type: "fade", duration_sec: 0.4 },
    };
    const [left, right] = splitClipAt(clip, 4);
    expect(clipSourceDuration(left)).toBe(4);
    expect(right.timeline_start).toBe(4);
    expect(right.transition_out?.type).toBe("fade");
  });

  it("keeps video layer keyframe continuity when splitting", () => {
    const clip = {
      id: "layer", timeline_start: 4, trim_in: 0, trim_out: 4,
      transform: { x: 0, y: 0.5, width: 1, scale: 1 },
      keyframes: [
        { time_sec: 0, transform: { x: 0, y: 0.5, width: 1, scale: 1 } },
        { time_sec: 4, transform: { x: 1, y: 0.5, width: 1, scale: 1 } },
      ],
    };
    const [left, right] = splitClipAt(clip, 2);
    expect(left.keyframes.at(-1)).toMatchObject({ time_sec: 2, transform: { x: 0.5 } });
    expect(right.keyframes[0]).toMatchObject({ time_sec: 0, transform: { x: 0.5 } });
    expect(right.keyframes.at(-1)).toMatchObject({ time_sec: 2, transform: { x: 1 } });
  });

  it("keeps a final-frame hold on the right side of a split", () => {
    const clip = { id: "hold", timeline_start: 0, trim_in: 0, trim_out: 6, freeze_frame_sec: 2 };
    const [left, right] = splitClipAt(clip, 3);
    expect(left.freeze_frame_sec).toBe(0);
    expect(right.freeze_frame_sec).toBe(2);
    expect(canSplitTimelineClipAt(clip, 6.5)).toBe(false);
  });

  it("rebases video layer keyframes at trim boundaries", () => {
    const original = {
      id: "layer", timeline_start: 1, trim_in: 0, trim_out: 6,
      transform: { x: 0, y: 0.5, width: 1, scale: 1 },
      keyframes: [
        { time_sec: 0, transform: { x: 0, y: 0.5, width: 1, scale: 1 } },
        { time_sec: 6, transform: { x: 1, y: 0.5, width: 1, scale: 1 } },
      ],
    };
    const leftTrimmed = rebaseTimelineClipKeyframes(original, { ...original, timeline_start: 3, trim_in: 2 });
    expect(leftTrimmed.keyframes[0]).toMatchObject({ time_sec: 0, transform: { x: 1 / 3 } });
    const rightTrimmed = rebaseTimelineClipKeyframes(original, { ...original, trim_out: 3 });
    expect(rightTrimmed.keyframes.at(-1)).toMatchObject({ time_sec: 3, transform: { x: 0.5 } });
  });

  it("split maps timeline time back to source time for sped-up clips", () => {
    const clip = {
      id: "x",
      timeline_start: 0,
      trim_in: 0,
      trim_out: 10,
      speed: 2,
      transition_out: { type: "fade", duration_sec: 0.4 },
    };
    const [left, right] = splitClipAt(clip, 2);
    expect(left.trim_out).toBe(4);
    expect(right.timeline_start).toBe(2);
    expect(right.trim_in).toBe(4);
    expect(clipSourceDuration(left)).toBe(2);
  });

  it("splits every unlocked track clip crossing the playhead", () => {
    const track = {
      id: "v1",
      locked: false,
      hidden: false,
      clips: [
        { id: "a", timeline_start: 0, trim_in: 0, trim_out: 10 },
        { id: "b", timeline_start: 12, trim_in: 0, trim_out: 4 },
      ],
    };
    expect(canSplitTrackClipsAtPlayhead(track, 4)).toBe(true);
    const result = splitTrackClipsAtPlayhead(track, 4);
    expect(result.changed).toBe(true);
    expect(result.newIds).toHaveLength(1);
    expect(result.clips).toHaveLength(3);
    expect(result.clips.map((c) => c.timeline_start)).toEqual([0, 4, 12]);
    expect(result.clips[0].trim_out).toBe(4);
    expect(result.clips[1].trim_in).toBe(4);
    expect(result.clips[2].id).toBe("b");
  });

  it("does not split locked or hidden tracks", () => {
    const clips = [{ id: "a", timeline_start: 0, trim_in: 0, trim_out: 10 }];
    expect(canSplitTrackClipsAtPlayhead({ locked: true, hidden: false, clips }, 4)).toBe(false);
    expect(canSplitTrackClipsAtPlayhead({ locked: false, hidden: true, clips }, 4)).toBe(false);
    expect(splitTrackClipsAtPlayhead({ locked: true, hidden: false, clips }, 4)).toMatchObject({
      changed: false,
      clips,
      newIds: [],
    });
  });

  it("splits overlays crossing the playhead", () => {
    const overlays = [
      { id: "ov-a", type: "sticker", timeline_start: 2, duration: 6 },
      { id: "ov-b", type: "text", timeline_start: 10, duration: 2 },
    ];
    expect(canSplitOverlaysAtPlayhead(overlays, 5)).toBe(true);
    const result = splitOverlaysAtPlayhead(overlays, 5);
    expect(result.changed).toBe(true);
    expect(result.newIds).toHaveLength(1);
    expect(result.overlays).toHaveLength(3);
    expect(result.overlays.map((o) => o.timeline_start)).toEqual([2, 5, 10]);
    expect(result.overlays[0].duration).toBe(3);
    expect(result.overlays[1].duration).toBe(3);
    expect(result.overlays[2].id).toBe("ov-b");
  });

  it("clones timeline clips for paste with a fresh id and target start", () => {
    const clip = {
      id: "source",
      source_type: "file",
      file_path: "C:/x/clip.mp4",
      timeline_start: 2,
      trim_in: 1,
      trim_out: 7,
      speed: 1.5,
      meta: { kind: "video", asset_id: 9 },
    };
    const pasted = cloneTimelineClipForPaste(clip, 12);
    expect(pasted.id).not.toBe("source");
    expect(pasted).toMatchObject({
      source_type: "file",
      file_path: "C:/x/clip.mp4",
      timeline_start: 12,
      trim_in: 1,
      trim_out: 7,
      speed: 1.5,
      meta: { kind: "video", asset_id: 9 },
    });
  });

  it("clones overlays for paste with a fresh id and preserved styling", () => {
    const overlay = {
      id: "ov-source",
      type: "text",
      timeline_start: 3,
      duration: 2,
      transform: { x: 0.5, y: 0.2, width: 0.6 },
      text: { content: "ACE", preset_id: "clutch" },
    };
    const pasted = cloneOverlayForPaste(overlay, 9);
    expect(pasted.id).not.toBe("ov-source");
    expect(pasted).toMatchObject({
      type: "text",
      timeline_start: 9,
      duration: 2,
      transform: { x: 0.5, y: 0.2, width: 0.6 },
      text: { content: "ACE", preset_id: "clutch" },
    });
  });

  it("inserts a pasted clip with ripple space on the same track", () => {
    const clip = { id: "paste", timeline_start: 4, trim_in: 0, trim_out: 3 };
    const result = insertClipIntoTrackWithRipple(
      {
        clips: [
          { id: "a", timeline_start: 0, trim_in: 0, trim_out: 2 },
          { id: "b", timeline_start: 5, trim_in: 0, trim_out: 2 },
        ],
      },
      clip,
    );
    expect(result.inserted).toBe(true);
    expect(result.clips.map((c) => [c.id, c.timeline_start])).toEqual([
      ["a", 0],
      ["paste", 4],
      ["b", 8],
    ]);
  });

  it("does not insert ripple paste inside an existing clip span", () => {
    const result = insertClipIntoTrackWithRipple(
      {
        clips: [{ id: "a", timeline_start: 0, trim_in: 0, trim_out: 8 }],
      },
      { id: "paste", timeline_start: 4, trim_in: 0, trim_out: 2 },
    );
    expect(result.inserted).toBe(false);
    expect(result.clips).toHaveLength(1);
  });

  it("inserts overlays with ripple timing", () => {
    const result = insertOverlayWithRipple(
      [
        { id: "a", timeline_start: 0, duration: 2 },
        { id: "b", timeline_start: 5, duration: 2 },
      ],
      { id: "paste", timeline_start: 3, duration: 4 },
    );
    expect(result.inserted).toBe(true);
    expect(result.overlays.map((o) => [o.id, o.timeline_start])).toEqual([
      ["a", 0],
      ["paste", 3],
      ["b", 9],
    ]);
  });

  it("ripple deletes a clip and closes later same-track content", () => {
    const track = {
      id: "v1",
      clips: [
        { id: "a", timeline_start: 0, trim_in: 0, trim_out: 4 },
        { id: "b", timeline_start: 6, trim_in: 0, trim_out: 3 },
        { id: "c", timeline_start: 12, trim_in: 0, trim_out: 2 },
      ],
    };
    const result = rippleDeleteClipFromTrack(track, "b");
    expect(result.deleted).toBe(true);
    expect(result.duration).toBe(3);
    expect(result.clips.map((c) => [c.id, c.timeline_start])).toEqual([
      ["a", 0],
      ["c", 9],
    ]);
  });

  it("ripple delete leaves clips overlapping the removed span in place", () => {
    const track = {
      clips: [
        { id: "a", timeline_start: 0, trim_in: 0, trim_out: 8 },
        { id: "b", timeline_start: 6, trim_in: 0, trim_out: 3 },
        { id: "c", timeline_start: 12, trim_in: 0, trim_out: 2 },
      ],
    };
    const result = rippleDeleteClipFromTrack(track, "b");
    expect(result.clips.map((c) => [c.id, c.timeline_start])).toEqual([
      ["a", 0],
      ["c", 9],
    ]);
  });

  it("ripple deletes overlays and closes later overlay timing", () => {
    const result = rippleDeleteOverlayFromList(
      [
        { id: "a", timeline_start: 0, duration: 2 },
        { id: "b", timeline_start: 4, duration: 3 },
        { id: "c", timeline_start: 10, duration: 2 },
      ],
      "b",
    );
    expect(result.deleted).toBe(true);
    expect(result.overlays.map((o) => [o.id, o.timeline_start])).toEqual([
      ["a", 0],
      ["c", 7],
    ]);
  });

  it("caps right trim at source media duration", () => {
    const clip = buildRecordedClip({ id: 1, duration: 10, _raw: { duration_sec: 10 } }, 0);
    expect(clipMaxTimelineEnd(clip)).toBe(10);
    clip.trim_in = 2;
    clip.timeline_start = 0;
    clip.trim_out = 8;
    expect(clipMaxTimelineEnd(clip)).toBe(8);
  });

  it("does not grow source duration when trim_out is extended", () => {
    const clip = buildRecordedClip({ id: 1, duration: 10, _raw: { duration_sec: 10 } }, 0);
    clip.trim_out = 99;
    expect(clipMaxTimelineEnd(clip)).toBe(10);
  });

  it("timeline total from tracks", () => {
    const body = {
      tracks: [
        {
          id: "v1",
          clips: [buildRecordedClip({ id: 1, duration: 8, _raw: {} }, 0)],
        },
      ],
    };
    expect(timelineTotalSec(body)).toBeGreaterThanOrEqual(8);
    expect(clipTimelineEnd(body.tracks[0].clips[0])).toBe(8);
  });

  it("extends timeline total to include markers beyond media", () => {
    expect(timelineTotalSec({ markers: [{ id: "m", time_sec: 42 }] }, 30)).toBe(42);
  });

  it("computes selected timeline range across clips and overlays", () => {
    const body = {
      tracks: [
        {
          id: "v1",
          clips: [
            { id: "a", timeline_start: 2, trim_in: 0, trim_out: 3 },
            { id: "b", timeline_start: 9, trim_in: 0, trim_out: 2 },
          ],
        },
      ],
      overlays: [{ id: "title", timeline_start: 6, duration: 4 }],
    };

    expect(selectedTimelineRange(body, ["a", "title"])).toEqual({ startSec: 2, endSec: 10 });
    expect(selectedTimelineRange(body, ["missing"])).toBeNull();
  });

  it("snaps timeline motion to nearby markers", () => {
    const body = {
      markers: [{ id: "beat", time_sec: 12 }],
      tracks: [{ id: "v1", clips: [{ id: "a", timeline_start: 0, trim_in: 0, trim_out: 5 }] }],
    };
    expect(snapTimelineSec(12.08, body, { enabled: true })).toBe(12);
    expect(snapTimelineSec(12.2, body, { enabled: true })).toBe(12.2);
    expect(snapTimelineSec(12.08, body, { enabled: false })).toBe(12.08);
  });

  it("snaps and navigates through video and overlay keyframes", () => {
    const body = {
      tracks: [{ id: "v2", clips: [{ id: "layer", timeline_start: 2, trim_in: 0, trim_out: 6, keyframes: [{ time_sec: 1.5 }], audio_keyframes: [{ time_sec: 2.2, volume: 0.4 }] }] }],
      overlays: [{ id: "ov", timeline_start: 7, duration: 3, keyframes: [{ time_sec: 0.8 }] }],
    };
    expect(snapTimelineSec(3.56, body, { enabled: true })).toBe(3.5);
    expect(snapTimelineSec(4.18, body, { enabled: true })).toBe(4.2);
    expect(snapTimelineSec(7.76, body, { enabled: true })).toBe(7.8);
    expect(timelineEditPoints(body)).toEqual([0, 2, 3.5, 4.2, 7, 7.8, 8, 10]);
  });

  it("collects visible timeline edit points from tracks and overlays", () => {
    const body = {
      tracks: [
        { id: "v1", type: "video", clips: [{ id: "a", timeline_start: 2, trim_in: 0, trim_out: 3 }] },
        { id: "v2", type: "video", hidden: true, clips: [{ id: "hidden", timeline_start: 20, trim_in: 0, trim_out: 2 }] },
      ],
      overlays: [{ id: "ov", timeline_start: 7, duration: 2 }],
    };
    expect(timelineEditPoints(body)).toEqual([0, 2, 5, 7, 9]);
  });

  it("finds previous and next edit points around the playhead", () => {
    const body = {
      tracks: [
        {
          id: "v1",
          type: "video",
          clips: [
            { id: "a", timeline_start: 0, trim_in: 0, trim_out: 4 },
            { id: "b", timeline_start: 6, trim_in: 0, trim_out: 2 },
          ],
        },
      ],
      overlays: [{ id: "ov", timeline_start: 9, duration: 1 }],
    };
    expect(previousEditPoint(body, 6)).toBe(4);
    expect(nextEditPoint(body, 6)).toBe(8);
    expect(previousEditPoint(body, 0)).toBe(null);
    expect(nextEditPoint(body, 10)).toBe(null);
  });

  it("computes project frame step from output fps", () => {
    expect(projectFrameStepSec({ output: { fps: 60 } })).toBeCloseTo(1 / 60);
    expect(projectFrameStepSec({ output: { fps: 0 } })).toBeCloseTo(1 / 30);
  });

  it("sorts markers and normalizes invalid marker fields", () => {
    expect(
      sortedMarkers({
        markers: [
          { id: "b", time_sec: 5, color: "bad" },
          { id: "a", time_sec: 1, label: "beat", color: "#00ffaa" },
        ],
      }),
    ).toEqual([
      { id: "a", time_sec: 1, label: "beat", color: "#00ffaa" },
      { id: "b", time_sec: 5, label: "", color: "#f59e0b" },
    ]);
  });

  it("finds nearby, previous, and next markers", () => {
    const body = { markers: [{ id: "a", time_sec: 1 }, { id: "b", time_sec: 3 }, { id: "c", time_sec: 8 }] };
    expect(markerNearTime(body, 3.1)?.id).toBe("b");
    expect(markerNearTime(body, 3.4)).toBe(null);
    expect(previousMarker(body, 3)?.id).toBe("a");
    expect(nextMarker(body, 3)?.id).toBe("c");
  });

  it("nudges a clip on its track without overlapping neighbors", () => {
    const track = {
      clips: [
        { id: "a", timeline_start: 0, trim_in: 0, trim_out: 3 },
        { id: "b", timeline_start: 5, trim_in: 0, trim_out: 2 },
      ],
    };
    const moved = nudgeClipInTrack(track, "b", -1);
    expect(moved.moved).toBe(true);
    expect(moved.clips.find((c) => c.id === "b").timeline_start).toBe(4);
    const blocked = nudgeClipInTrack(track, "b", -3);
    expect(blocked.moved).toBe(false);
  });

  it("slips a trimmed clip within its source without changing its timeline span", () => {
    const track = {
      clips: [
        {
          id: "clip",
          timeline_start: 4,
          trim_in: 2,
          trim_out: 6,
          speed: 2,
          meta: { duration_sec: 10 },
        },
      ],
    };
    const slipped = slipClipInTrack(track, "clip", 0.5);
    const next = slipped.clips[0];
    expect(slipped.moved).toBe(true);
    expect(next.timeline_start).toBe(4);
    expect(next.trim_in).toBe(3);
    expect(next.trim_out).toBe(7);
    expect(clipSourceDuration(next)).toBe(2);

    const atSourceEnd = slipClipInTrack({ clips: [next] }, "clip", 10);
    expect(atSourceEnd.clips[0]).toMatchObject({ trim_in: 6, trim_out: 10 });
    expect(slipClipInTrack({ clips: atSourceEnd.clips }, "clip", 1).moved).toBe(false);
  });

  it("nudges overlays and clamps at zero", () => {
    const moved = nudgeOverlayInList([{ id: "ov", timeline_start: 3, duration: 1 }], "ov", -1);
    expect(moved.moved).toBe(true);
    expect(moved.overlays[0].timeline_start).toBe(2);
    const blocked = nudgeOverlayInList([{ id: "ov", timeline_start: 0, duration: 1 }], "ov", -1);
    expect(blocked.moved).toBe(false);
  });

  it("uses the first visible video track with media as exportable main clips", () => {
    const body = {
      tracks: [
        { id: "v1", type: "video", clips: [] },
        {
          id: "v2",
          type: "video",
          clips: [{ id: "base", source_type: "recorded_clip", source_id: 10, timeline_start: 2, trim_out: 5 }],
        },
        {
          id: "v3",
          type: "video",
          clips: [{ id: "top", source_type: "recorded_clip", source_id: 11, timeline_start: 0, trim_out: 3 }],
        },
      ],
    };
    expect(mainVideoClips(body).map((c) => c.id)).toEqual(["base"]);
  });

  it("inserts and labels video and audio tracks", () => {
    const body = {
      tracks: [
        { id: "v1", type: "video", clips: [] },
        { id: "a1", type: "audio", label: "A1", clips: [] },
      ],
    };
    const videoId = insertVideoTrack(body, "v1");
    const audioId = insertAudioTrack(body, "a1");
    expect(videoId).toMatch(/^v-/);
    expect(audioId).toMatch(/^a-/);
    expect(body.tracks.filter((t) => t.type === "video").map((t) => t.label)).toEqual(["V1", "V2"]);
    expect(body.tracks.filter((t) => t.type === "audio").map((t) => t.label)).toEqual(["A1", "A2"]);
    expect(visibleVideoTracks(body).map((t) => t.label)).toEqual(["V1", "V2"]);
  });

  it("removes only empty non-final media tracks", () => {
    const body = {
      tracks: [
        { id: "v1", type: "video", label: "V1", clips: [{ id: "clip", timeline_start: 0, trim_out: 3 }] },
        { id: "v2", type: "video", label: "V2", clips: [] },
        { id: "a1", type: "audio", label: "A1", clips: [] },
        { id: "a2", type: "audio", label: "A2", clips: [] },
      ],
    };
    expect(canRemoveTrack(body, "v1")).toBe(false);
    expect(canRemoveTrack(body, "v2")).toBe(true);
    expect(removeTrackById(body, "v2")).toBe(true);
    expect(body.tracks.filter((t) => t.type === "video").map((t) => t.label)).toEqual(["V1"]);
    expect(canRemoveTrack(body, "a2")).toBe(true);
    expect(removeTrackById(body, "a2")).toBe(true);
    expect(canRemoveTrack(body, "a1")).toBe(false);
  });

  it("splits text overlays by visible duration", () => {
    const overlay = { id: "ov1", type: "text", timeline_start: 2, duration: 5, text: { content: "ACE" } };
    const [left, right] = splitOverlayAt(overlay, 2);
    expect(left.id).toBe("ov1");
    expect(left.duration).toBe(2);
    expect(right.id).not.toBe("ov1");
    expect(right.timeline_start).toBe(4);
    expect(right.duration).toBe(3);
    expect(overlayTimelineEnd(right)).toBe(7);
  });

  it("preserves animated overlay continuity when splitting", () => {
    const overlay = {
      id: "animated", type: "text", timeline_start: 4, duration: 4,
      transform: { x: 0, y: 0.5, scale: 1 },
      keyframes: [
        { time_sec: 0, transform: { x: 0, y: 0.5, scale: 1 } },
        { time_sec: 4, transform: { x: 1, y: 0.5, scale: 1 } },
      ],
    };
    const [left, right] = splitOverlayAt(overlay, 2);
    expect(left.keyframes.at(-1)).toMatchObject({ time_sec: 2, transform: { x: 0.5 } });
    expect(right.keyframes[0]).toMatchObject({ time_sec: 0, transform: { x: 0.5 } });
    expect(right.keyframes.at(-1)).toMatchObject({ time_sec: 2, transform: { x: 1 } });
  });

  it("splits video overlays by advancing trim_in", () => {
    const overlay = {
      id: "ov-webm",
      type: "webm",
      timeline_start: 1,
      duration: 6,
      trim_in: 3,
      meta: { kind: "webm", duration_sec: 20 },
    };
    const [left, right] = splitOverlayAt(overlay, 2.5);
    expect(left.duration).toBe(2.5);
    expect(right.timeline_start).toBe(3.5);
    expect(right.duration).toBe(3.5);
    expect(right.trim_in).toBe(5.5);
  });

  it("left-trims video overlays by advancing trim_in", () => {
    const overlay = {
      id: "ov-webm",
      type: "webm",
      timeline_start: 1,
      duration: 6,
      trim_in: 3,
      meta: { kind: "webm", duration_sec: 20 },
    };
    const next = resizeOverlayDraft(overlay, { start: 3, duration: 4 });
    expect(next.timeline_start).toBe(3);
    expect(next.trim_in).toBe(5);
    expect(next.duration).toBe(4);
  });

  it("rebases overlay keyframes when trimming the left edge", () => {
    const overlay = {
      id: "animated", type: "text", timeline_start: 1, duration: 6,
      transform: { x: 0, y: 0.5, scale: 1 },
      keyframes: [
        { time_sec: 0, transform: { x: 0, y: 0.5, scale: 1 } },
        { time_sec: 6, transform: { x: 1, y: 0.5, scale: 1 } },
      ],
    };
    const next = resizeOverlayDraft(overlay, { start: 3, duration: 4 });
    expect(next.keyframes[0]).toMatchObject({ time_sec: 0, transform: { x: 1 / 3 } });
    expect(next.keyframes.at(-1)).toMatchObject({ time_sec: 4, transform: { x: 1 } });
  });

  it("keeps the interpolated end state when right-trimming an animated overlay", () => {
    const overlay = {
      id: "animated", type: "text", timeline_start: 1, duration: 6,
      transform: { x: 0, y: 0.5, scale: 1 },
      keyframes: [
        { time_sec: 0, transform: { x: 0, y: 0.5, scale: 1 } },
        { time_sec: 6, transform: { x: 1, y: 0.5, scale: 1 } },
      ],
    };
    const next = resizeOverlayDraft(overlay, { duration: 3 });
    expect(next.keyframes.at(-1)).toMatchObject({ time_sec: 3, transform: { x: 0.5 } });
  });

  it("does not left-trim video overlays before source start", () => {
    const overlay = {
      id: "ov-webm",
      type: "webm",
      timeline_start: 3,
      duration: 4,
      trim_in: 2,
      meta: { kind: "webm", duration_sec: 20 },
    };
    const next = resizeOverlayDraft(overlay, { start: 0, duration: 7 });
    expect(next.timeline_start).toBe(1);
    expect(next.trim_in).toBe(0);
    expect(next.duration).toBe(6);
  });

  it("resizes text overlays without source trim semantics", () => {
    const overlay = { id: "ov-text", type: "text", timeline_start: 3, duration: 4, trim_in: 2 };
    const next = resizeOverlayDraft(overlay, { start: 0, duration: 7 });
    expect(next.timeline_start).toBe(0);
    expect(next.trim_in).toBe(2);
    expect(next.duration).toBe(7);
  });

  it("parses SRT and VTT subtitle cues", () => {
    expect(parseSubtitleTimecode("01:02:03,450")).toBe(3723.45);
    expect(parseSubtitleTimecode("00:00:02.5")).toBe(2.5);
    const cues = parseSubtitleText(`WEBVTT

00:00:01.000 --> 00:00:03.500 position:50%
First line
Second line

2
00:00:04,000 --> 00:00:04,050
too short but visible

3
00:00:05,000 --> 00:00:04,000
bad
`);
    expect(cues).toHaveLength(2);
    expect(cues[0]).toEqual({ start: 1, end: 3.5, duration: 2.5, text: "First line\nSecond line" });
    expect(cues[1].start).toBe(4);
    expect(cues[1].duration).toBe(0.1);
  });

  it("builds subtitle cues as text overlays", () => {
    const overlays = buildSubtitleOverlays(
      `1
00:00:01,200 --> 00:00:03,800
Clutch incoming`,
      { presetId: "clutch", fontFamily: "Inter", fontFile: "C:/fonts/inter.ttf", fontSize: 36 },
    );
    expect(overlays).toHaveLength(1);
    expect(overlays[0].type).toBe("text");
    expect(overlays[0].timeline_start).toBe(1.2);
    expect(overlays[0].duration).toBeCloseTo(2.6);
    expect(overlays[0].text.content).toBe("Clutch incoming");
    expect(overlays[0].text.preset_id).toBe("clutch");
    expect(overlays[0].text.font_file).toBe("C:/fonts/inter.ttf");
    expect(overlays[0].meta.subtitle).toBe(true);
  });
});
