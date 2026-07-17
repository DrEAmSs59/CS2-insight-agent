/** @vitest-environment jsdom */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import LiteCutToolbar from "./LiteCutToolbar.jsx";
import { useLocaleStore } from "../../../i18n/localeStore.js";

function renderToolbar(props = {}) {
  return render(
    <MemoryRouter>
      <LiteCutToolbar
        projectId={7}
        projectName="Test project"
        body={{ tracks: [] }}
        projectTemplates={[{ id: "vertical", label: "Vertical short", detail: "9:16 project" }]}
        onRefreshProjects={vi.fn()}
        {...props}
      />
    </MemoryRouter>,
  );
}

describe("LiteCutToolbar", () => {
  beforeEach(() => useLocaleStore.getState().hydrate("zh"));

  it("opens the project manager above the editor workspace", () => {
    renderToolbar();

    fireEvent.click(screen.getByTitle("打开工程管理"));
    expect(screen.getByRole("dialog", { name: "工程管理" })).toBeTruthy();
  });

  it("shows project templates without clipping the menu", () => {
    renderToolbar();

    fireEvent.click(screen.getByRole("button", { name: "从模板创建" }));
    expect(screen.getByText("Vertical short")).toBeTruthy();
    expect(screen.getByText("9:16 project")).toBeTruthy();
  });

  it("opens a parameterized dialog before creating a blank project", () => {
    renderToolbar();

    fireEvent.click(screen.getByTitle("新建空白工程"));
    expect(screen.getByRole("dialog", { name: "新建 LiteCut 工程" })).toBeTruthy();
    expect(screen.getByLabelText("画布宽度").value).toBe("1920");
    expect(screen.getByLabelText("画布高度").value).toBe("1080");
    expect(screen.getByLabelText("视频帧率").value).toBe("60");
  });

  it("always opens the export inspector instead of relying on route navigation", () => {
    const onOpenExport = vi.fn();
    renderToolbar({ onOpenExport });

    fireEvent.click(screen.getByRole("button", { name: "导出" }));

    expect(onOpenExport).toHaveBeenCalledTimes(1);
  });
});
