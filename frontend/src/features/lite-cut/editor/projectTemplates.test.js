/** @vitest-environment node */
import { describe, expect, it } from "vitest";
import { LITECUT_PROJECT_TEMPLATES, projectBodyFromTemplate } from "./projectTemplates.js";
import { LITE_CUT_OUTPUT_DEFAULTS, LITE_CUT_PROJECT_SCHEMA_VERSION } from "../state/projectContract.js";

describe("projectBodyFromTemplate", () => {
  it("creates editable 16:9 and vertical project bodies", () => {
    expect(projectBodyFromTemplate("highlight-16x9")).toMatchObject({
      schema_version: LITE_CUT_PROJECT_SCHEMA_VERSION,
      template_id: "highlight-16x9",
      created_from_template: true,
      output: {
        width: 1920,
        height: 1080,
        fps: 60,
        framemeld_enabled: false,
        encoder_tier: LITE_CUT_OUTPUT_DEFAULTS.encoder_tier,
      },
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
    expect(body.output).toEqual({ ...LITE_CUT_OUTPUT_DEFAULTS, width: 1920, height: 1080, canvas_fit: "contain" });
    expect(body).toMatchObject({ transition_model_version: 1, transitions: [], overlay_tracks: [] });
  });
});
