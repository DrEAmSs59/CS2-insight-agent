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
    const onRecordingSkyboxChange = vi.fn();
    const customSkyboxId = `custom:${"a".repeat(32)}`;
    render(
      <DemoPlayOptionsModal
        open
        demoLabel="match.dem"
        recordingSkybox="xuejing"
        skyboxResources={[{
          id: customSkyboxId,
          display_name: "我的黄昏",
          source: "custom",
          available: true,
        }]}
        onRecordingSkyboxChange={onRecordingSkyboxChange}
        onPlayAdvanced={onPlayAdvanced}
        onClose={() => {}}
      />,
    );

    expect(screen.getByText("游戏内 INSIGHT UI 预览")).toBeTruthy();
    expect(screen.getByTestId("advanced-playback-hud-preview")).toBeTruthy();
    expect(screen.getByText("标题条开")).toBeTruthy();
    expect(screen.getByText("隐藏 HUD")).toBeTruthy();
    expect(screen.getByText("己方")).toBeTruthy();
    expect(screen.getByText("对方")).toBeTruthy();
    expect(screen.getByText("上一局")).toBeTruthy();
    expect(screen.getByText("选择回合 ▾")).toBeTruthy();
    expect(screen.getByText("下一局")).toBeTruthy();
    expect(screen.getByText("共 24 回合")).toBeTruthy();
    expect(screen.getByText("跟随回合开")).toBeTruthy();
    expect(screen.getByText("原生 DemoUI · 进度与播放控制")).toBeTruthy();
    expect(screen.getAllByTestId("advanced-preview-player-row")).toHaveLength(10);
    const skyboxSelect = screen.getByRole("combobox", { name: "高级播放天空盒" });
    expect(skyboxSelect.value).toBe("xuejing");
    expect(Array.from(skyboxSelect.options)
      .map(({ value }) => value)
      .filter((value) => value.startsWith("cartoon")))
      .toEqual([
        "cartoon",
        "cartoon1",
        "cartoon2",
        "cartoon3",
        "cartoon4",
        "cartoon5",
        "cartoon6",
        "cartoon7",
        "cartoon8",
        "cartoon9",
        "cartoon10",
      ]);
    expect(screen.getByTestId("demo-play-skybox-preview").getAttribute("src"))
      .toBe("/skyboxes/xuejing.webp");
    fireEvent.change(skyboxSelect, { target: { value: customSkyboxId } });
    expect(onRecordingSkyboxChange).toHaveBeenCalledWith(customSkyboxId);

    const preview = screen.getByTestId("demo-play-preview");
    const skyboxOption = screen.getByTestId("demo-play-skybox-option");
    const warning = screen.getByTestId("demo-play-gameinfo-warning");
    expect(preview.compareDocumentPosition(skyboxOption) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(skyboxOption.compareDocumentPosition(warning) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
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
