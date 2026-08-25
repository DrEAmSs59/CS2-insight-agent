import { fireEvent, render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { useLocaleStore } from "../i18n/localeStore.js";
import DemoPlayOptionsModal from "./DemoPlayOptionsModal.jsx";

describe("DemoPlayOptionsModal", () => {
  beforeEach(() => {
    useLocaleStore.getState().hydrate("zh");
  });

  it("previews the in-game layout and offers advanced playback after preflight", () => {
    const onPlayAdvanced = vi.fn();
    render(
      <DemoPlayOptionsModal
        open
        demoLabel="match.dem"
        onPlayAdvanced={onPlayAdvanced}
        onClose={() => {}}
      />,
    );

    expect(screen.getByText("游戏内 INSIGHT UI 预览")).toBeTruthy();
    expect(screen.getByText("第 2 回合 ▾")).toBeTruthy();
    expect(screen.getByText("点击选择全部回合")).toBeTruthy();
    expect(screen.queryByText("原生 DemoUI · 进度与播放控制")).toBeNull();
    expect(screen.getByText("将临时修改 CS2 文件")).toBeTruthy();
    expect(screen.queryByRole("button", { name: /普通播放/ })).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: /启动高级播放 Demo/ }));
    expect(onPlayAdvanced).toHaveBeenCalledTimes(1);
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
    expect(screen.queryByRole("button", { name: /启动高级播放 Demo/ })).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: /重新检测/ }));
    expect(onRetry).toHaveBeenCalledTimes(1);
  });
});
