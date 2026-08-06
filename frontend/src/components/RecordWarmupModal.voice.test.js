import { describe, expect, it } from "vitest";

import {
  buildWarmupConsoleCommands,
  RECORD_WARMUP_DEFAULT_OPTIONS,
} from "./RecordWarmupModal.jsx";


function voiceCommands(overrides = {}) {
  return buildWarmupConsoleCommands({
    ...RECORD_WARMUP_DEFAULT_OPTIONS,
    ...overrides,
  }).filter((command) => /^(voice_modenable|snd_voipvolume|tv_listen_voice_indices)/.test(command));
}


describe("recording warmup voice ownership", () => {
  it.each(["off", "open", "team", "enemy", "mute", "all"])(
    "ignores the removed legacy %s voice setting",
    (mode) => {
      expect(voiceCommands({ voice_filter: mode })).toEqual([]);
    },
  );

  it("leaves voice commands to the backend when POV is enabled", () => {
    expect(voiceCommands({ experimental_pov_enabled: true })).toEqual([]);
  });
});
