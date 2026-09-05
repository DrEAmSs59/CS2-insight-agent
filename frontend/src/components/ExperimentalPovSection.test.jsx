import { fireEvent, render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import API from "../api/api";
import { useLocaleStore } from "../i18n/localeStore.js";
import ExperimentalPovSection from "./ExperimentalPovSection.jsx";

vi.mock("../api/api", () => ({
  default: {
    get: vi.fn(),
    post: vi.fn(),
  },
}));

function renderSection() {
  return render(
    <ExperimentalPovSection
      visible
      experimentalPovEnabled
      onExperimentalPovChange={() => {}}
    />,
  );
}

describe("ExperimentalPovSection POV recovery", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    useLocaleStore.getState().hydrate("zh");
  });

  it("offers four synchronized voice audiences and removes the radar control", () => {
    API.get.mockReturnValue(new Promise(() => {}));
    const onVoiceChange = vi.fn();
    render(
      <ExperimentalPovSection
        visible
        experimentalPovEnabled
        onExperimentalPovChange={() => {}}
        povTeamcounterNumeric={false}
        onPovTeamcounterNumericChange={() => {}}
        povVoiceMode="team"
        onPovVoiceModeChange={onVoiceChange}
      />,
    );

    const voiceSelect = screen.getByRole("combobox", { name: "语音控制" });
    expect(voiceSelect.value).toBe("team");
    expect(Array.from(voiceSelect.options).map(({ value }) => value)).toEqual([
      "all",
      "team",
      "enemy",
      "mute",
    ]);
    expect(screen.queryByRole("combobox", { name: "雷达" })).toBeNull();
    expect(screen.getByRole("checkbox", { name: /局内玩家显示/ })).toBeTruthy();

    fireEvent.change(voiceSelect, { target: { value: "enemy" } });
    expect(onVoiceChange).toHaveBeenCalledWith("enemy");
  });

  it("renders POV and skybox inside one experimental feature card", () => {
    API.get.mockReturnValue(new Promise(() => {}));
    const onSkyboxChange = vi.fn();
    render(
      <ExperimentalPovSection
        visible
        experimentalPovEnabled={false}
        onExperimentalPovChange={() => {}}
        recordingSkybox="cartoon3"
        onRecordingSkyboxChange={onSkyboxChange}
      />,
    );

    const selector = screen.getByRole("combobox", { name: "录制天空盒" });
    const featureCard = screen.getByTestId("experimental-feature-card");
    const povCard = screen.getByTestId("experimental-pov-card");
    const skyboxCard = screen.getByTestId("experimental-skybox-card");
    expect(selector.value).toBe("cartoon3");
    expect(screen.getByTestId("recording-skybox-preview").getAttribute("src"))
      .toBe("/skyboxes/cartoon3.webp");
    expect(povCard.contains(selector)).toBe(false);
    expect(skyboxCard.contains(selector)).toBe(true);
    expect(featureCard.contains(povCard)).toBe(true);
    expect(featureCard.contains(skyboxCard)).toBe(true);
    expect(povCard.className).not.toContain("bg-");
    expect(skyboxCard.className).not.toContain("bg-");
    const optionGroups = Array.from(selector.querySelectorAll("optgroup"));
    expect(optionGroups.map(({ label }) => label)).toEqual([
      "纯色天空盒",
      "Insight 内置天空盒",
    ]);
    expect(Array.from(optionGroups[0].querySelectorAll("option")).map((option) => ({
      value: option.value,
      label: option.textContent,
    }))).toEqual([
      { value: "chroma_blue", label: "蓝色" },
      { value: "chroma_green", label: "绿色" },
    ]);
    expect(Array.from(optionGroups[1].querySelectorAll("option"))
      .every(({ value }) => value.startsWith("cartoon"))).toBe(true);
    fireEvent.change(selector, { target: { value: "cartoon4" } });
    expect(onSkyboxChange).toHaveBeenCalledWith("cartoon4");
  });

  it("places the in-game input selector above map material and supports hiding it", () => {
    API.get.mockReturnValue(new Promise(() => {}));
    const onInputHudEnabledChange = vi.fn();
    const onInputHudDisplayModeChange = vi.fn();
    render(
      <ExperimentalPovSection
        visible
        experimentalPovEnabled
        onExperimentalPovChange={() => {}}
        inputHudEnabled
        inputHudDisplayMode="hybrid"
        onInputHudEnabledChange={onInputHudEnabledChange}
        onInputHudDisplayModeChange={onInputHudDisplayModeChange}
        recordingMapMaterial="default"
        onRecordingMapMaterialChange={() => {}}
      />,
    );

    const inputCard = screen.getByTestId("experimental-input-hud-card");
    const materialCard = screen.getByTestId("experimental-map-material-card");
    const selector = screen.getByRole("combobox", { name: "按键显示方式" });
    expect(inputCard.compareDocumentPosition(materialCard) & Node.DOCUMENT_POSITION_FOLLOWING)
      .toBeTruthy();
    expect(Array.from(selector.options).map(({ value }) => value))
      .toEqual(["visible", "hidden"]);
    expect(screen.queryByText("虚拟按键音")).toBeNull();

    fireEvent.change(selector, { target: { value: "hidden" } });
    expect(onInputHudEnabledChange).toHaveBeenCalledWith(false);
    fireEvent.change(selector, { target: { value: "visible" } });
    expect(onInputHudEnabledChange).toHaveBeenCalledWith(true);
    expect(onInputHudDisplayModeChange).toHaveBeenCalledWith("hybrid");
  });

  it("keeps voice, aliases, input, material and skybox selectable below a disabled POV", () => {
    API.get.mockReturnValue(new Promise(() => {}));
    const onVoiceChange = vi.fn();
    const onInputModeChange = vi.fn();
    render(
      <ExperimentalPovSection
        visible
        experimentalPovEnabled={false}
        onExperimentalPovChange={() => {}}
        povVoiceMode="team"
        onPovVoiceModeChange={onVoiceChange}
        inputHudEnabled
        inputHudDisplayMode="hybrid"
        onInputHudEnabledChange={() => {}}
        onInputHudDisplayModeChange={onInputModeChange}
        recordingMapMaterial="default"
        onRecordingMapMaterialChange={() => {}}
        recordingSkybox="default"
        onRecordingSkyboxChange={() => {}}
        contentAfterVoice={<div data-testid="aliases-slot">aliases</div>}
      />,
    );

    const povCard = screen.getByTestId("experimental-pov-card");
    const voiceCard = screen.getByTestId("experimental-voice-card");
    const aliasesCard = screen.getByTestId("experimental-after-voice-content");
    const inputCard = screen.getByTestId("experimental-input-hud-card");
    const materialCard = screen.getByTestId("experimental-map-material-card");
    const skyboxCard = screen.getByTestId("experimental-skybox-card");
    const voiceSelect = screen.getByRole("combobox", { name: "语音控制" });
    const inputSelect = screen.getByRole("combobox", { name: "按键显示方式" });

    expect(voiceSelect.disabled).toBe(false);
    expect(inputSelect.disabled).toBe(false);
    expect(povCard.compareDocumentPosition(voiceCard) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(voiceCard.compareDocumentPosition(aliasesCard) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(aliasesCard.compareDocumentPosition(inputCard) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(inputCard.compareDocumentPosition(materialCard) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(materialCard.compareDocumentPosition(skyboxCard) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();

    fireEvent.change(voiceSelect, { target: { value: "enemy" } });
    fireEvent.change(inputSelect, { target: { value: "visible" } });
    expect(onVoiceChange).toHaveBeenCalledWith("enemy");
    expect(onInputModeChange).toHaveBeenCalledWith("hybrid");
  });

  it("loads an available custom skybox into the recording selector", async () => {
    const customId = "custom:0123456789abcdef0123456789abcdef";
    API.get.mockImplementation((path) => Promise.resolve({
      data: path === "game-resources/skyboxes"
        ? {
            items: [{
              id: customId,
              display_name: "紫色星空",
              source: "custom",
              available: true,
            }],
          }
        : { state: "clean", needs_restore: false },
    }));

    render(
      <ExperimentalPovSection
        visible
        experimentalPovEnabled={false}
        onExperimentalPovChange={() => {}}
        recordingSkybox={customId}
        onRecordingSkyboxChange={() => {}}
      />,
    );

    const option = await screen.findByRole("option", { name: "紫色星空" });
    expect(option.value).toBe(customId);
    expect(screen.getByRole("combobox", { name: "录制天空盒" }).value).toBe(customId);
  });

  it("allows a recording skybox override while rain defaults to Train overcast", () => {
    API.get.mockReturnValue(new Promise(() => {}));
    const onSkyboxChange = vi.fn();
    const onMapMaterialChange = vi.fn();
    const onWeatherEffectChange = vi.fn();
    render(
      <ExperimentalPovSection
        visible
        experimentalPovEnabled={false}
        onExperimentalPovChange={() => {}}
        recordingSkybox="cartoon3"
        onRecordingSkyboxChange={onSkyboxChange}
        recordingMapMaterial="default"
        onRecordingMapMaterialChange={onMapMaterialChange}
        recordingWeatherEffect="rain"
        onRecordingWeatherEffectChange={onWeatherEffectChange}
      />,
    );

    const skyboxSelect = screen.getByRole("combobox", { name: "录制天空盒" });
    expect(skyboxSelect.value).toBe("cartoon3");
    expect(skyboxSelect.disabled).toBe(false);
    expect(screen.getAllByText(/默认使用 Train 阴天天空/).length).toBeGreaterThan(0);

    const materialSelect = screen.getByRole("combobox", { name: "录制地图材质" });
    expect(materialSelect.value).toBe("rain");
    expect(materialSelect.disabled).toBe(false);
    expect(Array.from(materialSelect.options).map(({ value, textContent }) => ({
      value,
      label: textContent,
    }))).toEqual([
      { value: "default", label: "原始地图材质（不替换）" },
      { value: "waxed_reflection", label: "打蜡反光倒影" },
      { value: "rain", label: "下雨（武器带水滴）" },
    ]);
    expect(screen.queryByRole("combobox", { name: "录制天气效果" })).toBeNull();
    expect(onSkyboxChange).not.toHaveBeenCalled();
    expect(onWeatherEffectChange).not.toHaveBeenCalled();
    expect(onMapMaterialChange).not.toHaveBeenCalled();

    fireEvent.change(materialSelect, { target: { value: "waxed_reflection" } });
    expect(onMapMaterialChange).toHaveBeenCalledWith("waxed_reflection");
    expect(onWeatherEffectChange).toHaveBeenCalledWith("default");
  });

  it("does not add a second experimental background when embedded in the preset", () => {
    API.get.mockReturnValue(new Promise(() => {}));
    render(
      <ExperimentalPovSection
        visible
        experimentalPovEnabled
        onExperimentalPovChange={() => {}}
        povVoiceMode="all"
        onPovVoiceModeChange={() => {}}
        onPovTeamcounterNumericChange={() => {}}
        inputHudEnabled={false}
        inputHudDisplayMode="active"
        onInputHudEnabledChange={() => {}}
        onInputHudDisplayModeChange={() => {}}
        recordingSkybox="default"
        onRecordingSkyboxChange={() => {}}
        omitEyebrow
        embedded
      />,
    );

    const featureCard = screen.getByTestId("experimental-feature-card");
    expect(featureCard.className).not.toContain("bg-");
    expect(featureCard.className).not.toContain("border-");
    expect(featureCard.contains(screen.getByRole("combobox", { name: "语音控制" }))).toBe(true);
    expect(featureCard.contains(screen.getByRole("combobox", { name: "按键显示方式" }))).toBe(true);
    expect(featureCard.contains(screen.getByRole("combobox", { name: "录制天空盒" }))).toBe(true);
  });

  it("can omit the POV disclaimer in the recording dialog", () => {
    API.get.mockReturnValue(new Promise(() => {}));
    render(
      <ExperimentalPovSection
        visible
        experimentalPovEnabled={false}
        onExperimentalPovChange={() => {}}
        omitDisclaimer
      />,
    );

    expect(screen.queryByTestId("experimental-pov-disclaimer")).toBeNull();
  });

  it("explains orphaned residue and reports semantic cleanup", async () => {
    API.get.mockResolvedValue({
      data: {
        state: "orphaned",
        needs_restore: true,
        cs2_running: false,
      },
    });
    API.post.mockResolvedValue({
      data: {
        ok: true,
        restore: {
          verified: true,
          verification_mode: "semantic",
          byte_verified: false,
        },
      },
    });

    renderSection();

    expect(await screen.findByText(/没有恢复记录的 POV 残留/)).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "恢复 POV 修改" }));

    expect(await screen.findByText(/POV 残留已安全清理/)).toBeTruthy();
    expect(screen.queryByText(/没有恢复记录的 POV 残留/)).toBeNull();
  });

  it("keeps the recovery action visible and shows the backend failure", async () => {
    API.get.mockResolvedValue({
      data: {
        state: "managed",
        needs_restore: true,
        cs2_running: false,
      },
    });
    API.post.mockRejectedValue({
      response: { data: { detail: "拒绝访问 gameinfo.gi" } },
    });

    renderSection();
    fireEvent.click(await screen.findByRole("button", { name: "恢复 POV 修改" }));

    expect(await screen.findByText(/POV 恢复失败：拒绝访问 gameinfo\.gi/)).toBeTruthy();
    expect(screen.getByRole("button", { name: "恢复 POV 修改" }).disabled).toBe(false);
  });
});
