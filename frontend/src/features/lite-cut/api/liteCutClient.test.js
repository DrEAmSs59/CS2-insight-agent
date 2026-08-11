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

  it("preserves export query and portable-package request contracts", async () => {
    const transport = {
      get: vi.fn().mockResolvedValue({ data: { items: [] } }),
      post: vi.fn().mockResolvedValue({ data: { job_id: "job/1" } }),
    };
    const client = createLiteCutClient(transport);

    await client.listExports({ projectId: 4, limit: 3, offset: 2 });
    await expect(client.startPortablePackage(4, "D:\\out")).resolves.toEqual({ job_id: "job/1" });
    expect(transport.get).toHaveBeenCalledWith("/lite-cut/exports", {
      params: { limit: 3, offset: 2, project_id: 4 },
    });
    expect(transport.post).toHaveBeenCalledWith("/lite-cut/projects/4/portable-package/start", {
      destination: "D:\\out",
    });
  });
});
