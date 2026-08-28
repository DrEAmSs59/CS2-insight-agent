import { describe, expect, test } from "vitest";
import { RECORD_WARMUP_DEFAULT_OPTIONS } from "../components/RecordWarmupModal";
import { buildRecordingPresetFile, parseRecordingPresetFile } from "./recordingPresetJson";

const preset = {
  recording_global_pacing: { pre_first_sec: 2, default_victim_pov: true },
  default_record_warmup: { ...RECORD_WARMUP_DEFAULT_OPTIONS, aspect_ratio: "16:9", resolution_width: "1920", resolution_height: "1080" },
  cs2_extra_launch_args: "-fullscreen",
  record_inject_console_lines: "fps_max 0",
  obs_transition_enabled: true,
  obs_transition_name: "Fade",
  obs_transition_duration_ms: 200,
  kb_overlay_enabled: false,
  kb_overlay_tick_offset: 6,
  kb_overlay_position: "bottom_center",
  kill_fx_enabled: true,
  kill_fx_tick_offset: 6,
  experimental_pov_enabled: false,
  recording_skybox: "xuejing",
  recording_map_material: "waxed_reflection",
};

describe("recording preset share JSON", () => {
  test("round trips a valid preset", () => {
    const file = buildRecordingPresetFile(preset, "2026-07-03T00:00:00.000Z");
    expect(parseRecordingPresetFile(file, RECORD_WARMUP_DEFAULT_OPTIONS)).toEqual(preset);
  });

  test("rejects another file format", () => {
    expect(() => parseRecordingPresetFile({ format: "other", version: 1, preset }, RECORD_WARMUP_DEFAULT_OPTIONS)).toThrow();
  });

  test("rejects invalid values", () => {
    const file = buildRecordingPresetFile({ ...preset, recording_global_pacing: { pre_first_sec: -1 } });
    expect(() => parseRecordingPresetFile(file, RECORD_WARMUP_DEFAULT_OPTIONS)).toThrow();
  });

  test("defaults kill FX off when the field is missing", () => {
    const { kill_fx_enabled: _removed, ...legacyPreset } = preset;
    const file = buildRecordingPresetFile(legacyPreset);
    expect(parseRecordingPresetFile(file, RECORD_WARMUP_DEFAULT_OPTIONS).kill_fx_enabled).toBe(false);
  });

  test("migrates a version-1 KillFX fine-tune to an independent offset", () => {
    const file = { ...buildRecordingPresetFile({ ...preset, kb_overlay_tick_offset: 8, kill_fx_tick_offset: -2 }), version: 1 };
    expect(parseRecordingPresetFile(file, RECORD_WARMUP_DEFAULT_OPTIONS).kill_fx_tick_offset).toBe(6);
  });

  test("defaults a missing version-1 KillFX fine-tune to the keyboard offset", () => {
    const { kill_fx_tick_offset: _removed, ...legacyPreset } = preset;
    const file = { ...buildRecordingPresetFile(legacyPreset), version: 1 };
    expect(parseRecordingPresetFile(file, RECORD_WARMUP_DEFAULT_OPTIONS).kill_fx_tick_offset).toBe(6);
  });

  test("defaults legacy presets to the original map sky", () => {
    const { recording_skybox: _removed, ...legacyPreset } = preset;
    const file = { ...buildRecordingPresetFile(legacyPreset), version: 2 };
    expect(parseRecordingPresetFile(file, RECORD_WARMUP_DEFAULT_OPTIONS).recording_skybox).toBe("default");
  });

  test("defaults legacy presets to the original map material", () => {
    const { recording_map_material: _removed, ...legacyPreset } = preset;
    const file = { ...buildRecordingPresetFile(legacyPreset), version: 3 };
    expect(parseRecordingPresetFile(file, RECORD_WARMUP_DEFAULT_OPTIONS).recording_map_material)
      .toBe("default");
  });

  test("rejects an unknown map material", () => {
    const file = buildRecordingPresetFile({ ...preset, recording_map_material: "chrome" });
    expect(() => parseRecordingPresetFile(file, RECORD_WARMUP_DEFAULT_OPTIONS)).toThrow();
  });

  test("rejects an unknown skybox", () => {
    const file = buildRecordingPresetFile({ ...preset, recording_skybox: "other" });
    expect(() => parseRecordingPresetFile(file, RECORD_WARMUP_DEFAULT_OPTIONS)).toThrow();
  });

  test("preserves a custom skybox reference", () => {
    const customId = "custom:0123456789abcdef0123456789abcdef";
    const file = buildRecordingPresetFile({ ...preset, recording_skybox: customId });
    expect(parseRecordingPresetFile(file, RECORD_WARMUP_DEFAULT_OPTIONS).recording_skybox)
      .toBe(customId);
  });

  test("round trips the POV voice audience", () => {
    const next = {
      ...preset,
      default_record_warmup: {
        ...preset.default_record_warmup,
        pov_voice_mode: "enemy",
      },
    };
    expect(parseRecordingPresetFile(buildRecordingPresetFile(next), RECORD_WARMUP_DEFAULT_OPTIONS))
      .toEqual(next);
  });

  test("migrates the legacy disabled voice switch", () => {
    const { pov_voice_mode: _removed, ...legacyWarmup } = preset.default_record_warmup;
    const next = {
      ...preset,
      default_record_warmup: {
        ...legacyWarmup,
        pov_voice_disabled: true,
      },
    };
    expect(parseRecordingPresetFile(buildRecordingPresetFile(next), RECORD_WARMUP_DEFAULT_OPTIONS)
      .default_record_warmup.pov_voice_mode).toBe("mute");
  });

  test("rejects an unknown POV voice audience", () => {
    const next = {
      ...preset,
      default_record_warmup: {
        ...preset.default_record_warmup,
        pov_voice_mode: "spectators",
      },
    };
    expect(() => parseRecordingPresetFile(buildRecordingPresetFile(next), RECORD_WARMUP_DEFAULT_OPTIONS))
      .toThrow();
  });

  test("normalizes legacy hidden-radar presets to the fixed visible radar", () => {
    const next = {
      ...preset,
      default_record_warmup: {
        ...preset.default_record_warmup,
        pov_radar_mode: -1,
      },
    };
    expect(parseRecordingPresetFile(buildRecordingPresetFile(next), RECORD_WARMUP_DEFAULT_OPTIONS)
      .default_record_warmup.pov_radar_mode).toBe(0);
  });
});
