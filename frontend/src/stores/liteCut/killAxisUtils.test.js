/** @vitest-environment node */
import { describe, expect, it } from "vitest";
import {
  assignKillAxisLevels,
  clipHasKillMarkers,
  collectKillAxisItems,
  killMarkerLabel,
  killMarkerTimelineSec,
  readClipKillMarkers,
} from "./killAxisUtils.js";
import { translate } from "../../i18n/translate.js";

function clip(overrides = {}) {
  return {
    id: "clip-1",
    source_type: "recorded_clip",
    source_id: 12,
    timeline_start: 10,
    trim_in: 0,
    trim_out: 20,
    speed: 1,
    speed_keyframes: [],
    meta: {
      duration_sec: 20,
      kill_markers: [{ video_sec: 4, tick: 1192, kind: "kill", perspective: "killer" }],
    },
    ...overrides,
  };
}

function body(clips) {
  return { tracks: [{ id: "v1", type: "video", clips }] };
}

describe("readClipKillMarkers", () => {
  it("normalizes and sorts markers carried by the recorded clip", () => {
    const markers = readClipKillMarkers(clip({
      meta: {
        duration_sec: 20,
        kill_markers: [
          { video_sec: 9, tick: 2, kind: "death" },
          { video_sec: 3, tick: 1, kind: "kill", victim: "enemy1", weapon: "ak47", headshot: true, kill_index: 2, round: 7 },
        ],
      },
    }));

    expect(markers.map((m) => m.videoSec)).toEqual([3, 9]);
    expect(markers[0]).toMatchObject({
      kind: "kill",
      victim: "enemy1",
      weapon: "ak47",
      headshot: true,
      killIndex: 2,
      round: 7,
    });
    expect(markers[1].kind).toBe("death");
  });

  it("drops entries without a usable video offset", () => {
    const markers = readClipKillMarkers(clip({
      meta: { kill_markers: [{ tick: 1 }, { video_sec: -2 }, { video_sec: "x" }, null, { video_sec: 1 }] },
    }));

    expect(markers).toHaveLength(1);
  });

  it("treats clips without kill data as empty", () => {
    expect(readClipKillMarkers({ meta: {} })).toEqual([]);
    expect(readClipKillMarkers({ meta: { kill_markers: "nope" } })).toEqual([]);
    expect(clipHasKillMarkers({ meta: {} })).toBe(false);
    expect(clipHasKillMarkers(clip())).toBe(true);
  });
});

describe("killMarkerTimelineSec", () => {
  it("offsets the source time by the clip position on the timeline", () => {
    expect(killMarkerTimelineSec(clip(), 4)).toBe(14);
  });

  it("shifts with the trimmed-in head so the kill stays on the same frame", () => {
    expect(killMarkerTimelineSec(clip({ trim_in: 3 }), 4)).toBe(11);
  });

  it("hides kills trimmed out of the clip", () => {
    expect(killMarkerTimelineSec(clip({ trim_in: 6 }), 4)).toBeNull();
    expect(killMarkerTimelineSec(clip({ trim_out: 3 }), 4)).toBeNull();
  });

  it("compresses positions on a sped-up clip", () => {
    expect(killMarkerTimelineSec(clip({ speed: 2 }), 4)).toBe(12);
  });

  it("expands positions on a slowed-down clip", () => {
    expect(killMarkerTimelineSec(clip({ speed: 0.5 }), 4)).toBe(18);
  });

  it("follows speed ramps through the keyframe integral", () => {
    // 0-2 s at 0.5x → 4 s of timeline, then 2-4 s at 2x → 1 s more.
    const ramped = clip({
      speed_keyframes: [
        { source_sec: 0, speed: 0.5 },
        { source_sec: 2, speed: 2 },
        { source_sec: 20, speed: 2 },
      ],
    });

    expect(killMarkerTimelineSec(ramped, 2)).toBe(14);
    expect(killMarkerTimelineSec(ramped, 4)).toBe(15);
  });

  it("mirrors positions on a reversed clip", () => {
    expect(killMarkerTimelineSec(clip({ reverse: true }), 4)).toBe(26);
  });

  it("rejects unusable input", () => {
    expect(killMarkerTimelineSec(null, 4)).toBeNull();
    expect(killMarkerTimelineSec(clip(), "abc")).toBeNull();
  });
});

describe("collectKillAxisItems", () => {
  it("collects markers from every video clip in timeline order", () => {
    const items = collectKillAxisItems(body([
      clip({ id: "b", timeline_start: 30, meta: { duration_sec: 20, kill_markers: [{ video_sec: 1, tick: 9 }] } }),
      clip({ id: "a" }),
    ]));

    expect(items.map((item) => item.timelineSec)).toEqual([14, 31]);
    expect(items.map((item) => item.clipId)).toEqual(["a", "b"]);
    expect(items[0].trackId).toBe("v1");
  });

  it("skips hidden video tracks and non-video tracks", () => {
    expect(collectKillAxisItems({
      tracks: [
        { id: "v1", type: "video", hidden: true, clips: [clip()] },
        { id: "a1", type: "audio", clips: [clip({ id: "audio-clip" })] },
      ],
    })).toEqual([]);
  });

  it("keeps killer and victim views of the same kill as separate entries", () => {
    const items = collectKillAxisItems(body([clip({
      meta: {
        duration_sec: 20,
        kill_markers: [
          { video_sec: 4, tick: 1192, perspective: "killer" },
          { video_sec: 9, tick: 1192, perspective: "victim" },
        ],
      },
    })]));

    expect(items).toHaveLength(2);
    expect(new Set(items.map((item) => item.id)).size).toBe(2);
  });

  it("returns nothing for an empty project", () => {
    expect(collectKillAxisItems({})).toEqual([]);
    expect(collectKillAxisItems(null)).toEqual([]);
  });
});

describe("assignKillAxisLevels", () => {
  it("stacks markers that would overlap at the current zoom", () => {
    const items = [{ timelineSec: 0 }, { timelineSec: 0.1 }, { timelineSec: 0.2 }, { timelineSec: 5 }];

    expect(assignKillAxisLevels(items, 44).map((item) => item.level)).toEqual([0, 1, 2, 0]);
  });

  it("keeps everything on one level once zoomed in far enough", () => {
    const items = [{ timelineSec: 0 }, { timelineSec: 0.5 }, { timelineSec: 1 }];

    expect(assignKillAxisLevels(items, 200).map((item) => item.level)).toEqual([0, 0, 0]);
  });
});

describe("killMarkerLabel", () => {
  const zh = (key, params) => translate("zh", key, params);
  const en = (key, params) => translate("en", key, params);

  it("describes a kill with the metadata that is available", () => {
    const marker = { kind: "kill", round: 7, victim: "enemy1", weapon: "ak47", headshot: true, killIndex: 3 };

    expect(killMarkerLabel(marker, zh)).toBe("击杀 · R7 · enemy1 · ak47 · 爆头 · 3杀");
    expect(killMarkerLabel(marker, en)).toBe("Kill · R7 · enemy1 · ak47 · Headshot · 3K");
  });

  it("marks the victim perspective and degrades to the bare kind", () => {
    expect(killMarkerLabel({ kind: "kill", perspective: "victim" }, zh)).toBe("被杀视角");
    expect(killMarkerLabel({ kind: "death" }, zh)).toBe("死亡");
    expect(killMarkerLabel(null, zh)).toBe("");
  });
});
