import { describe, expect, it } from "vitest";
import { relinkMissingAssetReferences, replacementMatchesWarning } from "./relinkUtils.js";

const asset = { id: 17, name: "replacement.mp4", kind: "video", file_path: "D:/LiteCut/replacement.mp4", duration_sec: 6 };

describe("LiteCut missing asset relinking", () => {
  it("replaces all file references without changing clip identity or timeline position", () => {
    const body = {
      tracks: [{ id: "v1", clips: [{ id: "clip", source_type: "file", file_path: "C:\\gone\\old.mp4", timeline_start: 9, trim_in: 1, trim_out: 20, meta: { asset_id: 2 } }] }],
      overlays: [{ id: "ov", asset_path: "C:/gone/old.mp4", meta: { asset_id: 2 } }],
      audio: {},
    };
    const result = relinkMissingAssetReferences(body, { kind: "video", path: "C:/gone/old.mp4" }, asset);
    expect(result.changed).toBe(2);
    expect(result.body.tracks[0].clips[0]).toMatchObject({
      id: "clip", timeline_start: 9, file_path: asset.file_path, trim_in: 1, trim_out: 6,
      meta: { asset_id: 17, name: "replacement.mp4" },
    });
    expect(result.body.overlays[0]).toMatchObject({ asset_path: asset.file_path, meta: { asset_id: 17 } });
  });

  it("turns an unavailable Insight recording into a project asset", () => {
    const body = { tracks: [{ clips: [{ id: "rec", source_type: "recorded_clip", source_id: 42, trim_in: 0, trim_out: 8 }] }], overlays: [] };
    const result = relinkMissingAssetReferences(body, { kind: "recording", source_id: 42 }, asset);
    expect(result.body.tracks[0].clips[0]).toMatchObject({ source_type: "file", source_id: null, file_path: asset.file_path, meta: { asset_id: 17 } });
  });

  it("rejects incompatible replacement kinds", () => {
    expect(replacementMatchesWarning({ kind: "font" }, asset)).toBe(false);
    expect(replacementMatchesWarning({ kind: "video" }, asset)).toBe(true);
  });
});
