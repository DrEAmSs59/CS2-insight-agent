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
    expect(screen.getByText("已用时间 00:00")).toBeTruthy();
    expect(screen.queryByLabelText("关闭导出窗口")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "取消导出" }));
    expect(onCancel).toHaveBeenCalledTimes(1);
  });

  it("shows live Blur frame progress and an estimated remaining time", () => {
    render(<LiteCutExportProgressDialog phase="running" result={{
      export_id: 3,
      stage: "framemeld",
      progress: 0.75,
      elapsed_seconds: 125,
      estimated_remaining_seconds: 64,
      processed_frames: 3000,
      total_frames: 7500,
    }} onCancel={vi.fn()} />);

    expect(screen.getByText(/FrameMeld 自动运动渲染/)).toBeTruthy();
    expect(screen.getByText("已用时间 02:05")).toBeTruthy();
    expect(screen.getByText("预计剩余 01:04")).toBeTruthy();
    expect(screen.getByText("Blur 帧进度 3000 / 7500")).toBeTruthy();
  });

  it("shows the unified completion modal", () => {
    render(<LiteCutExportProgressDialog phase="done" result={{ output_path: "C:\\exports\\clip.mp4", progress: 1 }} onClose={vi.fn()} />);

    expect(screen.getByText("导出完成")).toBeTruthy();
    expect(screen.getByText("clip.mp4")).toBeTruthy();
  });

  it("reuses the progress UI and cancellation action for Montage", () => {
    const onCancel = vi.fn();
    render(<LiteCutExportProgressDialog
      variant="montage"
      phase="running"
      result={{ export_id: 18, stage: "finalizing", progress: 0.8 }}
      onClose={vi.fn()}
      onCancel={onCancel}
    />);

    expect(screen.getByText("正在导出合辑…")).toBeTruthy();
    expect(screen.getByText(/封装成片/)).toBeTruthy();
    expect(screen.getByText("80%")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "取消导出" }));
    expect(onCancel).toHaveBeenCalledTimes(1);
  });
});
