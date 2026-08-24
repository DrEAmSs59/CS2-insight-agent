import { fireEvent, render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { useLocaleStore } from "../i18n/localeStore.js";
import DemoPlayOptionsModal from "./DemoPlayOptionsModal.jsx";

describe("DemoPlayOptionsModal", () => {
  beforeEach(() => {
    useLocaleStore.getState().hydrate("zh");
  });

  it("offers normal and advanced playback after preflight", () => {
    const onPlayNormal = vi.fn();
    const onPlayAdvanced = vi.fn();
    render(
      <DemoPlayOptionsModal
        open
        demoLabel="match.dem"
        onPlayNormal={onPlayNormal}
        onPlayAdvanced={onPlayAdvanced}
        onClose={() => {}}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: /普通播放/ }));
    fireEvent.click(screen.getByRole("button", { name: /高级播放/ }));
    expect(onPlayNormal).toHaveBeenCalledTimes(1);
    expect(onPlayAdvanced).toHaveBeenCalledTimes(1);
    expect(screen.getByTestId("demo-play-normal-option").className).toContain("justify-start");
    expect(screen.getByTestId("demo-play-advanced-option").className).toContain("justify-start");
    expect(screen.getByTestId("demo-play-normal-option").className).toContain("min-h-[112px]");
    expect(screen.getByTestId("demo-play-advanced-option").className).toContain("min-h-[112px]");
  });

  it("blocks playback while CS2 is running and allows a recheck", () => {
    const onRetry = vi.fn();
    render(
      <DemoPlayOptionsModal
        open
        demoLabel="match.dem"
        blockedReason="running"
        onRetry={onRetry}
        onClose={() => {}}
      />,
    );

    expect(screen.getByText(/CS2\.exe 正在运行/)).toBeTruthy();
    expect(screen.queryByRole("button", { name: /普通播放/ })).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: /重新检测/ }));
    expect(onRetry).toHaveBeenCalledTimes(1);
  });
});
