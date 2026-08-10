/** @vitest-environment jsdom */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import LiteCutProjectDrawer from "./LiteCutProjectDrawer.jsx";
import { useLocaleStore } from "../../../i18n/localeStore.js";

const project = {
  id: 24,
  name: "Mirage highlights",
  updated_at: "2026-06-22T08:00:00Z",
};

function renderDrawer() {
  return render(
    <LiteCutProjectDrawer
      open
      projectId={24}
      projectName={project.name}
      body={{ tracks: [{ clips: [{ id: "clip-a" }] }, { clips: [] }] }}
      projects={[project]}
      projectTemplates={[{ id: "shorts", label: "Shorts", detail: "9:16" }]}
    />,
  );
}

describe("LiteCutProjectDrawer", () => {
  beforeEach(() => {
    useLocaleStore.getState().hydrate("zh");
  });

  it("renders the project workspace and current project summary in Chinese", () => {
    renderDrawer();

    expect(screen.getByRole("dialog").className).toContain("max-w-5xl");
    expect(screen.getByText("工程管理")).toBeTruthy();
    expect(screen.getByText("当前工程")).toBeTruthy();
    expect(screen.getByText("新建空白工程")).toBeTruthy();
    expect(screen.getByText("导入工程JSON")).toBeTruthy();
    expect(screen.getByText("导出工程JSON")).toBeTruthy();
    expect(screen.getByText("工程 #24 · 2 条轨道 · 1 个片段")).toBeTruthy();
    expect(screen.getByDisplayValue("Mirage highlights")).toBeTruthy();
    expect(screen.getByLabelText("视频帧率").value).toBe("60");
  });

  it("uses the existing locale store for English project text", () => {
    useLocaleStore.getState().hydrate("en");
    renderDrawer();

    expect(screen.getByText("Project manager")).toBeTruthy();
    expect(screen.getByText("Current project")).toBeTruthy();
    expect(screen.getByPlaceholderText("Search project names")).toBeTruthy();
  });

  it("uses theme-aware solid surfaces for light and dark mode", () => {
    renderDrawer();

    const dialog = screen.getByRole("dialog");
    const currentProject = screen.getByText("当前工程").closest("section");
    const savedState = screen.getByText("已保存");
    const template = screen.getByText("Shorts").closest("button");

    expect(dialog.className).toContain("bg-cs2-bg-card");
    expect(currentProject.className).toContain("bg-cs2-bg-input");
    expect(currentProject.className).not.toContain("bg-cs2-accent-soft/30");
    expect(savedState.className).toContain("text-cs2-emerald-on-surface");
    expect(template.className).toContain("bg-cs2-bg-input");
    expect(dialog.innerHTML).not.toContain("text-emerald-300");
    expect(dialog.innerHTML).not.toContain("hover:text-white");
  });

  it("closes the foreground project page with Escape", () => {
    const onClose = vi.fn();
    render(
      <LiteCutProjectDrawer
        open
        projectId={24}
        projectName={project.name}
        body={{ tracks: [] }}
        projects={[project]}
        onClose={onClose}
      />,
    );

    fireEvent.keyDown(document, { key: "Escape" });
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("selects multiple projects and deletes them in one batch", async () => {
    const onDeleteProjects = vi.fn().mockResolvedValue({ ok: true, deleted: 2 });
    vi.spyOn(window, "confirm").mockReturnValue(true);
    render(
      <LiteCutProjectDrawer
        open
        projectId={24}
        projectName={project.name}
        body={{ tracks: [] }}
        projects={[project, { id: 25, name: "Inferno", updated_at: "2026-06-23T08:00:00Z" }]}
        onDeleteProjects={onDeleteProjects}
      />,
    );

    fireEvent.click(screen.getByLabelText("选择工程 Mirage highlights"));
    fireEvent.click(screen.getByLabelText("选择工程 Inferno"));
    fireEvent.click(screen.getByText("删除所选 (2)"));

    await waitFor(() => expect(onDeleteProjects).toHaveBeenCalledWith([24, 25]));
  });
});
