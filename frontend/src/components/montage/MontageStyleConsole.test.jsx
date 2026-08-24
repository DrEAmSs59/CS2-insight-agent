/** @vitest-environment jsdom */
import { act, fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import { MontageStyleConsole } from "./MontageStyleConsole.jsx";

const translate = (key, params = {}) => {
  if (key === "montage.consoleExportSummary") return `${params.clips} clips / ${params.duration}`;
  if (key === "montage.consoleExportBlockedCount") return `${params.n} blocked`;
  return key;
};

vi.mock("../../i18n/useT.js", () => ({ useT: () => translate }));

function renderConsole(overrides = {}, { openExport = true } = {}) {
  const props = {
    bgmPath: "",
    onBgmPathChange: vi.fn(),
    onBgmClear: vi.fn(),
    bgmVolume: 70,
    onBgmVolumeChange: vi.fn(),
    bgmStartSec: 0,
    onBgmStartSecChange: vi.fn(),
    introPath: "",
    onIntroPathChange: vi.fn(),
    onIntroClear: vi.fn(),
    introDuration: 3,
    onIntroDurationChange: vi.fn(),
    outroPath: "",
    onOutroPathChange: vi.fn(),
    onOutroClear: vi.fn(),
    outroDuration: 3,
    onOutroDurationChange: vi.fn(),
    clipCount: 0,
    durationText: "00:00",
    resolutionLabel: "MP4",
    exporting: false,
    onExport: vi.fn(),
    exportReady: false,
    fullOutputPathPreview: "",
    outputFilename: "montage.mp4",
    onOutputFilenameChange: vi.fn(),
    defaultFilenamePlaceholder: "montage.mp4",
    outputDir: "",
    onOutputDirChange: vi.fn(),
    onOutputDirCommit: vi.fn(),
    onOutputDirBrowse: vi.fn(),
    onOutputDirClear: vi.fn(),
    effectiveOutputDirHint: "",
    clips: [],
    playerAvatars: {},
    nameCardsEnabled: false,
    onPlayerAvatarChange: vi.fn(),
    onNameCardsEnabledChange: vi.fn(),
    framemeldEnabled: false,
    framemeldRuntimeAvailable: false,
    onFrameMeldEnabledChange: vi.fn(),
    ...overrides,
  };

  render(<MontageStyleConsole {...props} />);
  if (openExport) fireEvent.click(screen.getByRole("button", { name: "montage.consoleTabExport" }));
  return props;
}

describe("MontageStyleConsole export layout", () => {
  it("uses the shared orange data-bar style for BGM volume", () => {
    renderConsole({}, { openExport: false });

    const slider = screen.getByRole("slider");
    expect(slider.className).toContain("cs2-data-slider");
    expect(slider.style.getPropertyValue("--cs2-range-progress")).toBe("70%");
    expect(slider.style.getPropertyValue("--cs2-range-accent")).toBe("var(--cs2-accent)");
    expect(screen.getByText("70%").className).toContain("text-cs2-accent");
    expect(document.querySelector(".lucide-music").getAttribute("class")).toContain("text-cs2-accent");
  });

  it("keeps the primary export action disabled while required items are missing", () => {
    const props = renderConsole();

    const pendingSummary = screen.getByText("montage.consoleExportSummaryPending");
    expect(pendingSummary).toBeTruthy();
    expect(pendingSummary.className).toContain("text-cs2-accent");
    const pendingSection = pendingSummary.closest("section");
    expect(pendingSection.className).toContain("bg-cs2-accent-soft");
    const pendingTag = Array.from(pendingSection.querySelectorAll("span")).find((node) => node.textContent === "1/3");
    expect(pendingTag.className).toContain("text-cs2-accent");
    expect(screen.getByText("montage.consoleExportAdvancedTitle")).toBeTruthy();
    expect(screen.queryByText("montage.consoleExportDraftSectionTitle")).toBeNull();
    expect(screen.getByRole("button", { name: "montage.consoleExportStartBtn" }).disabled).toBe(true);
    expect(screen.queryByText("montage.consoleExportPathPreviewLabel")).toBeNull();

    fireEvent.blur(screen.getByPlaceholderText("montage.consoleExportDirPlaceholder"));
    expect(props.onOutputDirCommit).toHaveBeenCalledTimes(1);
    fireEvent.click(screen.getByRole("button", { name: "montage.consoleExportDirBrowse" }));
    expect(props.onOutputDirBrowse).toHaveBeenCalledTimes(1);
  });

  it("enables export when ready and only then shows a real output path", () => {
    renderConsole({
      clipCount: 2,
      durationText: "00:24",
      exportReady: true,
      effectiveOutputDirHint: "I:\\exports\\montage",
      fullOutputPathPreview: "I:\\exports\\montage\\montage.mp4",
    });

    expect(screen.getByText("montage.consoleExportSummaryReady")).toBeTruthy();
    expect(screen.getByTitle("I:\\exports\\montage\\montage.mp4")).toBeTruthy();
    expect(screen.getByRole("button", { name: "montage.consoleExportStartBtn" }).disabled).toBe(false);
  });

  it("greys out FrameMeld and explains when project frame rates cross the boundary", () => {
    renderConsole({
      clips: [{ id: 1, fps: 60 }, { id: 2, fps: 120 }],
      framemeldEnabled: true,
      framemeldRuntimeAvailable: true,
    });

    const frameMeldButton = screen.getByRole("button", { name: "montage.consoleFrameMeldTitle" });
    expect(frameMeldButton.disabled).toBe(true);
    expect(frameMeldButton.getAttribute("aria-pressed")).toBe("false");
    expect(screen.getByText("montage.consoleFrameMeldBlockedMixedFps")).toBeTruthy();
  });

  it("enables FrameMeld only after the shared confirmation delay", () => {
    vi.useFakeTimers();
    try {
      const props = renderConsole({
        clips: [{ id: 1, fps: 120 }],
        framemeldRuntimeAvailable: true,
      });

      fireEvent.click(screen.getByRole("button", { name: "montage.consoleFrameMeldTitle" }));
      expect(screen.getByRole("dialog")).toBeTruthy();
      expect(props.onFrameMeldEnabledChange).not.toHaveBeenCalled();

      act(() => vi.advanceTimersByTime(3000));
      fireEvent.click(screen.getByRole("button", { name: "frameMeld.enableDialog.confirm" }));
      expect(props.onFrameMeldEnabledChange).toHaveBeenCalledWith(true);
    } finally {
      vi.useRealTimers();
    }
  });

  it("turns off an active FrameMeld option without opening the warning", () => {
    const props = renderConsole({
      clips: [{ id: 1, fps: 120 }],
      framemeldEnabled: true,
      framemeldRuntimeAvailable: true,
    });

    fireEvent.click(screen.getByRole("button", { name: "montage.consoleFrameMeldTitle" }));
    expect(props.onFrameMeldEnabledChange).toHaveBeenCalledWith(false);
    expect(screen.queryByRole("dialog")).toBeNull();
  });
});
