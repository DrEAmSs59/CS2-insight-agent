/** @vitest-environment jsdom */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { act, fireEvent, render, screen } from "@testing-library/react";
import LiteCutProjectStartPage from "./LiteCutProjectStartPage.jsx";
import { useLocaleStore } from "../../../i18n/localeStore.js";

describe("LiteCutProjectStartPage", () => {
  beforeEach(() => useLocaleStore.getState().hydrate("zh"));
  it("opens an existing project only after the user chooses it", async () => {
    const onOpenProject = vi.fn();
    render(
      <LiteCutProjectStartPage
        projects={[{ id: 12, name: "Dust2 highlights", updated_at: "2026-07-05T10:00:00Z" }]}
        onOpenProject={onOpenProject}
      />,
    );

    expect(onOpenProject).not.toHaveBeenCalled();
    await act(async () => fireEvent.click(screen.getByRole("button", { name: /Dust2 highlights/ })));
    expect(onOpenProject).toHaveBeenCalledWith(12);
  });

  it("deletes a recent project through the existing confirmed delete flow", async () => {
    useLocaleStore.getState().hydrate("en");
    const onOpenProject = vi.fn();
    const onDeleteProject = vi.fn().mockResolvedValue({ ok: true });
    vi.spyOn(window, "confirm").mockReturnValue(true);
    render(
      <LiteCutProjectStartPage
        projects={[{ id: 12, name: "Dust2 highlights", updated_at: "2026-07-05T10:00:00Z" }]}
        onOpenProject={onOpenProject}
        onDeleteProject={onDeleteProject}
      />,
    );

    await act(async () => fireEvent.click(screen.getByRole("button", { name: "Delete project" })));

    expect(window.confirm).toHaveBeenCalledWith("Delete project “Dust2 highlights”?");
    expect(onDeleteProject).toHaveBeenCalledWith(12, true);
    expect(onOpenProject).not.toHaveBeenCalled();
  });

  it("opens the project settings dialog instead of creating immediately", () => {
    const onNewProject = vi.fn();
    render(<LiteCutProjectStartPage projects={[]} onNewProject={onNewProject} />);

    fireEvent.click(screen.getByRole("button", { name: /新建工程/ }));
    expect(screen.getByRole("dialog", { name: "新建 LiteCut 工程" })).toBeTruthy();
    expect(onNewProject).not.toHaveBeenCalled();
  });

  it("creates a project with a custom high frame rate", async () => {
    const onNewProject = vi.fn().mockResolvedValue({ ok: true });
    render(<LiteCutProjectStartPage projects={[]} onNewProject={onNewProject} />);

    fireEvent.click(screen.getByRole("button", { name: /新建工程/ }));
    fireEvent.change(screen.getByLabelText("视频帧率"), { target: { value: "480" } });
    await act(async () => fireEvent.click(screen.getByRole("button", { name: "创建工程" })));

    expect(onNewProject).toHaveBeenCalledWith(expect.objectContaining({
      isCustomProject: true,
      fps: 480,
    }));
  });

  it("explains that retired project schemas are intentionally unsupported", () => {
    render(<LiteCutProjectStartPage projects={[]} error="LITECUT_PROJECT_VERSION_UNSUPPORTED" />);
    expect(screen.getByRole("alert").textContent).toContain("当前版本不会迁移或兼容它");
  });
});
