import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, test, vi } from "vitest";
import { MemoryRouter } from "react-router-dom";
import CustomTitleBar from "./CustomTitleBar";
import { desktopBridge } from "../desktop/desktopBridge";

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

  test("does not repeat the current page title in the window chrome", () => {
    renderTitleBar();
    expect(screen.queryByText(/上手指南|Getting Started|Demo 分析|Analysis/)).toBeNull();
  });

  test("floats the window controls without reserving content height or showing a version", () => {
    renderTitleBar();
    expect(screen.queryByTestId("titlebar-version")).toBeNull();
    expect(screen.getByTestId("custom-titlebar").className).toContain("absolute");
  });
});
