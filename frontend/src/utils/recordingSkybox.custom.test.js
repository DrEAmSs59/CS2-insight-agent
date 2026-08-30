import { describe, expect, it } from "vitest";

import {
  BUILTIN_RECORDING_SKYBOX_IDS,
  isCustomRecordingSkyboxId,
  isRecordingSkyboxId,
  normalizeRecordingSkyboxId,
  partitionBuiltinRecordingSkyboxes,
  recordingSkyboxDisplayName,
  recordingSkyboxPreviewUrl,
  SOLID_COLOR_RECORDING_SKYBOX_IDS,
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

  it("accepts the bundled chroma and Cartoon families", () => {
    for (const skyboxId of [
      "chroma_green",
      "chroma_blue",
      "cartoon",
      "cartoon3",
      "cartoon10",
    ]) {
      expect(isRecordingSkyboxId(skyboxId)).toBe(true);
      expect(normalizeRecordingSkyboxId(skyboxId)).toBe(skyboxId);
    }
    for (const skyboxId of ["xuejing", "egg1"]) {
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
    expect(BUILTIN_RECORDING_SKYBOX_IDS.slice(0, 2))
      .toEqual(["chroma_green", "chroma_blue"]);
    expect(sortBuiltinRecordingSkyboxes([
      { id: "cartoon10" },
      { id: "chroma_blue" },
      { id: "cartoon3" },
      { id: "chroma_green" },
      { id: "cartoon" },
      { id: "cartoon1" },
    ]).map(({ id }) => id)).toEqual([
      "chroma_green",
      "chroma_blue",
      "cartoon",
      "cartoon1",
      "cartoon3",
      "cartoon10",
    ]);
  });

  it("separates solid colors from the standard built-in skyboxes", () => {
    expect(SOLID_COLOR_RECORDING_SKYBOX_IDS).toEqual(["chroma_blue", "chroma_green"]);
    const groups = partitionBuiltinRecordingSkyboxes([
      { id: "cartoon3" },
      { id: "chroma_green" },
      { id: "cartoon" },
      { id: "chroma_blue" },
    ]);
    expect(groups.solidColor.map(({ id }) => id)).toEqual(["chroma_blue", "chroma_green"]);
    expect(groups.standard.map(({ id }) => id)).toEqual(["cartoon", "cartoon3"]);
  });

  it("resolves bundled preview paths and leaves removed or custom resources without one", () => {
    expect(recordingSkyboxPreviewUrl("chroma_green")).toBe("/skyboxes/chroma_green.webp");
    expect(recordingSkyboxPreviewUrl("chroma_blue")).toBe("/skyboxes/chroma_blue.webp");
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

  it("uses localized labels for both bundled chroma options", () => {
    const labels = {
      "record.skyboxChromaGreen": "绿色",
      "record.skyboxChromaBlue": "蓝色",
    };
    const t = (key) => labels[key] || key;
    expect(recordingSkyboxDisplayName("chroma_green", "backend green", t)).toBe("绿色");
    expect(recordingSkyboxDisplayName("chroma_blue", "backend blue", t)).toBe("蓝色");
  });
});
