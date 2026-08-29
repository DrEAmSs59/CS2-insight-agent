/** @vitest-environment jsdom */
import { fireEvent, render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { useLocaleStore } from "../../i18n/localeStore.js";
import RecordingProgressModal from "./RecordingProgressModal.jsx";

describe("RecordingProgressModal", () => {
  beforeEach(() => {
    useLocaleStore.getState().hydrate("zh");
  });

  it("shows live recording state and exposes the abort action", () => {
    const onAbort = vi.fn();
    render(
      <RecordingProgressModal
        open
        queueLength={3}
        onAbort={onAbort}
      />,
    );

    expect(screen.getByRole("dialog")).toBeTruthy();
    expect(screen.getByText("正在准备所需的地图资源，稍后将自动进入CS2。")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "中止录制" }));
    expect(onAbort).toHaveBeenCalledTimes(1);
  });

  it("locks the abort action while cleanup is in progress", () => {
    render(
      <RecordingProgressModal
        open
        statusText="正在中止录制…"
        queueLength={1}
        abortRequested
        onAbort={vi.fn()}
      />,
    );

    expect(screen.getByRole("button", { name: "正在中止…" }).disabled).toBe(true);
    expect(screen.getByText(/正在停止 OBS/)).toBeTruthy();
  });
});
