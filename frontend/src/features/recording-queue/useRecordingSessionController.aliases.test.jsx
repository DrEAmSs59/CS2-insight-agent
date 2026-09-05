/*---------------------------------------------------------------------------------------------
 *  Copyright (c) unicbm. All rights reserved.
 *  Licensed under the PolyForm Noncommercial License 1.0.0. See LICENSE in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { act, renderHook } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import API from "../../api/api";
import { useRecordingSessionController } from "./useRecordingSessionController.js";

vi.mock("../../api/api", () => ({ default: { get: vi.fn(), post: vi.fn() } }));
vi.mock("../../utils/recordingBatch", () => ({
  buildRecordingQueueRequestsFromQueue: (queue) => queue.map((item) => ({
    request_id: item.id,
    source_ref: { queue_item_id: item.id },
    demo: { demo_path: `/${item.id}.dem`, demo_filename: `${item.id}.dem` },
  })),
  applySessionObsTransitionToRequests: (requests) => requests,
}));

describe("recording queue player aliases", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    API.get.mockResolvedValue({ data: { restore_required: false } });
    API.post.mockImplementation(async (url) => ({
      data: url === "/obs/config-check" ? { connected: true } : [],
    }));
  });

  it("keeps per-demo aliases separate from console warmup and POV options", async () => {
    const options = {
      t: (key) => key,
      setProgressText: vi.fn(),
      setQueueDrawerOpen: vi.fn(),
      queue: [{ id: "demo-a" }, { id: "demo-b" }],
      clearQueue: vi.fn(),
      obsConfig: {},
      uploadedDemos: [],
      parsedMatches: {},
      demoLibraryItems: [],
    };
    const { result } = renderHook(() => useRecordingSessionController(options));
    await act(async () => { await result.current.openBatchWarmup(); });
    expect(result.current.recordingAliasDemos.map((demo) => demo.key)).toEqual([
      "/demo-a.dem",
      "/demo-b.dem",
    ]);
    const aliases = { "76561199032006224": "京介" };
    await act(async () => {
      await result.current.handleWarmupConfirm({
        experimental_pov_enabled: false,
        recording_map_material: "default",
        recording_weather_effect: "rain",
        player_aliases_by_demo: { "/demo-a.dem": aliases },
        resolution_width: 1920,
        resolution_height: 1440,
      });
    });
    const body = API.post.mock.calls.find(([url]) => url === "recording/queue")[1];
    expect(body.requests[0].player_aliases).toEqual(aliases);
    expect(body.requests[1]).not.toHaveProperty("player_aliases");
    expect(body.warmup).toEqual({ resolution_width: 1920, resolution_height: 1440 });
    expect(body.map_material).toEqual({ id: "default" });
    expect(body.weather).toEqual({ id: "rain" });
    expect(body.pov_hud).toEqual({
      enabled: false,
      radar_mode: 0,
      teamcounter_numeric: false,
      voice_mode: "team",
      input_hud_enabled: true,
      input_hud_display_mode: "hybrid",
      input_audio_enabled: false,
      combat_stats_hud_enabled: true,
    });
  });
});
