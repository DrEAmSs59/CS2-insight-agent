import { render, screen } from "@testing-library/react";
import { expect, test, vi } from "vitest";
import StartupLoadingOverlay from "./StartupLoadingOverlay.jsx";
import { useLocaleStore } from "../i18n/localeStore.js";

test("startup checks share one randomly chosen CS2 animation until startup finishes", () => {
  useLocaleStore.setState({ locale: "zh", effectiveLocale: "zh" });
  const random = vi.spyOn(Math, "random").mockReturnValue(0.99);
  try {
    const view = render(<StartupLoadingOverlay phase="backend" />);
    const animation = view.container.querySelector("img");
    expect(animation.getAttribute("src")).toContain("loaders/team-emblems.svg");
    expect(screen.getByRole("heading", { name: /等待后端连接/ })).toBeTruthy();
    view.rerender(<StartupLoadingOverlay phase="update" />);
    expect(screen.getByRole("heading", { name: /检查.*更新/ })).toBeTruthy();
    expect(view.container.querySelector("img")).toBe(animation);
    view.rerender(<StartupLoadingOverlay phase="config" />);
    expect(screen.getByRole("heading", { name: /检查.*配置/ })).toBeTruthy();
    expect(view.container.querySelector("img")).toBe(animation);
    view.rerender(<StartupLoadingOverlay phase={null} />);
    expect(screen.queryByRole("status")).toBeNull();
  } finally { random.mockRestore(); }
});
