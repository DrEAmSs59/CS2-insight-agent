/** @vitest-environment jsdom */
import { beforeEach, describe, expect, it } from "vitest";
import {
  clearLiteCutRecoveryDraft,
  readLiteCutRecoveryDraft,
  recoveryDraftDiffers,
  rememberedLiteCutProjectId,
  writeLiteCutRecoveryDraft,
} from "./recoveryUtils.js";

describe("LiteCut crash recovery storage", () => {
  beforeEach(() => localStorage.clear());

  it("keeps an emergency draft independently from the backend autosave", () => {
    expect(writeLiteCutRecoveryDraft({ projectId: 7, projectName: "Match", body: { tracks: [{ id: "v1" }] } })).toBe(true);
    expect(rememberedLiteCutProjectId()).toBe(7);
    expect(readLiteCutRecoveryDraft(7)).toMatchObject({ projectId: 7, projectName: "Match" });
    expect(recoveryDraftDiffers(readLiteCutRecoveryDraft(7), "Match", { tracks: [] })).toBe(true);
    clearLiteCutRecoveryDraft(7);
    expect(readLiteCutRecoveryDraft(7)).toBeNull();
  });
});
