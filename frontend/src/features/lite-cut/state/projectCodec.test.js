import { describe, expect, it } from "vitest";
import codecCases from "../../../../../data/lite_cut_project_codec_cases.json";
import projectContract from "../../../../../data/lite_cut_project_contract.json";
import { normalizeLiteCutBody as normalizeFromStore } from "./editorStore.js";
import { diagnoseLiteCutProjectReferences, normalizeLiteCutBody } from "./projectCodec.js";

describe("LiteCut project codec compatibility", () => {
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
    expect(body.schema_version).toBeUndefined();
    expect(body.output.encoder).toBe(projectContract.output.defaults.encoder);
    expect(body.output.framemeld_enabled).toBe(projectContract.output.defaults.framemeld_enabled);
    expect(projectContract.project_schema_version).toBe(2);
  });
});
