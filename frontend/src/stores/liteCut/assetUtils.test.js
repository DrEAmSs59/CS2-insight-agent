/** @vitest-environment node */
import { describe, expect, it } from "vitest";
import { collectUsedLiteCutAssetIds, mapAssetRow } from "./assetUtils.js";

describe("assetUtils", () => {
  it("maps uploaded asset rows for the media bin", () => {
    expect(mapAssetRow({
      id: 7,
      name: "clip.mp4",
      kind: "video",
      file_path: "C:/x/clip.mp4",
      preview_proxy_required: true,
      preview_proxy_status: "running",
      preview_proxy_version: "running",
    })).toMatchObject({
      id: 7,
      name: "clip.mp4",
      kind: "video",
      mediaKind: "asset",
      path: "C:/x/clip.mp4",
      preview_proxy_required: true,
      preview_proxy_status: "running",
      preview_proxy_version: "running",
    });
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
