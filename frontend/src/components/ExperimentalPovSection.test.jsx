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

  it("shows voice disable unchecked above the radar control", () => {
    API.get.mockReturnValue(new Promise(() => {}));
    const onVoiceChange = vi.fn();
    render(
      <ExperimentalPovSection
        visible
        experimentalPovEnabled
        onExperimentalPovChange={() => {}}
        povRadarMode={0}
        onPovRadarModeChange={() => {}}
        povTeamcounterNumeric={false}
        onPovTeamcounterNumericChange={() => {}}
        povVoiceDisabled={false}
        onPovVoiceDisabledChange={onVoiceChange}
      />,
    );

    const voiceToggle = screen.getByRole("checkbox", { name: /禁用玩家语音/ });
    const voiceRow = voiceToggle.closest("label");
    expect(voiceToggle.checked).toBe(false);
    expect(voiceRow?.nextElementSibling?.textContent).toContain("雷达");

    fireEvent.click(voiceToggle);
    expect(onVoiceChange).toHaveBeenCalledWith(true);
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
