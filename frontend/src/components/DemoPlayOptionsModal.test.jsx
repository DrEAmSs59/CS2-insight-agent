import { fireEvent, render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { useLocaleStore } from "../i18n/localeStore.js";
import DemoPlayOptionsModal from "./DemoPlayOptionsModal.jsx";

describe("DemoPlayOptionsModal", () => {
  beforeEach(() => {
    useLocaleStore.getState().hydrate("zh");
  });

  it("offers normal and POV playback after preflight", () => {
    const onPlayNormal = vi.fn();
    const onPlayPov = vi.fn();
    render(
      <DemoPlayOptionsModal
        open
        demoLabel="match.dem"
        onPlayNormal={onPlayNormal}
        onPlayPov={onPlayPov}
        onClose={() => {}}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: /普通播放/ }));
    fireEvent.click(screen.getByRole("button", { name: /实验功能：POV HUD/ }));
    expect(onPlayNormal).toHaveBeenCalledTimes(1);
    expect(onPlayPov).toHaveBeenCalledTimes(1);
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
