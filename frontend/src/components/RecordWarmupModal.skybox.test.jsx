import { fireEvent, render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import API from "../api/api";
import { useLocaleStore } from "../i18n/localeStore.js";
import RecordWarmupModal from "./RecordWarmupModal.jsx";

vi.mock("../api/api", () => ({
  default: {
    get: vi.fn(),
    post: vi.fn(),
  },
}));

describe("RecordWarmupModal skybox override", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    API.get.mockReturnValue(new Promise(() => {}));
    useLocaleStore.getState().hydrate("zh");
  });

  it("starts from the saved preset and submits the dialog selection", () => {
    const onConfirm = vi.fn();
    render(
      <RecordWarmupModal
        open
        onClose={() => {}}
        onConfirm={onConfirm}
        recordingSkybox="cartoon3"
        recordingMapMaterial="waxed_reflection"
      />,
    );

    const selector = screen.getByRole("combobox", { name: "录制天空盒" });
    const materialSelector = screen.getByRole("combobox", { name: "录制地图材质" });
    expect(screen.queryByText(/以下命令在首次跳转 tick 前/)).toBeNull();
    expect(screen.queryByTestId("experimental-pov-disclaimer")).toBeNull();
    expect(screen.queryByText(/默认已预填 5 条性能\/预测 cvar/)).toBeNull();
    expect(screen.queryByText(/首片段预热/)).toBeNull();
    expect(screen.queryByText("启用虚拟键盘 Overlay")).toBeNull();
    expect(screen.getByText("内置按键 + 键鼠可视化")).toBeTruthy();
    expect(screen.getByRole("checkbox", { name: "启用" }).disabled).toBe(true);
    expect(screen.getByText(/此处修改仅作用于本次录制/)).toBeTruthy();
    expect(selector.value).toBe("cartoon3");
    expect(materialSelector.value).toBe("waxed_reflection");
    expect(screen.getByTestId("experimental-feature-card").contains(selector)).toBe(true);
    fireEvent.change(selector, { target: { value: "cartoon3" } });
    fireEvent.change(materialSelector, { target: { value: "default" } });
    fireEvent.click(screen.getByRole("button", { name: "开始录制" }));

    expect(onConfirm).toHaveBeenCalledWith(
      expect.objectContaining({
        recording_skybox: "cartoon3",
        recording_map_material: "default",
        pov_voice_mode: "team",
        input_hud_enabled: true,
        input_hud_display_mode: "hybrid",
        input_audio_enabled: true,
        combat_stats_hud_enabled: true,
      }),
    );
  });

  it("submits the selected POV voice audience for this recording", () => {
    const onConfirm = vi.fn();
    render(
      <RecordWarmupModal
        open
        onClose={() => {}}
        onConfirm={onConfirm}
        experimentalPovEnabled
      />,
    );

    const voiceSelect = screen.getByRole("combobox", { name: "语音控制" });
    const inputModeSelect = screen.getByRole("combobox", { name: "按键显示方式" });
    fireEvent.change(inputModeSelect, { target: { value: "active" } });
    fireEvent.click(screen.getByRole("checkbox", { name: "虚拟按键音" }));
    fireEvent.click(screen.getByRole("checkbox", { name: "实时 KDA / 伤害" }));
    fireEvent.change(voiceSelect, { target: { value: "enemy" } });
    fireEvent.click(screen.getByRole("button", { name: "开始录制" }));

    expect(onConfirm).toHaveBeenCalledWith(
      expect.objectContaining({
        experimental_pov_enabled: true,
        pov_voice_mode: "enemy",
        input_hud_enabled: true,
        input_hud_display_mode: "active",
        input_audio_enabled: false,
        combat_stats_hud_enabled: false,
      }),
    );
  });
});
