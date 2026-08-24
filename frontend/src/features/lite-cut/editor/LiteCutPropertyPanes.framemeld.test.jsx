/** @vitest-environment jsdom */
import { act, fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import { ExportPane } from "./LiteCutPropertyPanes.jsx";

vi.mock("../../../i18n/useT.js", () => ({
  useT: () => (key) => key,
}));

function renderExportPane(overrides = {}) {
  const props = {
    outputDir: "I:\\exports",
    outputDirHint: "",
    filename: "clip.mp4",
    framemeldEnabled: false,
    framemeldRuntimeAvailable: true,
    framemeldSourceItems: [{ fps: 120 }],
    rangeValid: true,
    clipCount: 1,
    onOutputSettingsChange: vi.fn(),
    ...overrides,
  };
  render(<ExportPane {...props} />);
  return props;
}

describe("LiteCut ExportPane FrameMeld confirmation", () => {
  it("does not patch the project until the delayed confirmation is accepted", () => {
    vi.useFakeTimers();
    try {
      const props = renderExportPane();
      fireEvent.click(screen.getByRole("button", { name: "liteCut.frameMeldTitle" }));

      expect(screen.getByRole("dialog")).toBeTruthy();
      expect(props.onOutputSettingsChange).not.toHaveBeenCalled();
      expect(screen.getByRole("button", { name: "frameMeld.enableDialog.confirmCountdown" }).disabled).toBe(true);

      act(() => vi.advanceTimersByTime(3000));
      fireEvent.click(screen.getByRole("button", { name: "frameMeld.enableDialog.confirm" }));
      expect(props.onOutputSettingsChange).toHaveBeenCalledWith({ framemeld_enabled: true });
    } finally {
      vi.useRealTimers();
    }
  });

  it("leaves FrameMeld disabled when the warning is cancelled", () => {
    const props = renderExportPane();
    fireEvent.click(screen.getByRole("button", { name: "liteCut.frameMeldTitle" }));
    fireEvent.click(screen.getByRole("button", { name: "frameMeld.enableDialog.cancel" }));
    expect(props.onOutputSettingsChange).not.toHaveBeenCalled();
    expect(screen.queryByRole("dialog")).toBeNull();
  });
});
