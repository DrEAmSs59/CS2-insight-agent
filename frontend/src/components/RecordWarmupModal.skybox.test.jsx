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

  it.each([false, true].flatMap((pov) => ["default", "waxed_reflection", "rain"].flatMap((appearance) =>
    ["default", "cartoon3", "chroma_blue", "chroma_green"].map((skybox) => ({ pov, appearance, skybox })),
  )))("submits independent final choices after toggling controls: %j", ({ pov, appearance, skybox }) => {
    const onConfirm = vi.fn();
    render(<RecordWarmupModal open onClose={() => {}} onConfirm={onConfirm} experimentalPovEnabled={!pov} />);
    fireEvent.change(screen.getByRole("combobox", { name: "录制地图材质" }), { target: { value: appearance } });
    fireEvent.change(screen.getByRole("combobox", { name: "录制天空盒" }), { target: { value: skybox } });
    fireEvent.change(screen.getByRole("combobox", { name: "语音控制" }), { target: { value: "mute" } });
    fireEvent.change(screen.getByRole("combobox", { name: "按键显示方式" }), { target: { value: "hidden" } });
    fireEvent.click(screen.getByTestId("experimental-pov-card").querySelector("input[type=checkbox]"));
    fireEvent.click(screen.getByRole("button", { name: "开始录制" }));
    expect(onConfirm).toHaveBeenCalledWith(expect.objectContaining({
      experimental_pov_enabled: pov,
      recording_skybox: skybox,
      recording_map_material: appearance === "waxed_reflection" ? appearance : "default",
      recording_weather_effect: appearance === "rain" ? "rain" : "default",
      pov_voice_mode: "mute", input_hud_enabled: false,
    }));
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
    const inputModeSelector = screen.getByRole("combobox", { name: "按键显示方式" });
    const voiceSelector = screen.getByRole("combobox", { name: "语音控制" });
    expect(inputModeSelector.disabled).toBe(false);
    expect(voiceSelector.disabled).toBe(false);
    expect(inputModeSelector.value).toBe("bottom_center");
    expect(Array.from(inputModeSelector.options).map(({ value }) => value))
      .toEqual(["hidden", "bottom_center", "minimap_below", "weapon_right"]);
    expect(screen.queryByText("虚拟按键音")).toBeNull();
    expect(screen.queryByRole("checkbox", { name: "实时 KDA / 伤害" })).toBeNull();
    expect(screen.getByText(/此处修改仅作用于本次录制/)).toBeTruthy();
    expect(selector.value).toBe("cartoon3");
    expect(materialSelector.value).toBe("waxed_reflection");
    expect(Array.from(materialSelector.options).map(({ value, textContent }) => ({
      value,
      label: textContent,
    }))).toEqual([
      { value: "default", label: "原始地图材质（不替换）" },
      { value: "waxed_reflection", label: "打蜡反光倒影" },
      { value: "rain", label: "下雨（武器带水滴）" },
    ]);
    expect(screen.queryByRole("combobox", { name: "录制天气效果" })).toBeNull();
    expect(screen.getByTestId("experimental-feature-card").contains(selector)).toBe(true);
    expect(screen.getByTestId("experimental-feature-card").contains(inputModeSelector)).toBe(true);
    expect(screen.queryByTestId("player-aliases-section")).toBeNull();
    expect(
      screen.getByTestId("experimental-voice-card").compareDocumentPosition(
        screen.getByTestId("experimental-input-hud-card"),
      ) & Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();
    expect(
      screen.getByTestId("experimental-input-hud-card").compareDocumentPosition(
        screen.getByTestId("experimental-map-material-card"),
      ) & Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();
    fireEvent.change(selector, { target: { value: "cartoon3" } });
    fireEvent.change(materialSelector, { target: { value: "default" } });
    fireEvent.change(voiceSelector, { target: { value: "enemy" } });
    fireEvent.click(screen.getByRole("button", { name: "开始录制" }));

    expect(onConfirm).toHaveBeenCalledWith(
      expect.objectContaining({
        recording_skybox: "cartoon3",
        recording_map_material: "default",
        recording_weather_effect: "default",
        experimental_pov_enabled: false,
        pov_voice_mode: "enemy",
        input_hud_enabled: true,
        input_hud_position: "bottom_center",
        input_hud_display_mode: "hybrid",
        input_audio_enabled: false,
        combat_stats_hud_enabled: true,
      }),
    );
  });

  it("selecting rain for this recording defaults the skybox to Train overcast", () => {
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

    fireEvent.change(screen.getByRole("combobox", { name: "录制地图材质" }), {
      target: { value: "rain" },
    });
    expect(screen.getByRole("combobox", { name: "录制天空盒" }).value).toBe("default");
    expect(screen.getByRole("option", { name: "默认（Train 阴天）" }).selected).toBe(true);
    fireEvent.click(screen.getByRole("button", { name: "开始录制" }));
    expect(onConfirm).toHaveBeenCalledWith(
      expect.objectContaining({
        recording_skybox: "default",
        recording_map_material: "default",
        recording_weather_effect: "rain",
      }),
    );

    fireEvent.change(screen.getByRole("combobox", { name: "录制天空盒" }), {
      target: { value: "cartoon3" },
    });
    fireEvent.click(screen.getByRole("button", { name: "开始录制" }));
    expect(onConfirm).toHaveBeenLastCalledWith(
      expect.objectContaining({
        recording_skybox: "cartoon3",
        recording_map_material: "default",
        recording_weather_effect: "rain",
      }),
    );
  });

  it("keeps a previously chosen skybox when rain is already selected", () => {
    const onConfirm = vi.fn();
    render(
      <RecordWarmupModal
        open
        onClose={() => {}}
        onConfirm={onConfirm}
        recordingSkybox="cartoon3"
        recordingMapMaterial="default"
        recordingWeatherEffect="rain"
      />,
    );

    expect(screen.getByRole("combobox", { name: "录制天空盒" }).value).toBe("cartoon3");
    fireEvent.click(screen.getByRole("button", { name: "开始录制" }));
    expect(onConfirm).toHaveBeenCalledWith(
      expect.objectContaining({
        recording_skybox: "cartoon3",
        recording_map_material: "default",
        recording_weather_effect: "rain",
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
    fireEvent.change(inputModeSelect, { target: { value: "hidden" } });
    expect(screen.queryByRole("checkbox", { name: "实时 KDA / 伤害" })).toBeNull();
    fireEvent.change(voiceSelect, { target: { value: "enemy" } });
    fireEvent.click(screen.getByRole("button", { name: "开始录制" }));

    expect(onConfirm).toHaveBeenCalledWith(
      expect.objectContaining({
        experimental_pov_enabled: true,
        pov_voice_mode: "enemy",
        input_hud_enabled: false,
        input_hud_position: "bottom_center",
        input_hud_display_mode: "hybrid",
        input_audio_enabled: false,
        combat_stats_hud_enabled: true,
      }),
    );
  });

  it("inherits the saved input HUD default and allows a one-session override", () => {
    const onConfirm = vi.fn();
    render(
      <RecordWarmupModal
        open
        onClose={() => {}}
        onConfirm={onConfirm}
        experimentalPovEnabled
        defaultOverrides={{
          input_hud_enabled: false,
          input_hud_position: "weapon_right",
          input_hud_display_mode: "active",
          input_audio_enabled: true,
        }}
      />,
    );

    const inputModeSelect = screen.getByRole("combobox", { name: "按键显示方式" });
    expect(inputModeSelect.value).toBe("hidden");
    fireEvent.change(inputModeSelect, { target: { value: "bottom_center" } });
    fireEvent.click(screen.getByRole("button", { name: "开始录制" }));

    expect(onConfirm).toHaveBeenCalledWith(expect.objectContaining({
      input_hud_enabled: true,
      input_hud_position: "bottom_center",
      input_hud_display_mode: "hybrid",
      input_audio_enabled: false,
    }));
  });
});
