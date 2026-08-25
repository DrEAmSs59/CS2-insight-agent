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
        recordingSkybox="xuejing"
        onRecordingSkyboxChange={onSkyboxChange}
      />,
    );

    const selector = screen.getByRole("combobox", { name: "录制天空盒" });
    const featureCard = screen.getByTestId("experimental-feature-card");
    const povCard = screen.getByTestId("experimental-pov-card");
    const skyboxCard = screen.getByTestId("experimental-skybox-card");
    expect(selector.value).toBe("xuejing");
    expect(povCard.contains(selector)).toBe(false);
    expect(skyboxCard.contains(selector)).toBe(true);
    expect(featureCard.contains(povCard)).toBe(true);
    expect(featureCard.contains(skyboxCard)).toBe(true);
    expect(povCard.className).not.toContain("bg-");
    expect(skyboxCard.className).not.toContain("bg-");
    fireEvent.change(selector, { target: { value: "yinhezhanjian" } });
    expect(onSkyboxChange).toHaveBeenCalledWith("yinhezhanjian");
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
