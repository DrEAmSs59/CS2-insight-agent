/** @vitest-environment jsdom */
import { act, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import FrameMeldEnableDialog from "./FrameMeldEnableDialog.jsx";

const translations = {
  "frameMeld.enableDialog.title": "帧混合（动态模糊）启用说明",
  "frameMeld.enableDialog.item2Prefix": "由于补帧非常依赖高性能显卡，",
  "frameMeld.enableDialog.item2Emphasis": "导出速度会有非常明显的下降。",
  "frameMeld.enableDialog.item7": "建议先用短片段测试效果和预计耗时。",
  "frameMeld.enableDialog.item8": "推荐使用 FrameMeld_ffmpeg V0.1.3 及以上版本的 ffmpeg。",
  "frameMeld.enableDialog.benchmarkTitle": "*部分显卡性能指标参考：",
  "frameMeld.enableDialog.benchmark5070Ti": "NVIDIA Geforce RTX 5070Ti：1080P分辨率（1920×1080）补帧速率≈10.571帧/秒",
  "frameMeld.enableDialog.cancel": "取消",
  "frameMeld.enableDialog.confirm": "确认",
};

vi.mock("../i18n/useT.js", () => ({
  useT: () => (key, params = {}) => {
    if (key === "frameMeld.enableDialog.confirmCountdown") return `确认（${params.seconds}秒）`;
    return translations[key] || key;
  },
}));

afterEach(() => {
  vi.useRealTimers();
});

describe("FrameMeldEnableDialog", () => {
  it("emphasizes the requested warnings and uses multiplication signs in resolutions", () => {
    render(<FrameMeldEnableDialog open onConfirm={vi.fn()} onCancel={vi.fn()} />);

    expect(screen.getByText("导出速度会有非常明显的下降。").className).toContain("text-red-400");
    expect(screen.getByText("建议先用短片段测试效果和预计耗时。").closest("li").className).toContain("font-bold");
    expect(screen.getByText("推荐使用 FrameMeld_ffmpeg V0.1.3 及以上版本的 ffmpeg。")).toBeTruthy();
    expect(screen.getByText("*部分显卡性能指标参考：").className).toContain("text-red-400");
    expect(screen.getByText(/1920×1080/)).toBeTruthy();
  });

  it("keeps confirmation disabled for three seconds", () => {
    vi.useFakeTimers();
    const onConfirm = vi.fn();
    render(<FrameMeldEnableDialog open onConfirm={onConfirm} onCancel={vi.fn()} />);

    const delayedConfirm = screen.getByRole("button", { name: "确认（3秒）" });
    expect(delayedConfirm.disabled).toBe(true);
    fireEvent.click(delayedConfirm);
    expect(onConfirm).not.toHaveBeenCalled();

    act(() => vi.advanceTimersByTime(3000));
    const confirm = screen.getByRole("button", { name: "确认" });
    expect(confirm.disabled).toBe(false);
    fireEvent.click(confirm);
    expect(onConfirm).toHaveBeenCalledTimes(1);
  });

  it("allows cancellation immediately", () => {
    const onCancel = vi.fn();
    render(<FrameMeldEnableDialog open onConfirm={vi.fn()} onCancel={onCancel} />);
    fireEvent.click(screen.getByRole("button", { name: "取消" }));
    expect(onCancel).toHaveBeenCalledTimes(1);
  });
});
