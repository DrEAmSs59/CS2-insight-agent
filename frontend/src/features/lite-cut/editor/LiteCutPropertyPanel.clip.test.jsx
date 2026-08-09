/** @vitest-environment jsdom */
import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { ClipPane } from "./LiteCutPropertyPanel.jsx";

describe("LiteCut clip keyframe inspector", () => {
  it("shows editable transform keyframes beside their parameters", () => {
    const onAdd = vi.fn();
    render(
      <ClipPane
        media={{ id: "clip-1", title: "demo.mp4", kind: "video", duration: 5 }}
        isVideoLayer
        clipTransform={{ x: 0.5, y: 0.5, width: 1, height: 1, scale: 1, rotation: 0, opacity: 1 }}
        onClipTransformChange={() => {}}
        onAddClipKeyframe={onAdd}
      />,
    );

    expect(screen.getByText("变换与画面关键帧")).toBeTruthy();
    expect(screen.getByText("画面关键帧")).toBeTruthy();
    expect(screen.getByText(/位置、大小、缩放、旋转或透明度/)).toBeTruthy();
    expect(screen.getByText("位置")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "在播放头添加画面关键帧" }));
    expect(onAdd).toHaveBeenCalledTimes(1);
  });

  it("makes the current keyframe state explicit", () => {
    render(
      <ClipPane
        media={{ id: "clip-2", title: "demo.mp4", kind: "video", duration: 5 }}
        isVideoLayer
        clipHasKeyframe
        clipTransform={{ x: 0.5, y: 0.5, width: 1, height: 1, scale: 1, rotation: 0, opacity: 1 }}
        onClipTransformChange={() => {}}
      />,
    );

    expect(screen.getByText(/当前播放头已有关键帧/)).toBeTruthy();
    expect(screen.getByRole("button", { name: "删除当前画面关键帧" }).disabled).toBe(false);
  });
});
