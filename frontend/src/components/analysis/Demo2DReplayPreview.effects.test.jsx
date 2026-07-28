import { render } from "@testing-library/react";
import { describe, expect, test } from "vitest";
import { ReplayRosterAmbientEffect, replayEndTickForRound } from "./Demo2DReplayPreview";

describe("ReplayRosterAmbientEffect", () => {
  test("uses compositor-friendly static sheets without a Canvas frame loop", () => {
    const view = render(
      <ReplayRosterAmbientEffect smoked burning mirrored />,
    );

    const effect = view.container.querySelector('[data-effect-renderer="static-css"]');
    expect(effect).toBeTruthy();
    expect(effect?.getAttribute("style")).toContain("scaleX(-1)");
    expect(effect?.querySelector(".replay-roster-smoke-sheet")).toBeTruthy();
    expect(effect?.querySelector(".replay-roster-fire-sheet")).toBeTruthy();
    expect(effect?.querySelector("canvas")).toBeNull();
  });

  test("does not mount an overlay when the player is clear", () => {
    const view = render(
      <ReplayRosterAmbientEffect smoked={false} burning={false} mirrored={false} />,
    );

    expect(view.container.firstChild).toBeNull();
  });
});

describe("replayEndTickForRound", () => {
  test("keeps every round alive for its post-kill result tail", () => {
    const rounds = [
      { round_number: 1, end_tick: 1_000, round_end_tick: 900 },
      { round_number: 2, end_tick: 2_000, round_end_tick: 2_000 },
    ];

    expect(replayEndTickForRound(rounds[0], rounds, { demo_end_tick: 2_500 }, 64)).toBe(1_092);
    expect(replayEndTickForRound(rounds[1], rounds, { demo_end_tick: 2_500 }, 64)).toBe(2_192);
  });

  test("caps a post-kill tail at the next round start", () => {
    const rounds = [
      { round_number: 1, end_tick: 1_000, round_end_tick: 1_000 },
      { round_number: 2, start_tick: 1_100, end_tick: 2_000, round_end_tick: 2_000 },
    ];

    expect(replayEndTickForRound(rounds[0], rounds, { demo_end_tick: 2_500 }, 64)).toBe(1_099);
  });

  test("caps the final tail at the real demo end", () => {
    const round = { round_number: 1, end_tick: 2_000, round_end_tick: 2_000 };
    expect(replayEndTickForRound(round, [round], { demo_end_tick: 2_080 }, 64)).toBe(2_080);
  });
});
