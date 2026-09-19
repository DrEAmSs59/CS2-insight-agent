import { describe, expect, test } from "vitest";

import {
  DEFAULT_RECORDING_OPTIONS,
  buildHighlightRecordingRequest,
  buildRoundCompilationRecordingRequest,
} from "./recordingRequestFactory";
import { buildDtoFromQueueItem } from "./buildDtoFromQueueItem";
import { estimateItemRecordSeconds } from "../utils/recordingQueueDerive";


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

describe("kill/death pre/post padding", () => {
  const pacing = { pre_first_sec: 4, post_last_sec: 0.8 };

  test("maps shared padding onto fail and death compilation options", () => {
    const fail = buildDtoFromQueueItem(
      {
        ...queueItem,
        clipData: { category: "fail", death_tick: 10_000, round: 1, tick_rate: 64 },
        pacing_override: pacing,
      },
      matchMeta,
    );
    expect(fail.request_type).toBe("fail");
    expect(fail.options.death_pre_sec).toBe(4);
    expect(fail.options.death_post_sec).toBe(0.8);

    const deaths = buildDtoFromQueueItem(
      {
        ...queueItem,
        clipData: {
          category: "compilation",
          compilation_kind: "all_deaths",
          kill_ticks: [10_000, 12_000],
          round: 1,
          tick_rate: 64,
        },
        pacing_override: pacing,
      },
      matchMeta,
    );
    expect(deaths.request_type).toBe("death_compilation");
    expect(deaths.options.death_compilation_pre_sec).toBe(4);
    expect(deaths.options.death_compilation_post_sec).toBe(0.8);

    const timelineDeath = buildDtoFromQueueItem(
      {
        ...queueItem,
        clipData: {
          timeline_source: "round_timeline_event",
          timeline_record_kind: "death",
          category: "fail",
          death_tick: 10_000,
          round: 1,
          tick_rate: 64,
        },
        pacing_override: pacing,
      },
      matchMeta,
    );
    expect(timelineDeath.request_type).toBe("timeline_death");
    expect(timelineDeath.options.death_pre_sec).toBe(4);
    expect(timelineDeath.options.death_post_sec).toBe(0.8);
  });

  test("does not map victim POV sliders onto death windows", () => {
    const fail = buildDtoFromQueueItem(
      {
        ...queueItem,
        clipData: { category: "fail", death_tick: 10_000, round: 1, tick_rate: 64 },
        pacing_override: { victim_pov_pre_sec: 9, victim_pov_post_sec: 9 },
      },
      matchMeta,
    );
    expect(fail.options.death_pre_sec).toBe(DEFAULT_RECORDING_OPTIONS.death_pre_sec);
    expect(fail.options.death_post_sec).toBe(DEFAULT_RECORDING_OPTIONS.death_post_sec);
    expect(fail.options.victim_pov_pre_sec).toBe(9);
    expect(fail.options.victim_pov_post_sec).toBe(9);
  });

  test("estimates fail clip duration from shared pre/post padding", () => {
    const item = {
      ...queueItem,
      clipData: {
        category: "fail",
        death_tick: 10_000,
        start_tick: 10_000 - 64 * 6,
        end_tick: 10_000 + 64 * 3,
        round: 1,
      },
      pacing_override: pacing,
    };
    expect(estimateItemRecordSeconds(item, {})).toBe(Math.max(3, Math.round(4 + 0.8)));
  });
});
