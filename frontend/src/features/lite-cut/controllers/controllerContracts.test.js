import { describe, expect, it } from "vitest";
import { exportPollPhase } from "./useLiteCutExportController.js";
import { partitionLiteCutAssets } from "./useLiteCutMediaController.js";

describe("LiteCut controller contracts", () => {
  it("maps export jobs to explicit terminal phases", () => {
    expect(exportPollPhase({ status: "done" }, (key) => key)).toEqual({ terminal: true, phase: "done", error: null });
    expect(exportPollPhase({ status: "running" }, (key) => key)).toEqual({ terminal: false, phase: "running", error: null });
    expect(exportPollPhase({ status: "error", error: "boom" }, (key) => key)).toMatchObject({ terminal: true, phase: "error", error: "boom" });
  });

  it("partitions assets and exposes source stream versions", () => {
    const result = partitionLiteCutAssets([
      { id: 1, kind: "font", preview_proxy_version: "source-1" },
      { id: 2, kind: "audio" },
    ]);
    expect(result.fontAssets.map((asset) => asset.id)).toEqual([1]);
    expect(result.audioAssets.map((asset) => asset.id)).toEqual([2]);
    expect(result.assetPreviewVersions).toEqual({ 1: "source-1", 2: "source" });
  });
});
