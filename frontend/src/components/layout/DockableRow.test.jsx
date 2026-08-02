import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, test } from "vitest";
import { useLocaleStore } from "../../i18n/localeStore.js";
import DockableRow, {
  createDockLayout,
  normalizeDockLayout,
  resizeDockPair,
  swapDockPanels,
} from "./DockableRow";

const panels = [
  { id: "left", label: "左侧", minSize: 100, defaultSize: 300, content: <div>左侧内容</div> },
  { id: "center", label: "中间", minSize: 200, defaultSize: 700, content: <div>中间内容</div> },
  { id: "right", label: "右侧", minSize: 100, defaultSize: 300, content: <div>右侧内容</div> },
];

describe("DockableRow", () => {
  beforeEach(() => {
    localStorage.clear();
    useLocaleStore.setState({ locale: "zh", effectiveLocale: "zh", hydrated: true, persistenceError: null });
  });

  test("normalizes stale persisted layouts without losing valid preferences", () => {
    const normalized = normalizeDockLayout({
      version: 1,
      order: ["right", "missing", "right", "left"],
      sizes: { right: 444, left: -1 },
      collapsed: { right: true },
    }, panels);

    expect(normalized.order).toEqual(["right", "left", "center"]);
    expect(normalized.sizes.right).toBe(444);
    expect(normalized.sizes.left).toBe(300);
    expect(normalized.collapsed.right).toBe(true);
  });

  test("forces non-collapsible panels open when restoring an older layout", () => {
    const normalized = normalizeDockLayout({
      version: 1,
      order: ["left", "center", "right"],
      sizes: { left: 300, center: 700, right: 300 },
      collapsed: { left: true, center: true, right: true },
    }, panels.map((panel) => (
      panel.id === "center" ? { ...panel, collapsible: false } : panel
    )));

    expect(normalized.collapsed.left).toBe(true);
    expect(normalized.collapsed.center).toBe(false);
    expect(normalized.collapsed.right).toBe(true);
  });

  test("resizes a neighboring pair with minimum widths and preserves its total weight", () => {
    const initial = createDockLayout(panels);
    const resized = resizeDockPair(initial, {
      leftId: "left",
      rightId: "center",
      deltaPx: 1000,
      leftPx: 300,
      rightPx: 700,
      leftMinPx: 100,
      rightMinPx: 300,
    });

    expect(resized.sizes.left).toBe(700);
    expect(resized.sizes.center).toBe(300);
    expect(resized.sizes.left + resized.sizes.center).toBe(1000);
    expect(swapDockPanels(initial, "left", "right").order).toEqual(["right", "center", "left"]);
  });

  test("collapses, reorders and automatically restores the saved layout", async () => {
    const first = render(
      <DockableRow storageKey="test-workspace" panels={panels} editMode ariaLabel="测试布局" />,
    );

    fireEvent.click(screen.getByRole("button", { name: "折叠左侧" }));
    fireEvent.click(screen.getByRole("button", { name: "将右侧向左移动" }));
    expect([...first.container.querySelectorAll("[data-dock-panel]")].map((node) => node.getAttribute("data-dock-panel")))
      .toEqual(["left", "right", "center"]);
    expect(screen.getByRole("button", { name: "展开左侧" })).toBeTruthy();
    await waitFor(() => expect(localStorage.getItem("cs2-insight:dock-layout:test-workspace")).toContain('"right"'));

    first.unmount();
    const restored = render(
      <DockableRow storageKey="test-workspace" panels={panels} editMode={false} ariaLabel="测试布局" />,
    );
    expect([...restored.container.querySelectorAll("[data-dock-panel]")].map((node) => node.getAttribute("data-dock-panel")))
      .toEqual(["left", "right", "center"]);
    expect(screen.getByRole("button", { name: "展开左侧" })).toBeTruthy();
  });
});
