import { describe, expect, it } from "vitest";

import { splitRecordWarmupConfirmPayload, warmupUiOptsToPersisted } from "./warmupDefaults.js";

describe("recording dialog skybox override", () => {
  it("keeps the skybox in session settings instead of warmup commands", () => {
    const result = splitRecordWarmupConfirmPayload({
      recording_skybox: "cartoon3",
      recording_map_material: "waxed_reflection",
      tv_nochat: true,
    });

    expect(result.warmupForApi).toEqual({ tv_nochat: true });
    expect(result.session.recording_skybox).toBe("cartoon3");
    expect(result.session.recording_map_material).toBe("waxed_reflection");
    expect(result.session).toMatchObject({
      input_hud_enabled: true,
      input_hud_display_mode: "hybrid",
      input_audio_enabled: true,
      combat_stats_hud_enabled: true,
    });
  });

  it("keeps in-game input choices in the recording session payload", () => {
    const result = splitRecordWarmupConfirmPayload({
      input_hud_enabled: false,
      input_hud_display_mode: "active",
      input_audio_enabled: false,
      combat_stats_hud_enabled: false,
      tv_nochat: true,
    });

    expect(result.warmupForApi).toEqual({ tv_nochat: true });
    expect(result.session).toMatchObject({
      input_hud_enabled: false,
      input_hud_display_mode: "hybrid",
      input_audio_enabled: false,
      combat_stats_hud_enabled: false,
    });
  });

  it("falls back to the original sky for an invalid session value", () => {
    expect(splitRecordWarmupConfirmPayload({
      recording_skybox: "unknown",
      recording_map_material: "unknown",
    }).session).toMatchObject({
      recording_skybox: "default",
      recording_map_material: "default",
    });
  });

  it("persists in-game input HUD defaults for the recording preset", () => {
    expect(warmupUiOptsToPersisted({
      input_hud_enabled: false,
      input_hud_display_mode: "hybrid",
      input_audio_enabled: true,
    })).toMatchObject({
      input_hud_enabled: false,
      input_hud_display_mode: "hybrid",
      input_audio_enabled: true,
    });
  });
});
