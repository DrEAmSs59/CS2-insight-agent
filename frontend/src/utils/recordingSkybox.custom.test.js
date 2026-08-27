import { describe, expect, it } from "vitest";

import {
  isCustomRecordingSkyboxId,
  isRecordingSkyboxId,
  normalizeRecordingSkyboxId,
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
});
