import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, test, vi } from "vitest";
import { MemoryRouter } from "react-router-dom";
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

  const renderTitleBar = () => render(<MemoryRouter><CustomTitleBar /></MemoryRouter>);

  test("leaves drag-region double-click handling to the native window", async () => {
    renderTitleBar();
    await waitFor(() => expect(desktopBridge.isMaximized).toHaveBeenCalled());

    fireEvent.doubleClick(screen.getByTestId("custom-titlebar"));
    expect(desktopBridge.toggleMaximize).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole("button", { name: /最大化|Maximize/ }));
    expect(desktopBridge.toggleMaximize).toHaveBeenCalledTimes(1);
  });

  test("opens the desktop log directory from the title bar", () => {
    renderTitleBar();
    fireEvent.click(screen.getByRole("button", { name: /打开日志目录|Open log folder/ }));
    expect(API.post).toHaveBeenCalledWith("config/open-logs");
  });
});
