import { render } from "@testing-library/react";
import { describe, expect, test } from "vitest";
import { ReplayRosterAmbientEffect } from "./Demo2DReplayPreview";

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
