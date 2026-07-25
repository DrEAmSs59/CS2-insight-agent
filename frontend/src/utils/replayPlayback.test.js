import { describe, expect, it } from "vitest";
import {
  createReplayClock,
  findPreviousFrameIndex,
  frameBracket,
  interpolateReplayFrame,
  lerpAngle,
  lerpNumber,
  replayPositionForTime,
  resolvePlaybackStartSeconds,
  secondsForFramePosition,
} from "./replayPlayback";

describe("lerpAngle", () => {
  it("takes shortest path across 359→1", () => {
    expect(lerpAngle(359, 1, 0.5)).toBeCloseTo(0, 5);
  });

  it("lerps forward without wrapping when unnecessary", () => {
    expect(lerpAngle(10, 50, 0.5)).toBeCloseTo(30, 5);
  });
});

describe("lerpNumber", () => {
  it("linearly interpolates", () => {
    expect(lerpNumber(0, 100, 0.25)).toBe(25);
  });
});

describe("findPreviousFrameIndex / frameBracket", () => {
  const frames = [
    { tick: 100, time_sec: 0, players: [{ name: "a", x: 0, y: 0, yaw: 0 }] },
    { tick: 108, time_sec: 0.125, players: [{ name: "a", x: 100, y: 0, yaw: 90 }] },
    { tick: 116, time_sec: 0.25, players: [{ name: "a", x: 200, y: 0, yaw: 180 }] },
  ];

  it("finds previous frame by tick with uneven spacing", () => {
    expect(findPreviousFrameIndex(frames, 108)).toBe(1);
    expect(findPreviousFrameIndex(frames, 110)).toBe(1);
    expect(findPreviousFrameIndex(frames, 99)).toBe(0);
  });

  it("computes linear ratio between uneven ticks", () => {
    const { ratio, index } = frameBracket(frames, 110);
    expect(index).toBe(1);
    expect(ratio).toBeCloseTo(0.25, 5);
  });
});

describe("interpolateReplayFrame", () => {
  const frames = [
    { tick: 100, time_sec: 0, players: [{ name: "a", steamid64: "1", x: 0, y: 0, z: 0, yaw: 359, weapon: "ak" }] },
    { tick: 108, time_sec: 0.125, players: [{ name: "a", steamid64: "1", x: 80, y: 40, z: 10, yaw: 1, weapon: "awp" }] },
  ];

  it("uses linear position interpolation (not smoothstep)", () => {
    const mid = interpolateReplayFrame(frames, 104);
    expect(mid.players[0].x).toBeCloseTo(40, 5);
    expect(mid.players[0].y).toBeCloseTo(20, 5);
  });

  it("lerps yaw across wrap with shortest path", () => {
    const mid = interpolateReplayFrame(frames, 104);
    expect(mid.players[0].yaw).toBeCloseTo(0, 5);
  });

  it("steps weapon at midpoint", () => {
    const early = interpolateReplayFrame(frames, 102);
    const late = interpolateReplayFrame(frames, 106);
    expect(early.players[0].weapon).toBe("ak");
    expect(late.players[0].weapon).toBe("awp");
  });
});

describe("secondsForFramePosition / replayPositionForTime", () => {
  const frames = [
    { tick: 100, time_sec: 0 },
    { tick: 108, time_sec: 0.125 },
    { tick: 116, time_sec: 0.25 },
  ];

  it("keeps fractional mid-sample seconds (not floor sample boundary)", () => {
    const position = 0.5;
    const seconds = secondsForFramePosition(frames, position);
    expect(seconds).toBeCloseTo(0.0625, 5);
    // Floor-snapped start would incorrectly use frames[0].time_sec === 0 (~125ms snap).
    expect(Number(frames[Math.floor(position)].time_sec)).toBe(0);
    expect(seconds).not.toBe(0);
  });

  it("round-trips fractional position through pause/resume seconds", () => {
    const position = 1.25;
    const seconds = secondsForFramePosition(frames, position);
    const restored = replayPositionForTime(frames, seconds);
    expect(restored).toBeCloseTo(position, 5);
    expect(resolvePlaybackStartSeconds(frames, position, seconds)).toBeCloseTo(seconds, 5);
    expect(resolvePlaybackStartSeconds(frames, position, null)).toBeCloseTo(seconds, 5);
  });
});

describe("createReplayClock", () => {
  it("does not permanently lag after a long frame stall", () => {
    let now = 1000;
    const clock = createReplayClock({ offsetSeconds: 0, rate: 1, now: () => now });
    clock.play(1000);
    now = 1100; // 100ms
    expect(clock.getPlayheadSeconds()).toBeCloseTo(0.1, 5);
    now = 1600; // 500ms stall later
    expect(clock.getPlayheadSeconds()).toBeCloseTo(0.6, 5);
  });

  it("pause freezes offset and resume continues", () => {
    let now = 0;
    const clock = createReplayClock({ now: () => now });
    clock.play(0);
    now = 500;
    clock.pause(500);
    expect(clock.getPlayheadSeconds()).toBeCloseTo(0.5, 5);
    now = 5000;
    expect(clock.getPlayheadSeconds()).toBeCloseTo(0.5, 5);
    clock.play(5000);
    now = 5200;
    expect(clock.getPlayheadSeconds()).toBeCloseTo(0.7, 5);
  });

  it("respects playback rate", () => {
    let now = 0;
    const clock = createReplayClock({ rate: 2, now: () => now });
    clock.play(0);
    now = 1000;
    expect(clock.getPlayheadSeconds()).toBeCloseTo(2, 5);
  });
});
