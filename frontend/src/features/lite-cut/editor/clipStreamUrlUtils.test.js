import { describe, expect, it } from "vitest";

import { liteCutAudioPreviewUrl, liteCutClipStreamUrl } from "./clipStreamUrlUtils.js";

describe("liteCutClipStreamUrl", () => {
  it("cache-busts timeline media with the persisted source version", () => {
    expect(liteCutClipStreamUrl({
      source_type: "file",
      meta: { asset_id: 7, preview_proxy_version: "source-123" },
    })).toBe("/api/lite-cut/assets/7/stream?preview=source-123");
  });

  it("uses the current asset-list version for clips saved before source versions existed", () => {
    expect(liteCutClipStreamUrl({
      source_type: "file",
      meta: { asset_id: 7 },
    }, { 7: "1783704157165765200" })).toBe("/api/lite-cut/assets/7/stream?preview=1783704157165765200");
  });

  it("prefers the live source version after a file is relinked", () => {
    expect(liteCutClipStreamUrl({
      source_type: "file",
      meta: { asset_id: 7, preview_proxy_version: "old-source" },
    }, { 7: "new-source" })).toBe("/api/lite-cut/assets/7/stream?preview=new-source");
  });

  it("keeps recorded clip streams unchanged", () => {
    expect(liteCutClipStreamUrl({ source_type: "recorded_clip", source_id: 6 })).toBe("/api/recorded-clips/6/stream");
  });

  it("routes video-derived A-track clips through the full audio proxy", () => {
    const item = {
      clip: {
        source_type: "file",
        meta: { asset_id: 10, source_clip_id: "video-1", preview_proxy_version: "source-abc" },
      },
    };
    expect(liteCutAudioPreviewUrl(item, new Set(["video-1"])))
      .toBe("/api/lite-cut/assets/10/preview/audio?v=source-abc");
  });

  it("keeps independent audio assets on their direct stream", () => {
    const item = { clip: { source_type: "file", meta: { asset_id: 11 } } };
    expect(liteCutAudioPreviewUrl(item, new Set(["video-1"])))
      .toBe("/api/lite-cut/assets/11/stream");
  });
});
