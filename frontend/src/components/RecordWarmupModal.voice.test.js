import { describe, expect, it } from "vitest";

import {
  buildWarmupConsoleCommands,
  RECORD_WARMUP_DEFAULT_OPTIONS,
} from "./RecordWarmupModal.jsx";


function voiceCommands(mode) {
  return buildWarmupConsoleCommands({
    ...RECORD_WARMUP_DEFAULT_OPTIONS,
    voice_filter: mode,
  }).filter((command) => /^(voice_modenable|snd_voipvolume|tv_listen_voice_indices)/.test(command));
}


describe("recording warmup voice commands", () => {
  it("mutes through voice enable and both mask halves", () => {
    expect(voiceCommands("mute")).toEqual([
      "tv_listen_voice_indices 0",
      "tv_listen_voice_indices_h 0",
      "voice_modenable 0",
      "snd_voipvolume 0",
    ]);
  });

  it.each(["team", "enemy"])("starts %s mode silent until the POV mask is known", (mode) => {
    const commands = voiceCommands(mode);
    expect(commands).toEqual([
      "tv_listen_voice_indices 0",
      "tv_listen_voice_indices_h 0",
      "voice_modenable 1",
      "snd_voipvolume 1",
    ]);
    expect(commands).not.toContain("tv_listen_voice_indices -1");
    expect(commands).not.toContain("tv_listen_voice_indices_h -1");
  });

  it("opens both mask halves only for the explicit all-player mode", () => {
    expect(voiceCommands("open")).toEqual([
      "voice_modenable 1",
      "snd_voipvolume 1",
      "tv_listen_voice_indices -1",
      "tv_listen_voice_indices_h -1",
    ]);
  });

  it("does not manage voice in off mode", () => {
    expect(voiceCommands("off")).toEqual([]);
  });
});
