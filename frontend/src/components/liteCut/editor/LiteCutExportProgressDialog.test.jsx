/** @vitest-environment jsdom */
import { describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";
import LiteCutExportProgressDialog from "./LiteCutExportProgressDialog.jsx";

describe("LiteCutExportProgressDialog", () => {
  it("keeps an active export in a modal and exposes cancellation", () => {
    const onCancel = vi.fn();
    render(<LiteCutExportProgressDialog phase="running" result={{ export_id: 7, stage: "overlays", progress: 0.42 }} onCancel={onCancel} />);

    expect(screen.getByRole("dialog", { name: "导出进度" })).toBeTruthy();
    expect(screen.getByText("42%")).toBeTruthy();
    expect(screen.queryByLabelText("关闭导出窗口")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "取消导出" }));
    expect(onCancel).toHaveBeenCalledTimes(1);
  });

  it("shows the unified completion modal", () => {
    render(<LiteCutExportProgressDialog phase="done" result={{ output_path: "C:\\exports\\clip.mp4", progress: 1 }} onClose={vi.fn()} />);

    expect(screen.getByText("导出完成")).toBeTruthy();
    expect(screen.getByText("clip.mp4")).toBeTruthy();
  });
});
