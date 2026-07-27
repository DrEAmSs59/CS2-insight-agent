import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, test, vi } from "vitest";
import { MemoryRouter } from "react-router-dom";
import API from "../api/api";
import SidebarNav from "./SidebarNav";

vi.mock("../api/api", () => ({
  default: { post: vi.fn().mockResolvedValue({ data: { ok: true } }) },
}));

describe("SidebarNav", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    localStorage.clear();
  });

  const renderSidebar = (props = {}) => render(
    <MemoryRouter initialEntries={["/analysis"]}>
      <SidebarNav {...props} />
    </MemoryRouter>,
  );

  test("renders the primary workflow and persists its collapsed state", async () => {
    renderSidebar({ queueLength: 3 });
    const sidebar = screen.getByTestId("app-sidebar");

    expect(screen.getByRole("link", { name: /上手指南|Getting Started/ })).toBeTruthy();
    expect(screen.getByRole("link", { name: /Demo 库|Demo Library/ })).toBeTruthy();
    expect(screen.getByRole("link", { name: /Demo 分析|Analysis/ })).toBeTruthy();
    expect(screen.getByRole("link", { name: /录制队列|Record Queue/ }).textContent).toContain("3");

    fireEvent.click(screen.getByRole("button", { name: /收起侧栏|Collapse sidebar/ }));
    expect(sidebar.getAttribute("data-collapsed")).toBe("true");
    expect(sidebar.style.width).toBe("56px");
    await waitFor(() => expect(localStorage.getItem("cs2-insight:sidebar-layout-v2")).toContain('"collapsed":true'));
  });

  test("supports pointer, keyboard, and reset resizing", async () => {
    renderSidebar();
    const sidebar = screen.getByTestId("app-sidebar");
    const separator = screen.getByRole("separator", { name: /调整侧栏宽度|Resize sidebar/ });

    fireEvent(separator, new MouseEvent("pointerdown", { bubbles: true, clientX: 224 }));
    fireEvent(document, new MouseEvent("pointermove", { bubbles: true, clientX: 284 }));
    fireEvent(document, new MouseEvent("pointerup", { bubbles: true, clientX: 284 }));
    await waitFor(() => expect(sidebar.style.width).toBe("284px"));

    fireEvent.keyDown(separator, { key: "ArrowRight" });
    expect(sidebar.style.width).toBe("300px");

    fireEvent.doubleClick(separator);
    expect(sidebar.style.width).toBe("224px");
  });

  test("keeps utility actions in the sidebar", async () => {
    renderSidebar();
    fireEvent.click(screen.getByRole("button", { name: /打开日志目录|Open log folder/ }));
    await waitFor(() => expect(API.post).toHaveBeenCalledWith("config/open-logs"));
  });
});
