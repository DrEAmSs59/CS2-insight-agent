import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import API from "../api/api.js";
import { TextEncoder } from "node:util";
globalThis.TextEncoder ||= TextEncoder;
vi.mock("../api/api.js", () => ({ default: { post: vi.fn() } }));

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
    API.post.mockReset();
  });

  it("keeps the player-alias entry hidden and launches without an alias payload", async () => {
    getDemoPlaybackPreflight.mockResolvedValue({ cs2_path_configured: true });
    playDemoInCs2.mockResolvedValue({ ok: true });
    render(<Harness />);
    fireEvent.click(screen.getByRole("button", { name: "open" }));
    const launchButton = await screen.findByRole("button", { name: /启动高级播放 Demo/ });
    expect(screen.queryByText("自定义玩家昵称")).toBeNull();
    expect(screen.queryByRole("checkbox", { name: "启用改名" })).toBeNull();
    fireEvent.click(launchButton);
    await waitFor(() => expect(playDemoInCs2).toHaveBeenCalledTimes(1));
    expect(playDemoInCs2.mock.calls[0][0].advancedPlayback).not.toHaveProperty("player_aliases");
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    expect(API.post).not.toHaveBeenCalled();
  });

  it("launches advanced playback directly from the preview and opens factual restoration", async () => {
    const customSkyboxId = `custom:${"b".repeat(32)}`;
    getDemoPlaybackPreflight.mockResolvedValue({
      cs2_path_configured: true,
      cs2_running: false,
      playback_active: false,
      recording_skybox: "cartoon3",
      recording_map_material: "waxed_reflection",
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
    const materialSelect = screen.getByRole("combobox", { name: "高级播放地图材质" });
    expect(screen.queryByRole("combobox", { name: "按键显示方式" })).toBeNull();
    expect(skyboxSelect.value).toBe("cartoon3");
    expect(materialSelect.value).toBe("default");
    fireEvent.change(skyboxSelect, { target: { value: customSkyboxId } });
    fireEvent.click(screen.getByRole("button", { name: /启动高级播放 Demo/ }));

    await screen.findByText("POV 文件已按备份完整恢复");
    expect(playDemoInCs2).toHaveBeenCalledWith(expect.objectContaining({
      id: 7,
      advancedPlayback: expect.objectContaining({
        enabled: true,
        skybox_id: customSkyboxId,
        map_material_id: "default",
      }),
    }));
    const playbackOptions = playDemoInCs2.mock.calls[0][0].advancedPlayback;
    expect(playbackOptions).not.toHaveProperty("input_hud_enabled");
    expect(playbackOptions).not.toHaveProperty("input_hud_display_mode");
    await waitFor(() => expect(getDemoPlaybackStatus).toHaveBeenCalledWith("session-7"));
  });

  it("starts with original map material even when the recording preset uses rain", async () => {
    getDemoPlaybackPreflight.mockResolvedValue({
      cs2_path_configured: true,
      cs2_running: false,
      playback_active: false,
      recording_skybox: "cartoon3",
      recording_map_material: "rain_puddles",
      skyboxes: [],
    });
    playDemoInCs2.mockResolvedValue({});

    render(<Harness />);
    fireEvent.click(screen.getByRole("button", { name: "open" }));
    await screen.findByRole("button", { name: /启动高级播放 Demo/ });

    const skyboxSelect = screen.getByRole("combobox", { name: "高级播放天空盒" });
    expect(skyboxSelect.value).toBe("cartoon3");
    expect(skyboxSelect.disabled).toBe(false);
    fireEvent.click(screen.getByRole("button", { name: /启动高级播放 Demo/ }));

    await waitFor(() => expect(playDemoInCs2).toHaveBeenCalledWith(expect.objectContaining({
      advancedPlayback: expect.objectContaining({
        skybox_id: "cartoon3",
        map_material_id: "default",
        weather_effect_id: "default",
      }),
    })));
  });
});
