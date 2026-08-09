import { describe, expect, test } from "vitest";
import { grenadeTrajectoryTimingIsValid } from "./replayGrenadeTrajectory";

describe("grenadeTrajectoryTimingIsValid", () => {
  test("accepts PR's long round-four Mirage smoke flight", () => {
    const trajectory = [
      { tick: 35_934, x: 1216, y: -211 },
      { tick: 36_326, x: 700, y: -400 },
      { tick: 36_440, x: -1207, y: -640 },
    ];

    expect(grenadeTrajectoryTimingIsValid(trajectory, 36_442, 64, true)).toBe(true);
  });

  test("rejects an old smoke trajectory with an effect-lifetime tail", () => {
    const trajectory = [
      { tick: 100, x: 100, y: 100 },
      { tick: 200, x: 200, y: 200 },
      { tick: 1_253, x: 200, y: 200 },
    ];

    expect(grenadeTrajectoryTimingIsValid(trajectory, 1_254, 64, true)).toBe(false);
  });

  test("rejects a path whose final sample is not near its detonation event", () => {
    const trajectory = [
      { tick: 100, x: 100, y: 100 },
      { tick: 500, x: 200, y: 200 },
    ];

    expect(grenadeTrajectoryTimingIsValid(trajectory, 900, 64, true)).toBe(false);
  });
});
