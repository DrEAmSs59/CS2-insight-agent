/** @vitest-environment node */
import { describe, expect, it } from "vitest";
import { canPlaceAssetOnTimeline, collectUsedLiteCutAssetIds, mapAssetRow } from "./assetUtils.js";

describe("assetUtils", () => {
  it("maps linked source rows for the media bin", () => {
    expect(mapAssetRow({
      id: 7,
      name: "clip.mp4",
      kind: "video",
      file_path: "C:/x/clip.mp4",
      storage_mode: "link",
      audio_codec_name: "aac",
      preview_proxy_version: "source-123",
    })).toMatchObject({
      id: 7,
      name: "clip.mp4",
      kind: "video",
      mediaKind: "asset",
      path: "C:/x/clip.mp4",
      storage_mode: "link",
      audio_codec_name: "aac",
      has_audio: true,
      preview_proxy_version: "source-123",
    });
  });

  it("uses only registered source availability to decide timeline placement", () => {
    expect(canPlaceAssetOnTimeline(mapAssetRow({
      id: 8,
      source_status: "available",
      source_available: true,
    }))).toBe(true);
    expect(canPlaceAssetOnTimeline(mapAssetRow({
      id: 9,
      source_status: "missing",
      source_available: false,
    }))).toBe(false);
    expect(canPlaceAssetOnTimeline(mapAssetRow({
      id: 10,
      source_status: "changed",
      source_available: false,
    }))).toBe(false);
  });

  it("collects asset ids referenced by timeline clips, overlays, and bgm", () => {
    const ids = collectUsedLiteCutAssetIds({
      tracks: [
        {
          id: "v1",
          type: "video",
          clips: [{ id: "clip", source_type: "file", meta: { asset_id: 10 } }],
        },
        {
          id: "a1",
          type: "audio",
          clips: [{ id: "audio", source_type: "file", meta: { asset_id: 11 } }],
        },
      ],
      overlays: [{ id: "ov", type: "sticker", meta: { asset_id: 12 } }],
      audio: { bgm: { asset_id: 13 } },
    });
    expect([...ids].sort((a, b) => a - b)).toEqual([10, 11, 12, 13]);
  });
});
