/** @vitest-environment jsdom */
import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import LiteCutPropertyPanel, { CanvasPane, ExportPane } from "./LiteCutPropertyPanel.jsx";

describe("LiteCut canvas inspector", () => {
  it("places Canvas before Clip in the property tabs", () => {
    const { container } = render(<LiteCutPropertyPanel defaultTab="canvas" />);
    const tabs = container.querySelector("[data-litecut-inspector-tabs]");

    expect(tabs.querySelectorAll("button")).toHaveLength(6);
    expect(tabs.querySelector("button").getAttribute("title")).toMatch(/Canvas|画布/);
    expect(screen.getByText(/Project canvas, fitting, and background|工程画布、适配与背景/)).toBeTruthy();
  });

  it("edits the project size and canvas fitting", () => {
    const onOutputSettingsChange = vi.fn();
    render(
      <CanvasPane
        width={1080}
        height={1920}
        canvasFit="contain"
        onOutputSettingsChange={onOutputSettingsChange}
      />,
    );

    expect(screen.getAllByText("9:16")).toHaveLength(2);
    expect(screen.getByText("1080 × 1920")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "16:9" }));
    expect(onOutputSettingsChange).toHaveBeenCalledWith({ width: 1920, height: 1080 });
    fireEvent.change(screen.getByLabelText("画布宽度"), { target: { value: "1440" } });
    fireEvent.blur(screen.getByLabelText("画布宽度"));
    expect(onOutputSettingsChange).toHaveBeenCalledWith({ width: 1440 });
    fireEvent.click(screen.getByRole("button", { name: /填满/ }));
    expect(onOutputSettingsChange).toHaveBeenCalledWith({ canvas_fit: "cover" });
  });

  it("keeps canvas controls out of the export pane", () => {
    render(<ExportPane outputDir="D:\\exports" filename="clip.mp4" clipCount={1} />);

    expect(screen.queryByText("画布适配")).toBeNull();
    expect(screen.queryByLabelText("画布底色")).toBeNull();
    expect(screen.getByText("导出规格")).toBeTruthy();
  });
});
