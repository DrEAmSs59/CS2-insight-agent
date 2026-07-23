import { beforeEach, describe, expect, it } from "vitest";
import {
  applyLegacyElectronUiState,
  isLegacyUiStateKey,
} from "./legacyElectronUiState";

describe("legacy Electron UI state", () => {
  beforeEach(() => localStorage.clear());

  it("restores durable keys before stores initialize", () => {
    const restored = applyLegacyElectronUiState(JSON.stringify({
      version: 1,
      local_storage: {
        "cs2-insight-theme": "light",
        "liteCut:panelLayout": "{\"timeline\":50}",
        "liteCut:lastProjectId": "42",
        "liteCut:recovery:v1:42": "{\"version\":1}",
        "unrelated-key": "ignored",
      },
    }));

    expect(restored).toEqual([
      "cs2-insight-theme",
      "liteCut:panelLayout",
      "liteCut:lastProjectId",
      "liteCut:recovery:v1:42",
    ]);
    expect(localStorage.getItem("cs2-insight-theme")).toBe("light");
    expect(localStorage.getItem("unrelated-key")).toBeNull();
  });

  it("never overwrites state already created by Tauri", () => {
    localStorage.setItem("cs2-insight-theme", "dark");
    const restored = applyLegacyElectronUiState({
      version: 1,
      local_storage: { "cs2-insight-theme": "light" },
    });

    expect(restored).toEqual([]);
    expect(localStorage.getItem("cs2-insight-theme")).toBe("dark");
  });

  it("accepts only the explicit durable key set", () => {
    expect(isLegacyUiStateKey("liteCut:recovery:v1:7")).toBe(true);
    expect(isLegacyUiStateKey("liteCut:projectId")).toBe(false);
    expect(isLegacyUiStateKey("auth-token")).toBe(false);
  });
});
