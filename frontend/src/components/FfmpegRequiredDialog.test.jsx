import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import FfmpegRequiredDialog from "./FfmpegRequiredDialog.jsx";

const bridge = vi.hoisted(() => ({ openExternal: vi.fn(async () => {}) }));
vi.mock("../desktop/desktopBridge.js", () => ({ desktopBridge: bridge }));
vi.mock("../i18n/useT.js", () => ({ useT: () => (key) => key }));

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  bridge.openExternal = vi.fn(async () => {});
});

const downloads = [
  ["dialog.ffmpegDownloadPage", "https://ciacut.cc"],
];

describe("FfmpegRequiredDialog download pages", () => {
  it.each(downloads)("opens %s in the desktop browser without leaving the dialog", (label, url) => {
    const onGoSettings = vi.fn();
    render(<FfmpegRequiredDialog message="FFmpeg not configured" onGoSettings={onGoSettings} />);
    fireEvent.click(screen.getByRole("button", { name: label }));
    expect(bridge.openExternal).toHaveBeenCalledWith(url);
    expect(onGoSettings).not.toHaveBeenCalled();
    expect(screen.getByRole("dialog")).toBeTruthy();
  });

  it.each(downloads)("opens %s in a new browser tab on the web frontend", (label, url) => {
    bridge.openExternal = undefined;
    const open = vi.spyOn(window, "open").mockImplementation(() => null);
    render(<FfmpegRequiredDialog message="FFmpeg not configured" />);
    fireEvent.click(screen.getByRole("button", { name: label }));
    expect(open).toHaveBeenCalledWith(url, "_blank", "noopener,noreferrer");
  });
});
