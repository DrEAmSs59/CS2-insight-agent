import { describe, expect, it } from "vitest";
import { exportPollPhase } from "./useLiteCutExportController.js";
import { partitionLiteCutAssets } from "./useLiteCutMediaController.js";
import { createLiteCutProjectExport } from "./useLiteCutProjectController.js";

describe("LiteCut controller contracts", () => {
  it("maps export jobs to explicit terminal phases", () => {
    expect(exportPollPhase({ status: "done" }, (key) => key)).toEqual({ terminal: true, phase: "done", error: null });
    expect(exportPollPhase({ status: "running" }, (key) => key)).toEqual({ terminal: false, phase: "running", error: null });
    expect(exportPollPhase({ status: "error", error: "boom" }, (key) => key)).toMatchObject({ terminal: true, phase: "error", error: "boom" });
  });

  it("partitions assets and exposes proxy polling state", () => {
    const result = partitionLiteCutAssets([
      { id: 1, kind: "font", preview_proxy_version: "v2", preview_proxy_status: "done" },
      { id: 2, kind: "audio", preview_proxy_status: "queued" },
    ]);
    expect(result.fontAssets.map((asset) => asset.id)).toEqual([1]);
    expect(result.audioAssets.map((asset) => asset.id)).toEqual([2]);
    expect(result.assetPreviewVersions).toEqual({ 1: "v2", 2: "source" });
    expect(result.assetProxyBusy).toBe(true);
  });

  it("creates the stable project interchange envelope", () => {
    const body = { tracks: [] };
    expect(createLiteCutProjectExport(body, "Fixture", "2026-08-11T00:00:00.000Z")).toEqual({
      format: "litecut-project",
      schema_version: 2,
      exported_at: "2026-08-11T00:00:00.000Z",
      name: "Fixture",
      body,
    });
  });
});
