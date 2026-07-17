import { describe, expect, test } from "vitest";

import { applySessionKbOverlayToRequests } from "./recordingBatch";


describe("recording batch overlay options", () => {
  test("propagates keyboard and kill FX settings without dropping existing options", () => {
    const [request] = applySessionKbOverlayToRequests(
      [{ request_id: "r1", options: { highlight_pre_sec: 3 } }],
      {
        kb_overlay_enabled: false,
        kb_overlay_tick_offset: 8,
        kb_overlay_position: "weapon_right",
        kill_fx_enabled: true,
        kill_fx_tick_offset: -2,
      },
    );

    expect(request.options).toEqual({
      highlight_pre_sec: 3,
      kb_overlay_enabled: false,
      kb_overlay_tick_offset: 8,
      kb_overlay_position: "weapon_right",
      kill_fx_enabled: true,
      kill_fx_tick_offset: -2,
    });
  });

  test("keeps a kill-FX-only caller independent from the keyboard offset", () => {
    const [request] = applySessionKbOverlayToRequests(
      [{ request_id: "r1", options: {} }],
      { kill_fx_enabled: true, kb_overlay_tick_offset: -4, kill_fx_tick_offset: 3 },
    );

    expect(request.options).toEqual({
      kill_fx_enabled: true,
      kill_fx_tick_offset: 3,
    });
  });
});
