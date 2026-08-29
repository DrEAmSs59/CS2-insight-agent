import { describe, expect, it } from "vitest";

import {
  BUILTIN_RECORDING_SKYBOX_IDS,
  isCustomRecordingSkyboxId,
  isRecordingSkyboxId,
  normalizeRecordingSkyboxId,
  recordingSkyboxPreviewUrl,
  sortBuiltinRecordingSkyboxes,
} from "./recordingSkybox.js";


describe("custom recording skybox ids", () => {
  const customId = "custom:0123456789abcdef0123456789abcdef";

  it("preserves a well-formed custom id", () => {
    expect(isCustomRecordingSkyboxId(customId)).toBe(true);
    expect(isRecordingSkyboxId(customId)).toBe(true);
    expect(normalizeRecordingSkyboxId(customId)).toBe(customId);
  });

  it("still rejects malformed and unknown ids", () => {
    expect(isRecordingSkyboxId("custom:nope")).toBe(false);
    expect(isRecordingSkyboxId("another-sky")).toBe(false);
    expect(normalizeRecordingSkyboxId("custom:nope")).toBe("default");
  });

  it("accepts only the bundled Cartoon family", () => {
    for (const skyboxId of ["cartoon", "cartoon3", "cartoon10"]) {
      expect(isRecordingSkyboxId(skyboxId)).toBe(true);
      expect(normalizeRecordingSkyboxId(skyboxId)).toBe(skyboxId);
    }
    for (const skyboxId of ["chroma_green", "xuejing", "egg1"]) {
      expect(isRecordingSkyboxId(skyboxId)).toBe(false);
      expect(normalizeRecordingSkyboxId(skyboxId)).toBe("default");
    }
  });

  it("keeps the Cartoon family in natural numeric order", () => {
    const expected = [
      "cartoon",
      "cartoon1",
      "cartoon2",
      "cartoon3",
      "cartoon4",
      "cartoon5",
      "cartoon6",
      "cartoon7",
      "cartoon8",
      "cartoon9",
      "cartoon10",
    ];
    expect(BUILTIN_RECORDING_SKYBOX_IDS.filter((id) => id.startsWith("cartoon")))
      .toEqual(expected);
    expect(sortBuiltinRecordingSkyboxes([
      { id: "cartoon10" },
      { id: "cartoon3" },
      { id: "cartoon" },
      { id: "cartoon1" },
    ]).map(({ id }) => id)).toEqual(["cartoon", "cartoon1", "cartoon3", "cartoon10"]);
  });

  it("resolves Cartoon preview paths and leaves removed or custom resources without one", () => {
    expect(recordingSkyboxPreviewUrl("cartoon")).toBe("/skyboxes/cartoon.webp");
    expect(recordingSkyboxPreviewUrl("cartoon10")).toBe("/skyboxes/cartoon10.webp");
    expect(recordingSkyboxPreviewUrl("xuejing")).toBe("");
    expect(recordingSkyboxPreviewUrl("default")).toBe("");
    expect(recordingSkyboxPreviewUrl(`custom:${"a".repeat(32)}`)).toBe("");
    expect(recordingSkyboxPreviewUrl(`custom:${"a".repeat(32)}`, [{
      id: `custom:${"a".repeat(32)}`,
      preview_url: "/custom-preview.webp",
    }])).toBe("/custom-preview.webp");
  });
});
