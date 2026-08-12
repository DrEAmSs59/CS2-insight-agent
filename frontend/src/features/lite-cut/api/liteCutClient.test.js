import { describe, expect, it, vi } from "vitest";
import { createLiteCutClient } from "./liteCutClient.js";

describe("liteCutClient", () => {
  it("owns project endpoint details and unwraps response bodies", async () => {
    const transport = {
      get: vi.fn().mockResolvedValue({ data: { items: [{ id: 7 }] } }),
    };
    const client = createLiteCutClient(transport);

    await expect(client.listProjects()).resolves.toEqual({ items: [{ id: 7 }] });
    expect(transport.get).toHaveBeenCalledWith("/lite-cut/projects", {
      params: { limit: 50, offset: 0 },
    });
  });

  it("uses the lightweight linked project-file contract", async () => {
    const transport = {
      get: vi.fn().mockResolvedValue({ data: { items: [] } }),
      post: vi.fn()
        .mockResolvedValueOnce({ data: { saved_path: "D:\\out\\Project.litecut" } })
        .mockResolvedValueOnce({ data: { id: 8, offline_asset_count: 2 } }),
    };
    const client = createLiteCutClient(transport);
    const projectFile = new File(["{}"], "Project.litecut", { type: "application/vnd.litecut.project+json" });

    await expect(client.exportProjectFile(4, "D:\\out")).resolves.toEqual({ saved_path: "D:\\out\\Project.litecut" });
    await expect(client.importProjectFile(projectFile)).resolves.toEqual({ id: 8, offline_asset_count: 2 });
    expect(transport.post).toHaveBeenNthCalledWith(1, "/lite-cut/projects/4/project-file/export", {
      destination: "D:\\out",
    });
    expect(transport.post.mock.calls[1][0]).toBe("/lite-cut/projects/project-file/import");
    expect(transport.post.mock.calls[1][1]).toBeInstanceOf(FormData);
  });

  it("registers and relinks assets by path without multipart uploads", async () => {
    const transport = {
      post: vi.fn().mockResolvedValue({ data: { items: [{ id: 12 }] } }),
    };
    const client = createLiteCutClient(transport);

    await client.linkAssets({ paths: ["I:\\media\\match.mkv"], projectId: 4 });
    await client.relinkAsset(12, "D:\\archive\\match.mkv");

    expect(transport.post).toHaveBeenNthCalledWith(1, "/lite-cut/assets/link", {
      paths: ["I:\\media\\match.mkv"],
      project_id: 4,
    });
    expect(transport.post).toHaveBeenNthCalledWith(2, "/lite-cut/assets/12/relink", {
      path: "D:\\archive\\match.mkv",
    });
  });

  it("registers Insight recordings as project-linked assets", async () => {
    const transport = { post: vi.fn().mockResolvedValue({ data: { id: 33, origin_type: "insight_recording" } }) };
    const client = createLiteCutClient(transport);

    await expect(client.linkRecordedAsset({ projectId: 4, recordingId: 19 }))
      .resolves.toMatchObject({ id: 33, origin_type: "insight_recording" });
    expect(transport.post).toHaveBeenCalledWith("/lite-cut/assets/link-recording", {
      project_id: 4,
      recording_id: 19,
    });
  });

  it("opens the local multi-file picker without uploading source bytes", async () => {
    const transport = {
      post: vi.fn().mockResolvedValue({ data: { paths: ["I:\\media\\match.mkv"] } }),
    };
    const client = createLiteCutClient(transport);

    await expect(client.pickFiles({ fileType: "lite_cut_asset", multiple: true }))
      .resolves.toEqual({ paths: ["I:\\media\\match.mkv"] });

    expect(transport.post).toHaveBeenCalledWith("/file-picker", {
      file_type: "lite_cut_asset",
      multiple: true,
    });
  });

  it("uses the generated-media endpoint only for newly recorded content", async () => {
    const transport = {
      post: vi.fn().mockResolvedValue({ data: { id: 13 } }),
    };
    const client = createLiteCutClient(transport);
    const file = new File(["voice"], "voiceover.webm", { type: "audio/webm" });

    await expect(client.uploadGeneratedAsset({ file, projectId: 4 })).resolves.toEqual({ id: 13 });

    expect(transport.post.mock.calls[0][0]).toBe("/lite-cut/assets/generated?project_id=4");
    expect(transport.post.mock.calls[0][1]).toBeInstanceOf(FormData);
  });

  it("requests the playhead segment first and forwards cancellation", async () => {
    const controller = new AbortController();
    const transport = {
      post: vi.fn().mockResolvedValue({
        data: {
          status: "ready",
          requested_segment: 9,
          segment_url: "/api/lite-cut/assets/12/preview/segments/9?request=abc",
        },
      }),
    };
    const client = createLiteCutClient(transport);

    await expect(client.requestAssetPreview({
      assetId: 12,
      timeSec: 37.25,
      lookAheadSec: 12,
      priority: "interactive",
      signal: controller.signal,
    })).resolves.toMatchObject({ status: "ready", requested_segment: 9 });

    expect(transport.post).toHaveBeenCalledWith(
      "/lite-cut/assets/12/preview/request",
      { time_sec: 37.25, look_ahead_sec: 12, priority: "interactive", retry: false },
      { signal: controller.signal },
    );
  });
});
