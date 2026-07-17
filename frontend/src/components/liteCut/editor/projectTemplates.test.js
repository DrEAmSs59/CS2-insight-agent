/** @vitest-environment node */
import { describe, expect, it } from "vitest";
import { LITECUT_PROJECT_TEMPLATES, projectBodyFromTemplate } from "./projectTemplates.js";

describe("projectBodyFromTemplate", () => {
  it("creates editable 16:9 and vertical project bodies", () => {
    expect(projectBodyFromTemplate("highlight-16x9")).toMatchObject({
      template_id: "highlight-16x9",
      created_from_template: true,
      output: { width: 1920, height: 1080, fps: 60 },
    });
    expect(projectBodyFromTemplate("shorts-9x16")).toMatchObject({
      output: { width: 1080, height: 1920, canvas_fit: "cover" },
    });
  });

  it("creates a multi-angle timeline without prefilled media", () => {
    const body = projectBodyFromTemplate("review-multicam");
    expect(body.tracks.map((item) => item.id)).toEqual(["v1", "v2", "a1", "a2"]);
    expect(body.tracks.every((item) => item.clips.length === 0)).toBe(true);
    expect(LITECUT_PROJECT_TEMPLATES).toHaveLength(3);
  });
});
