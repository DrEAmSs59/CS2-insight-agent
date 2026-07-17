import { describe, expect, it } from "vitest";

import { liteCutClipStreamUrl } from "./clipStreamUrlUtils.js";

describe("liteCutClipStreamUrl", () => {
  it("cache-busts uploaded timeline media with the ready preview proxy version", () => {
    expect(liteCutClipStreamUrl({
      source_type: "file",
      meta: { asset_id: 7, preview_proxy_version: "alpha-v3" },
    })).toBe("/api/lite-cut/assets/7/stream?preview=alpha-v3");
  });

  it("uses the current asset-list version for clips saved before proxy version metadata existed", () => {
    expect(liteCutClipStreamUrl({
      source_type: "file",
      meta: { asset_id: 7 },
    }, { 7: "1783704157165765200" })).toBe("/api/lite-cut/assets/7/stream?preview=1783704157165765200");
  });

  it("keeps recorded clip streams unchanged", () => {
    expect(liteCutClipStreamUrl({ source_type: "recorded_clip", source_id: 6 })).toBe("/api/recorded-clips/6/stream");
  });
});
