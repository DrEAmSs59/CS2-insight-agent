/** @vitest-environment node */
import { describe, expect, it } from "vitest";
import {
  nextTopVideoPlaybackAfter,
  previewAudioState,
  projectBgmPreviewClip,
  resolveAudioPreviewItems,
  resolveBaseVideoTrackId,
  resolveTopVideoPlaybackAt,
  resolveVideoUnderlayPlaybackAt,
  resolveVideoUnderlayPlaybacksAt,
  resolveIncomingTransitionPlayback,
  resolveOutgoingTransitionPreload,
  selectedClipPreviewSourceTime,
} from "./playbackUtils.js";
import { buildRecordedClip } from "./timelineUtils.js";

describe("playbackUtils", () => {
  it("resolves second clip on same track at playhead", () => {
    const clip1 = buildRecordedClip({ id: 1, duration: 20, _raw: {} }, 0);
    const clip2 = buildRecordedClip({ id: 2, duration: 13, _raw: {} }, 20);
    const body = {
      tracks: [{ id: "v1", type: "video", clips: [clip1, clip2] }],
    };
    const hit = resolveTopVideoPlaybackAt(body, 20.58);
    expect(hit?.clip?.source_id).toBe(2);
    expect(hit?.sourceTime).toBeCloseTo(0.58, 2);
  });

  it("freezes the preceding clip behind an incoming soft transition", () => {
    const first = buildRecordedClip({ id: 1, duration: 5, _raw: {} }, 0);
    first.transition_out = { type: "fade", duration_sec: 0.5 };
    const second = buildRecordedClip({ id: 2, duration: 4, _raw: {} }, 5);
    const body = { tracks: [{ id: "v1", type: "video", clips: [first, second] }] };
    const current = resolveTopVideoPlaybackAt(body, 5.2);
    const transition = resolveIncomingTransitionPlayback(body, current);
    expect(transition).toMatchObject({
      trackId: "v1",
      transitionType: "fade",
      freezePlayback: true,
    });
    expect(transition?.sourceTime).toBeCloseTo(4.95, 2);
    expect(transition?.progress).toBeCloseTo(0.4, 2);
    expect(resolveIncomingTransitionPlayback(body, resolveTopVideoPlaybackAt(body, 5.6))).toBeNull();
  });

  it("previews the incoming clip transition with the same precedence as export", () => {
    const first = buildRecordedClip({ id: 1, duration: 5, _raw: {} }, 0);
    first.transition_out = { type: "fade", duration_sec: 0.5 };
    const second = buildRecordedClip({ id: 2, duration: 4, _raw: {} }, 5);
    second.transition_in = { type: "wipe_l", duration_sec: 0.8 };
    const body = { tracks: [{ id: "v1", type: "video", clips: [first, second] }] };

    const transition = resolveIncomingTransitionPlayback(body, resolveTopVideoPlaybackAt(body, 5.2));
    expect(transition).toMatchObject({ transitionType: "wipe_l", transitionDuration: 0.8 });
    expect(transition?.progress).toBeCloseTo(0.25, 2);
  });

  it("preloads the outgoing frame before a 1.5 second contiguous transition", () => {
    const first = buildRecordedClip({ id: 1, duration: 5, _raw: {} }, 0);
    const second = buildRecordedClip({ id: 2, duration: 4, _raw: {} }, 5);
    second.transition_in = { type: "fade", duration_sec: 1.5 };
    const body = { tracks: [{ id: "v1", type: "video", clips: [first, second] }] };
    const preload = resolveOutgoingTransitionPreload(body, resolveTopVideoPlaybackAt(body, 3.1));
    expect(preload).toMatchObject({ trackId: "v1", transitionDuration: 1.5, preloadOnly: true, freezePlayback: true });
    expect(resolveOutgoingTransitionPreload(body, resolveTopVideoPlaybackAt(body, 2.9))).toBeNull();
  });

  it("maps sped-up timeline seconds to source seconds", () => {
    const clip = buildRecordedClip({ id: 1, duration: 20, _raw: {} }, 0);
    clip.speed = 2;
    const body = {
      tracks: [{ id: "v1", type: "video", clips: [clip] }],
    };
    const hit = resolveTopVideoPlaybackAt(body, 3);
    expect(hit?.sourceTime).toBeCloseTo(6, 2);
    expect(hit?.clipEnd).toBeCloseTo(10, 2);
  });

  it("holds the final source frame while timeline playback continues", () => {
    const clip = buildRecordedClip({ id: 1, duration: 6, _raw: {} }, 0);
    clip.freeze_frame_sec = 2;
    const hit = resolveTopVideoPlaybackAt({ tracks: [{ id: "v1", type: "video", clips: [clip] }] }, 6.8);
    expect(hit?.frozen).toBe(true);
    expect(hit?.sourceTime).toBeCloseTo(5.95, 2);
    expect(hit?.clipEnd).toBe(8);
  });

  it("maps reversed timeline seconds from the trimmed source end", () => {
    const clip = buildRecordedClip({ id: 1, duration: 20, _raw: {} }, 0);
    clip.trim_in = 2;
    clip.trim_out = 10;
    clip.speed = 2;
    clip.reverse = true;
    const body = {
      tracks: [{ id: "v1", type: "video", clips: [clip] }],
    };
    const start = resolveTopVideoPlaybackAt(body, 0);
    const middle = resolveTopVideoPlaybackAt(body, 1.5);
    const end = resolveTopVideoPlaybackAt(body, 3.9);
    const afterEnd = resolveTopVideoPlaybackAt(body, 4.2);
    expect(start?.sourceTime).toBeCloseTo(10, 2);
    expect(middle?.sourceTime).toBeCloseTo(7, 2);
    expect(end?.sourceTime).toBeCloseTo(2.2, 2);
    expect(afterEnd).toBeNull();
  });

  it("skips hidden video tracks for preview playback", () => {
    const hiddenClip = buildRecordedClip({ id: 1, duration: 10, _raw: {} }, 0);
    const visibleClip = buildRecordedClip({ id: 2, duration: 10, _raw: {} }, 0);
    const body = {
      tracks: [
        { id: "v1", type: "video", hidden: false, clips: [visibleClip] },
        { id: "v2", type: "video", hidden: true, clips: [hiddenClip] },
      ],
    };
    const hit = resolveTopVideoPlaybackAt(body, 1);
    expect(hit?.trackId).toBe("v1");
    expect(hit?.clip?.source_id).toBe(2);
  });

  it("falls back to lower video track when top clip ends", () => {
    const base = buildRecordedClip({ id: 1, duration: 10, _raw: {} }, 0);
    const top = buildRecordedClip({ id: 2, duration: 2, _raw: {} }, 1);
    const body = {
      tracks: [
        { id: "v1", type: "video", hidden: false, clips: [top] },
        { id: "v2", type: "video", hidden: false, clips: [base] },
      ],
    };
    const current = resolveTopVideoPlaybackAt(body, 2.9);
    expect(current?.trackId).toBe("v1");
    const next = nextTopVideoPlaybackAfter(body, current);
    expect(next?.trackId).toBe("v2");
    expect(next?.clip?.source_id).toBe(1);
    expect(next?.resumeTimelineSec).toBeCloseTo(3, 2);
  });

  it("resolves lower active video under a top video layer", () => {
    const base = buildRecordedClip({ id: 1, duration: 10, _raw: {} }, 0);
    const top = buildRecordedClip({ id: 2, duration: 4, _raw: {} }, 1);
    const body = {
      tracks: [
        { id: "v1", type: "video", hidden: false, clips: [top] },
        { id: "v2", type: "video", hidden: false, clips: [base] },
      ],
    };
    const current = resolveTopVideoPlaybackAt(body, 2);
    const underlay = resolveVideoUnderlayPlaybackAt(body, 2, current);
    expect(current?.trackId).toBe("v1");
    expect(underlay?.trackId).toBe("v2");
    expect(underlay?.clip?.source_id).toBe(1);
    expect(underlay?.sourceTime).toBeCloseTo(2, 2);
  });

  it("resolves every lower active video layer in bottom-to-top order", () => {
    const body = {
      tracks: [
        { id: "v1", type: "video", clips: [buildRecordedClip({ id: 1, duration: 5, _raw: {} }, 0)] },
        { id: "v2", type: "video", clips: [buildRecordedClip({ id: 2, duration: 5, _raw: {} }, 0)] },
        { id: "v3", type: "video", clips: [buildRecordedClip({ id: 3, duration: 5, _raw: {} }, 0)] },
      ],
    };
    const top = resolveTopVideoPlaybackAt(body, 1);
    expect(resolveVideoUnderlayPlaybacksAt(body, 1, top).map((item) => item.trackId)).toEqual(["v3", "v2"]);
  });

  it("does not resolve underlay when the lowest visible track is already the top playback", () => {
    const base = buildRecordedClip({ id: 1, duration: 10, _raw: {} }, 0);
    const body = {
      tracks: [{ id: "v1", type: "video", hidden: false, clips: [base] }],
    };
    const current = resolveTopVideoPlaybackAt(body, 2);
    expect(resolveVideoUnderlayPlaybackAt(body, 2, current)).toBeNull();
  });

  it("keeps preview layering aligned after the base track is reordered away from v1", () => {
    const base = buildRecordedClip({ id: 1, duration: 10, _raw: {} }, 0);
    const top = buildRecordedClip({ id: 2, duration: 10, _raw: {} }, 0);
    const body = {
      tracks: [
        { id: "v2", type: "video", hidden: false, clips: [base] },
        { id: "v1", type: "video", hidden: false, clips: [top] },
      ],
    };
    const current = resolveTopVideoPlaybackAt(body, 2);
    const underlay = resolveVideoUnderlayPlaybackAt(body, 2, current);
    expect(resolveBaseVideoTrackId(body)).toBe("v1");
    expect(current?.trackId).toBe("v2");
    expect(underlay?.trackId).toBe("v1");
  });

  it("preserves the blank gap before the same-track next clip", () => {
    const first = buildRecordedClip({ id: 1, duration: 2, _raw: {} }, 0);
    const second = buildRecordedClip({ id: 2, duration: 2, _raw: {} }, 5);
    const body = {
      tracks: [{ id: "v1", type: "video", hidden: false, clips: [first, second] }],
    };
    const current = resolveTopVideoPlaybackAt(body, 1.9);
    const next = nextTopVideoPlaybackAfter(body, current);
    expect(next?.clip?.source_id).toBe(2);
    expect(next?.clipStart).toBe(5);
    expect(next?.resumeTimelineSec).toBe(2);
  });

  it("finds the next clip across tracks while preserving the blank gap", () => {
    const first = buildRecordedClip({ id: 1, duration: 2, _raw: {} }, 0);
    const second = buildRecordedClip({ id: 2, duration: 2, _raw: {} }, 5);
    const body = {
      tracks: [
        { id: "v1", type: "video", hidden: false, clips: [first] },
        { id: "v2", type: "video", hidden: false, clips: [second] },
      ],
    };

    const next = nextTopVideoPlaybackAfter(body, resolveTopVideoPlaybackAt(body, 1.9));

    expect(next?.clip).toBe(second);
    expect(next?.trackId).toBe("v2");
    expect(next?.clipStart).toBe(5);
    expect(next?.resumeTimelineSec).toBe(2);
  });

  it("does not reactivate an ended upper-track clip inside a lower-track gap", () => {
    const upper = buildRecordedClip({ id: 1, duration: 3, _raw: {} }, 0);
    const lowerFirst = buildRecordedClip({ id: 2, duration: 7, _raw: {} }, 0);
    const lowerSecond = buildRecordedClip({ id: 2, duration: 4, _raw: {} }, 9);
    const body = {
      tracks: [
        { id: "v1", type: "video", hidden: false, clips: [upper] },
        { id: "v2", type: "video", hidden: false, clips: [lowerFirst, lowerSecond] },
      ],
    };

    expect(resolveTopVideoPlaybackAt(body, 8)).toBeNull();
    expect(resolveTopVideoPlaybackAt(body, 9.2)?.clip).toBe(lowerSecond);
    const next = nextTopVideoPlaybackAfter(body, resolveTopVideoPlaybackAt(body, 6.9));
    expect(next?.clip).toBe(lowerSecond);
    expect(next?.resumeTimelineSec).toBeCloseTo(7, 2);
  });

  it("returns an empty preview after the trimmed end of the final clip", () => {
    const clip = buildRecordedClip({ id: 1, duration: 12, _raw: {} }, 0);
    clip.trim_out = 4;
    const body = {
      tracks: [{ id: "v1", type: "video", hidden: false, clips: [clip] }],
    };

    expect(resolveTopVideoPlaybackAt(body, 3.9)?.clip).toBe(clip);
    expect(resolveTopVideoPlaybackAt(body, 4)).toBeNull();
    expect(resolveTopVideoPlaybackAt(body, 8)).toBeNull();
  });

  it("uses the selected clip frame under the playhead and its first visible frame otherwise", () => {
    const clip = buildRecordedClip({ id: 1, duration: 20, _raw: {} }, 5);
    clip.trim_in = 3;
    clip.trim_out = 13;
    clip.speed = 2;

    expect(selectedClipPreviewSourceTime(clip, 6.5)).toBeCloseTo(6, 3);
    expect(selectedClipPreviewSourceTime(clip, 2)).toBeCloseTo(3, 3);
    expect(selectedClipPreviewSourceTime(clip, 18)).toBeCloseTo(3, 3);
  });

  it("uses the timeline-facing first frame for a reversed selected clip", () => {
    const clip = buildRecordedClip({ id: 1, duration: 20, _raw: {} }, 5);
    clip.trim_in = 3;
    clip.trim_out = 13;
    clip.reverse = true;

    expect(selectedClipPreviewSourceTime(clip, 2)).toBeCloseTo(13, 3);
    expect(selectedClipPreviewSourceTime(clip, 7)).toBeCloseTo(11, 3);
  });

  it("computes preview audio from clip and master volume", () => {
    expect(previewAudioState({ clip: { volume: 0.5 }, masterVolume: 0.8 })).toEqual({
      muted: false,
      volume: 0.4,
    });
    expect(previewAudioState({ clip: { volume: 2 }, masterVolume: 2 })).toEqual({
      muted: false,
      volume: 1,
    });
    expect(previewAudioState({ clip: { volume: 1, muted: true }, masterVolume: 1 })).toEqual({
      muted: true,
      volume: 0,
    });
    expect(previewAudioState({ clip: { volume: 1 }, masterVolume: 1, forceMuted: true })).toEqual({
      muted: true,
      volume: 0,
    });
    expect(previewAudioState({ clip: { volume: 0.8 }, trackVolume: 0.5, masterVolume: 1 })).toEqual({
      muted: false,
      volume: 0.4,
    });
    expect(previewAudioState({ clip: { volume: 1 }, trackVolume: 0, masterVolume: 1 })).toEqual({
      muted: true,
      volume: 0,
    });
  });

  it("resolves active extra audio track clips for preview", () => {
    const active = {
      id: "aud-1",
      source_type: "file",
      file_path: "C:/x/music.mp3",
      timeline_start: 5,
      trim_in: 10,
      trim_out: 20,
      speed: 2,
      volume: 0.5,
      fade_in_sec: 2,
      meta: { kind: "audio", asset_id: 7, duration_sec: 20 },
    };
    const hidden = { ...active, id: "hidden", timeline_start: 6 };
    const muted = { ...active, id: "muted", timeline_start: 6 };
    const body = {
      tracks: [
        { id: "a1", type: "audio", volume: 0.5, clips: [active] },
        { id: "a2", type: "audio", hidden: true, clips: [hidden] },
        { id: "a3", type: "audio", muted: true, clips: [muted] },
      ],
    };

    const items = resolveAudioPreviewItems(body, 6, 0.8);
    expect(items).toHaveLength(1);
    expect(items[0].id).toBe("aud-1");
    expect(items[0].trackId).toBe("a1");
    expect(items[0].sourceTime).toBeCloseTo(12);
    expect(items[0].playbackRate).toBe(2);
    expect(items[0].volume).toBeCloseTo(0.1);
  });

  it("marks reversed clip audio so preview never plays it forwards", () => {
    const reversed = {
      id: "reverse-audio",
      source_type: "file",
      file_path: "C:/x/reverse.mov",
      timeline_start: 0,
      trim_in: 0,
      trim_out: 10,
      reverse: true,
      meta: { kind: "video", asset_id: 8, duration_sec: 10 },
    };
    const items = resolveAudioPreviewItems({ tracks: [{ id: "v1", type: "video", clips: [reversed] }] }, 2);
    expect(items[0]).toMatchObject({ id: "reverse-audio", reversePlayback: true, sourceTime: 8 });
  });

  it("previews only soloed audio tracks and suppresses project bgm", () => {
    const active = {
      id: "solo-audio",
      source_type: "file",
      file_path: "C:/x/solo.mp3",
      timeline_start: 0,
      trim_out: 8,
      meta: { kind: "audio", asset_id: 1, duration_sec: 8 },
    };
    const nonSolo = { ...active, id: "other-audio", meta: { kind: "audio", asset_id: 2, duration_sec: 8 } };
    const body = {
      audio: { bgm: { asset_id: 3, path: "C:/x/bgm.mp3", duration_sec: 8 } },
      tracks: [
        { id: "a1", type: "audio", solo: true, clips: [active] },
        { id: "a2", type: "audio", clips: [nonSolo] },
      ],
    };

    expect(resolveAudioPreviewItems(body, 2)).toMatchObject([{ id: "solo-audio", trackId: "a1" }]);
  });

  it("resolves project bgm as an audio preview item", () => {
    const body = {
      audio: {
        master_volume: 0.8,
        bgm: {
          asset_id: 9,
          path: "C:/x/bgm.mp3",
          name: "bgm.mp3",
          duration_sec: 10,
          start_sec: 2,
          volume: 0.5,
          fade_in_sec: 2,
          fade_out_sec: 1,
        },
      },
      tracks: [],
    };
    const clip = projectBgmPreviewClip(body);
    expect(clip?.id).toBe("project-bgm");
    expect(clip?.timeline_start).toBe(2);
    expect(clip?.trim_out).toBe(10);
    expect(clip?.meta.asset_id).toBe(9);

    const items = resolveAudioPreviewItems(body, 3, body.audio.master_volume);
    expect(items).toHaveLength(1);
    expect(items[0].id).toBe("project-bgm");
    expect(items[0].trackId).toBe("bgm");
    expect(items[0].sourceTime).toBeCloseTo(1);
    expect(items[0].volume).toBeCloseTo(0.2);
  });

  it("includes every visible video layer so preview matches exported source audio", () => {
    const base = buildRecordedClip({ id: 31, duration: 8, _raw: {} }, 0);
    const layer = buildRecordedClip({ id: 32, duration: 8, _raw: {} }, 1);
    layer.volume = 0.5;
    const items = resolveAudioPreviewItems(
      {
        tracks: [
          { id: "v1", type: "video", volume: 0.8, clips: [base] },
          { id: "v2", type: "video", volume: 0.5, clips: [layer] },
        ],
      },
      2,
    );

    expect(items).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: base.id, trackId: "v1", sourceTime: 2, volume: 0.8 }),
      expect.objectContaining({ id: layer.id, trackId: "v2", sourceTime: 1, volume: 0.25 }),
    ]));
  });

  it("keeps consecutive clips from the same audio asset as separate preview items", () => {
    const first = { id: "audio-a", source_type: "file", file_path: "C:/x/reused.wav", timeline_start: 0, trim_in: 0, trim_out: 2, meta: { kind: "audio", asset_id: 44 } };
    const second = { ...first, id: "audio-b", timeline_start: 2 };
    const body = { tracks: [{ id: "a1", type: "audio", clips: [first, second] }] };

    expect(resolveAudioPreviewItems(body, 1.9)[0]?.id).toBe("audio-a");
    expect(resolveAudioPreviewItems(body, 2.1)[0]?.id).toBe("audio-b");
  });

  it("does not preview bgm without a streamable asset id", () => {
    const body = { audio: { bgm: { path: "C:/x/bgm.mp3", duration_sec: 10 } }, tracks: [] };
    expect(projectBgmPreviewClip(body)).toBeNull();
    expect(resolveAudioPreviewItems(body, 1, 1)).toEqual([]);
  });
});
