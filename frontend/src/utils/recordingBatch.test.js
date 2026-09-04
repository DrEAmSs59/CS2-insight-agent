import { describe, expect, test } from "vitest";

import { applySessionKillFxToRequests } from "./recordingBatch";


describe("recording batch overlay options", () => {
  test("propagates kill FX settings without dropping existing options", () => {
    const [request] = applySessionKillFxToRequests(
      [{ request_id: "r1", options: { highlight_pre_sec: 3 } }],
      {
        kill_fx_enabled: true,
        kill_fx_tick_offset: -2,
      },
    );

    expect(request.options).toEqual({
      highlight_pre_sec: 3,
      kill_fx_enabled: true,
      kill_fx_tick_offset: -2,
    });
  });

  test("keeps the configured kill FX offset", () => {
    const [request] = applySessionKillFxToRequests(
      [{ request_id: "r1", options: {} }],
      { kill_fx_enabled: true, kill_fx_tick_offset: 3 },
    );

    expect(request.options).toEqual({
      kill_fx_enabled: true,
      kill_fx_tick_offset: 3,
    });
  });
});
