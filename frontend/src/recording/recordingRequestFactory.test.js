import { describe, expect, test } from "vitest";

import {
  DEFAULT_RECORDING_OPTIONS,
  buildHighlightRecordingRequest,
  buildRoundCompilationRecordingRequest,
} from "./recordingRequestFactory";


const queueItem = {
  id: "queue-1",
  demoPath: "C:/demo/source.dem",
  demoFilename: "source.dem",
  targetPlayer: "Player",
  targetSteamId: "1",
};

const matchMeta = {
  map_name: "de_nuke",
  total_rounds: 24,
  demo_end_tick: 177_914,
};


describe("recording demo EOF metadata", () => {
  test("uses the real MatchMeta EOF and removes legacy panel options", () => {
    const request = buildHighlightRecordingRequest(
      {
        round: 24,
        tick_rate: 64,
        clip_max_tick: 175_000,
        kill_ticks: [174_000],
      },
      queueItem,
      matchMeta,
    );

    expect(request.demo.demo_end_tick).toBe(177_914);
    expect(request.demo).not.toHaveProperty("win_panel_match_tick");
    expect(DEFAULT_RECORDING_OPTIONS.demo_end_guard_sec).toBe(1.5);
    expect(DEFAULT_RECORDING_OPTIONS).not.toHaveProperty("final_round_guard_sec");
    expect(DEFAULT_RECORDING_OPTIONS).not.toHaveProperty("final_round_win_panel_guard_sec");
  });

  test("does not let a derived round window enlarge the real EOF", () => {
    const request = buildRoundCompilationRecordingRequest(
      {
        round: 24,
        tick_rate: 64,
        clip_max_tick: 175_000,
        freeze_to_death_round_windows: [{
          round: 24,
          round_start_tick: 170_000,
          freeze_end_tick: 170_500,
          round_end_tick: 180_000,
          end_tick: 181_000,
        }],
      },
      queueItem,
      matchMeta,
    );

    expect(request.demo.demo_end_tick).toBe(177_914);
  });
});
