import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../api/api.js", () => ({
  default: {
    get: vi.fn(),
    post: vi.fn(),
  },
}));

import API from "../api/api.js";
import { getDemoPlaybackPreflight, getDemoPlaybackStatus, playDemoErrorLabel, playDemoInCs2 } from "./playDemoInCs2.js";

describe("playDemoInCs2", () => {
  beforeEach(() => {
    API.get.mockReset();
    API.post.mockReset();
  });

  it("prefers library id over path", async () => {
    API.post.mockResolvedValue({ data: { ok: true } });
    await playDemoInCs2({ id: 42, path: "C:/tmp/a.dem" });
    expect(API.post).toHaveBeenCalledWith("/demos/42/play", {
      pov_hud: { enabled: false, radar_mode: 0, teamcounter_numeric: false, skybox_id: "default" },
      map_material: { id: "default" },
    });
  });

  it("posts path when id is missing", async () => {
    API.post.mockResolvedValue({ data: { ok: true } });
    await playDemoInCs2({ path: "C:/tmp/a.dem" });
    expect(API.post).toHaveBeenCalledWith("/demo/play", {
      path: "C:/tmp/a.dem",
      pov_hud: { enabled: false, radar_mode: 0, teamcounter_numeric: false, skybox_id: "default" },
      map_material: { id: "default" },
    });
  });

  it("passes advanced playback session options through the compatible API field", async () => {
    API.post.mockResolvedValue({ data: { ok: true } });
    await playDemoInCs2({
      id: 7,
      advancedPlayback: {
        enabled: true,
        radar_mode: -1,
        teamcounter_numeric: true,
        skybox_id: "cartoon3",
        map_material_id: "waxed_reflection",
        input_hud_enabled: true,
        input_hud_display_mode: "active",
        // Legacy callers may still send these, but the current product preset
        // fixes both values at 100.
        input_hud_scale_percent: 115,
        input_audio_enabled: true,
        input_audio_volume_percent: 50,
      },
    });
    expect(API.post).toHaveBeenCalledWith("/demos/7/play", {
      pov_hud: {
        enabled: true,
        radar_mode: -1,
        teamcounter_numeric: true,
        skybox_id: "cartoon3",
        input_hud_enabled: true,
        input_hud_display_mode: "active",
        input_hud_scale_percent: 100,
        input_audio_enabled: true,
        input_audio_volume_percent: 100,
      },
      map_material: { id: "waxed_reflection" },
    });
  });

  it("loads playback preflight", async () => {
    API.get.mockResolvedValue({ data: { cs2_running: true } });
    await expect(getDemoPlaybackPreflight()).resolves.toEqual({ cs2_running: true });
    expect(API.get).toHaveBeenCalledWith("/demo/playback/preflight");
  });

  it("loads the factual restoration status for one playback session", async () => {
    API.get.mockResolvedValue({ data: { found: true, state: "completed", restore: { verified: true } } });
    await expect(getDemoPlaybackStatus("session-123")).resolves.toEqual({
      found: true,
      state: "completed",
      restore: { verified: true },
    });
    expect(API.get).toHaveBeenCalledWith("/demo/playback/status", {
      params: { session_id: "session-123" },
    });
  });

  it("rejects when neither id nor path", async () => {
    await expect(playDemoInCs2({})).rejects.toThrow(/缺少可播放/);
  });
});

describe("playDemoErrorLabel", () => {
  it("reads string detail", () => {
    expect(playDemoErrorLabel({ response: { data: { detail: "no cs2" } } })).toBe("no cs2");
  });
});
