import { cleanup, render } from "@testing-library/react";
import { afterEach, expect, test, vi } from "vitest";
import ReplaySceneCanvas from "./ReplaySceneCanvas";
import { createPlayheadStore } from "./replayPlayback";

vi.mock("../../../api/api", () => ({ getDemoRadarMapUrl: () => "/radar.png" }));
vi.mock("./ReplayAreaEffectsCanvas", () => ({ default: () => null }));
vi.mock("./replayStore", () => ({ useReplayStore: { getState: () => ({ getCamera: () => null, setCamera: () => {} }) } }));
afterEach(cleanup);

function sceneFixture(z = 100) {
  const players = [{ name: "thrower", team: "T", x: 500, y: 1000, z, yaw: 0, health: 100 }];
  const frames = [90, 100, 125, 150, 175, 200, 201, 328, 329, 1352, 1353, 1500]
    .map((tick, index) => ({ tick, time_sec: index / 32, players, shots: [] }));
  const points = [
    { tick: 200, x: 1000, y: 1000 },
    { tick: 100, x: 500, y: 1000 },
    { tick: 150, x: 750, y: 1000 },
  ];
  const trajectory = [...points];
  const iterate = vi.fn(() => points[Symbol.iterator]());
  trajectory[Symbol.iterator] = iterate;
  const event = { type: "grenade", tick: 200, throw_tick: 100, kind: "smoke", actor: "thrower", x: 1000, y: 1000, trajectory };
  const props = {
    playheadStore: createPlayheadStore(), frames, playing: false, frameIndex: 3, mapName: "de_nuke", hasMapLayers: true, mapLayer: "upper",
    transform: { pos_x: 0, pos_y: 4096, scale: 5, lower_level_max_units: 0 },
    selectedRound: { start_tick: 90, end_tick: 1500, team_a_side: "T", team_b_side: "CT", shots: [] },
    roundEvents: [event], tickRate: 64, workspacePlayers: [{ name: "thrower", team_key: "a" }], playerLabelMode: "number",
    layers: { grenades: true, kills: false, shots: false, traces: false, utilityAreas: false }, effectTracks: [], effectCapabilities: {},
  };
  return { props, points, iterate };
}

test("reuses trajectory preparation across ticks and layers while preserving smoke boundaries and rewind", () => {
  const { props, points, iterate } = sceneFixture();
  const originalPoints = structuredClone(points);
  const view = render(<ReplaySceneCanvas {...props} />);
  const path = () => view.container.querySelector(".demo-grenade-trajectory")?.getAttribute("points");
  const firstPath = path();
  expect(firstPath).toBeTruthy();
  expect(iterate).toHaveBeenCalledTimes(1);
  const seek = (tick, extra = {}) => view.rerender(<ReplaySceneCanvas {...props} frameIndex={props.frames.findIndex(frame => frame.tick === tick)} {...extra} />);
  seek(175);
  expect(path()).not.toBe(firstPath);
  seek(150);
  expect(path()).toBe(firstPath);
  seek(150, { mapLayer: "lower" });
  expect(view.container.querySelector(".demo-grenade-projectile")).toBeNull();
  seek(150, { transform: { ...props.transform, scale: 4 } });
  expect(path()).not.toBe(firstPath);
  seek(90);
  expect(view.container.querySelector(".demo-grenade-projectile")).toBeNull();
  seek(200);
  expect(view.container.querySelector(".demo-smoke-effect")).toBeTruthy();
  seek(328);
  expect(path()).toBeTruthy();
  seek(329);
  expect(path()).toBeUndefined();
  expect(view.container.querySelector(".demo-smoke-effect")).toBeTruthy();
  seek(1352);
  expect(view.container.querySelector(".demo-smoke-effect")).toBeTruthy();
  seek(1353);
  expect(view.container.querySelector(".demo-smoke-effect")).toBeNull();
  seek(150);
  expect(path()).toBe(firstPath);
  expect(iterate).toHaveBeenCalledTimes(1);
  expect(points).toEqual(originalPoints);
  expect(points.every(point => !Object.hasOwn(point, "z"))).toBe(true);
});

