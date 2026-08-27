import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../utils/playDemoInCs2.js", () => ({
  getDemoPlaybackPreflight: vi.fn(),
  getDemoPlaybackStatus: vi.fn(),
  playDemoErrorLabel: vi.fn((error) => error?.message || "error"),
  playDemoInCs2: vi.fn(),
}));

vi.mock("./usePlayDemoToast.jsx", () => ({
  usePlayDemoToast: () => ({
    showPlayToast: vi.fn(),
    PlayDemoToast: () => null,
  }),
}));

import { useLocaleStore } from "../i18n/localeStore.js";
import { getDemoPlaybackPreflight, getDemoPlaybackStatus, playDemoInCs2 } from "../utils/playDemoInCs2.js";
import { useDemoPlaybackDialog } from "./useDemoPlaybackDialog.jsx";

function Harness() {
  const { requestPlayDemo, DemoPlaybackUi } = useDemoPlaybackDialog();
  return (
    <>
      <button type="button" onClick={() => void requestPlayDemo({ id: 7, label: "match.dem" })}>open</button>
      <DemoPlaybackUi />
    </>
  );
}

describe("useDemoPlaybackDialog restoration monitor", () => {
  beforeEach(() => {
    useLocaleStore.getState().hydrate("zh");
    getDemoPlaybackPreflight.mockReset();
    getDemoPlaybackStatus.mockReset();
    playDemoInCs2.mockReset();
  });

  it("launches advanced playback directly from the preview and opens factual restoration", async () => {
    const customSkyboxId = `custom:${"b".repeat(32)}`;
    getDemoPlaybackPreflight.mockResolvedValue({
      cs2_path_configured: true,
      cs2_running: false,
      playback_active: false,
      recording_skybox: "xuejing",
      skyboxes: [{
        id: customSkyboxId,
        display_name: "测试星空",
        source: "custom",
        available: true,
      }],
    });
    playDemoInCs2.mockResolvedValue({ session_id: "session-7", pov_hud_enabled: true });
    getDemoPlaybackStatus.mockResolvedValue({
      found: true,
      session_id: "session-7",
      state: "completed",
      restore: {
        verified: true,
        gameinfo_restored: true,
        pov_vpk_removed: true,
        verification_mode: "strict",
        byte_verified: true,
        expected_gameinfo_sha256: "a".repeat(64),
        actual_gameinfo_sha256: "a".repeat(64),
      },
    });

    render(<Harness />);
    fireEvent.click(screen.getByRole("button", { name: "open" }));
    await screen.findByRole("button", { name: /启动高级播放 Demo/ });
    const skyboxSelect = screen.getByRole("combobox", { name: "高级播放天空盒" });
    expect(skyboxSelect.value).toBe("xuejing");
    fireEvent.change(skyboxSelect, { target: { value: customSkyboxId } });
    fireEvent.click(screen.getByRole("button", { name: /启动高级播放 Demo/ }));

    await screen.findByText("POV 文件已按备份完整恢复");
    expect(playDemoInCs2).toHaveBeenCalledWith(expect.objectContaining({
      id: 7,
      advancedPlayback: expect.objectContaining({ enabled: true, skybox_id: customSkyboxId }),
    }));
    await waitFor(() => expect(getDemoPlaybackStatus).toHaveBeenCalledWith("session-7"));
  });
});
