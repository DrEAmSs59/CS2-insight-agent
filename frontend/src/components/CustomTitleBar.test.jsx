import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, test, vi } from "vitest";
import CustomTitleBar from "./CustomTitleBar";
import API from "../api/api";
import { desktopBridge } from "../desktop/desktopBridge";


vi.mock("../api/api", () => ({
  default: { post: vi.fn().mockResolvedValue({ data: { ok: true } }) },
}));

vi.mock("../desktop/desktopBridge", () => ({
  isDesktopApp: true,
  desktopBridge: {
    minimize: vi.fn().mockResolvedValue(undefined),
    toggleMaximize: vi.fn().mockResolvedValue(undefined),
    close: vi.fn().mockResolvedValue(undefined),
    isMaximized: vi.fn().mockResolvedValue(false),
    onMaximizeChange: vi.fn(() => vi.fn()),
  },
}));

describe("CustomTitleBar", () => {
  beforeEach(() => vi.clearAllMocks());

  test("leaves drag-region double-click handling to the native window", async () => {
    render(<CustomTitleBar />);
    await waitFor(() => expect(desktopBridge.isMaximized).toHaveBeenCalled());

    fireEvent.doubleClick(screen.getByTestId("custom-titlebar"));
    expect(desktopBridge.toggleMaximize).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole("button", { name: "Toggle maximize" }));
    expect(desktopBridge.toggleMaximize).toHaveBeenCalledTimes(1);
  });

  test("opens the desktop log directory from the title bar", () => {
    render(<CustomTitleBar />);
    fireEvent.click(screen.getByRole("button", { name: "打开日志目录" }));
    expect(API.post).toHaveBeenCalledWith("config/open-logs");
  });
});