test.each([undefined, null, "", Number.NaN])("refreshes missing trajectory z after frame replacement and layer toggles: %s", (z) => {
  const { props, iterate } = sceneFixture();
  const invalidFrames = props.frames.map(frame => ({ ...frame, players: frame.players.map(player => ({ ...player, z })) }));
  const view = render(<ReplaySceneCanvas {...props} frames={invalidFrames} />);
  expect(view.container.querySelector(".demo-grenade-projectile")).toBeNull();
  const lowerFrames = props.frames.map(frame => ({ ...frame, players: frame.players.map(player => ({ ...player, z: -100 })) }));
  view.rerender(<ReplaySceneCanvas {...props} frames={lowerFrames} mapLayer="lower" />);
  expect(view.container.querySelector(".demo-grenade-projectile")).toBeTruthy();
  expect(iterate).toHaveBeenCalledTimes(2);
  view.rerender(<ReplaySceneCanvas {...props} frames={lowerFrames} mapLayer="lower" layers={{ ...props.layers, grenades: false }} />);
  expect(view.container.querySelector(".demo-grenade-projectile")).toBeNull();
  expect(iterate).toHaveBeenCalledTimes(2);
  view.rerender(<ReplaySceneCanvas {...props} frames={lowerFrames} mapLayer="lower" />);
  expect(view.container.querySelector(".demo-grenade-projectile")).toBeTruthy();
  expect(iterate).toHaveBeenCalledTimes(3);
  const nextEvent = { ...props.roundEvents[0], actor: "other", trajectory: [
    { tick: 100, x: 1500, y: 1000, z: 100 },
    { tick: 200, x: 1000, y: 1000, z: 100 },
  ] };
  view.rerender(<ReplaySceneCanvas {...props} frames={lowerFrames} roundEvents={[nextEvent]} selectedRound={{ ...props.selectedRound, round_number: 2 }} />);
  expect(view.container.querySelector(".demo-grenade-projectile")).toBeTruthy();
  expect(iterate).toHaveBeenCalledTimes(3);
});

test("collects frame shots once and refreshes the list on source replacement or re-enable", () => {
  const { props, iterate } = sceneFixture();
  props.layers = { ...props.layers, grenades: false, shots: true };
  const shot = { tick: 150, actor: "thrower", x: 600, y: 1000, z: 100, yaw: 0 };
  props.frames[3].shots = [shot];
  const flatten = vi.spyOn(props.frames, "flatMap");
  const view = render(<ReplaySceneCanvas {...props} />);
  const origin = () => view.container.querySelector(".demo-shot-tracer")?.getAttribute("x1");
  const firstOrigin = origin();
  expect(firstOrigin).toBeTruthy();
  expect(flatten).toHaveBeenCalledTimes(1);
  view.rerender(<ReplaySceneCanvas {...props} frameIndex={4} />);
  expect(origin()).toBeUndefined();
  view.rerender(<ReplaySceneCanvas {...props} />);
  expect(origin()).toBe(firstOrigin);
  expect(flatten).toHaveBeenCalledTimes(1);
  view.rerender(<ReplaySceneCanvas {...props} selectedRound={{ ...props.selectedRound, shots: [{ ...shot, x: 900 }] }} />);
  expect(origin()).not.toBe(firstOrigin);
  expect(flatten).toHaveBeenCalledTimes(1);
  const nextFrames = props.frames.map(frame => ({ ...frame, shots: frame.tick === 150 ? [{ ...shot, x: 1200 }] : [] }));
  const nextFlatten = vi.spyOn(nextFrames, "flatMap");
  view.rerender(<ReplaySceneCanvas {...props} frames={nextFrames} />);
  expect(Number(origin())).toBe(Number(firstOrigin) * 2);
  expect(nextFlatten).toHaveBeenCalledTimes(1);
  view.rerender(<ReplaySceneCanvas {...props} frames={nextFrames} layers={{ ...props.layers, shots: false }} />);
  expect(origin()).toBeUndefined();
  view.rerender(<ReplaySceneCanvas {...props} frames={nextFrames} />);
  expect(origin()).toBeTruthy();
  expect(nextFlatten).toHaveBeenCalledTimes(2);
  expect(iterate).not.toHaveBeenCalled();
});
