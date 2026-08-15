import { describe, expect, it } from "vitest";
import codecCases from "../../../../../backend/tests/fixtures/lite_cut/lite_cut_project_codec_cases.json";
import projectContract from "../../../../../backend/app/features/lite_cut/contracts/lite_cut_project_contract.json";
import { normalizeLiteCutBody as normalizeFromStore } from "./editorStore.js";
import { diagnoseLiteCutProjectReferences, normalizeLiteCutBody } from "./projectCodec.js";

describe("LiteCut project codec", () => {
  it.each(codecCases.cases)("normalizes $name without mutating its input", ({ input, expected, changed }) => {
    const original = structuredClone(input);
    const result = normalizeLiteCutBody(input);

    expect(result).toEqual({ body: expected || input, changed });
    expect(input).toEqual(original);
  });

  it.each(codecCases.cases)("keeps the editorStore facade compatible for $name", ({ input }) => {
    expect(normalizeFromStore(input)).toEqual(normalizeLiteCutBody(input));
  });

  it.each(projectContract.diagnostic_cases)("diagnoses $name without rejecting or mutating it", (fixture) => {
    const original = structuredClone(fixture.body);
    const diagnostics = diagnoseLiteCutProjectReferences(fixture.body, { availableAssetIds: fixture.available_asset_ids });
    expect(diagnostics.map((item) => item.code).sort()).toEqual(fixture.expected_codes);
    expect(fixture.body).toEqual(original);
  });

  it("keeps shared schema, encoder and FrameMeld defaults literal", () => {
    const { body } = normalizeLiteCutBody(null);
    expect(body.schema_version).toBe(3);
    expect(body.output.encoder).toBe(projectContract.output.defaults.encoder);
    expect(body.output.framemeld_enabled).toBe(projectContract.output.defaults.framemeld_enabled);
    expect(projectContract.project_schema_version).toBe(3);
  });

  it("rejects retired schemas and fields before normalization", () => {
    expect(() => normalizeLiteCutBody({ schema_version: 2 })).toThrowError(expect.objectContaining({ code: "LITECUT_PROJECT_VERSION_UNSUPPORTED" }));
    expect(() => normalizeLiteCutBody({ schema_version: 3, output: { delivery_fps: 60 } })).toThrowError(
      expect.objectContaining({ code: "LITECUT_LEGACY_PROJECT_FIELDS_UNSUPPORTED" }),
    );
  });

  it("canonicalizes legacy interleaved V/A rows without keeping an old layout mode", () => {
    const { body, changed } = normalizeLiteCutBody({
      schema_version: 3,
      tracks: [
        { id: "v1", type: "video", label: "V1", clips: [] },
        { id: "a1", type: "audio", label: "A1", clips: [] },
        { id: "v2", type: "video", label: "V2", clips: [] },
        { id: "a2", type: "audio", label: "A2", clips: [] },
      ],
    });

    expect(changed).toBe(true);
    expect(body.tracks.map((track) => track.id)).toEqual(["v1", "v2", "a1", "a2"]);
  });
});
