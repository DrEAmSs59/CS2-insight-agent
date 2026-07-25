import { beforeEach, describe, expect, test, vi } from "vitest";
import { render } from "@testing-library/react";
import ReplayAreaEffectsCanvas, { selectActiveSample } from "./ReplayAreaEffectsCanvas";

describe("selectActiveSample", () => {
  const track = {
    start_tick: 100,
    end_tick: 200,
    samples: [
      { tick: 100, cells: [[1, 2, 3, 1]] },
      { tick: 150, cells: [[4, 5, 6, 1]] },
    ],
  };

  test("returns null before start and after end", () => {
    expect(selectActiveSample(track, 99)).toBeNull();
    expect(selectActiveSample(track, 201)).toBeNull();
  });

  test("picks latest sample not after current tick", () => {
    expect(selectActiveSample(track, 120)?.tick).toBe(100);
    expect(selectActiveSample(track, 150)?.tick).toBe(150);
    expect(selectActiveSample(track, 180)?.tick).toBe(150);
  });

  test("hides after round end even if track end is later", () => {
    expect(selectActiveSample(track, 180, 160)).toBeNull();
    expect(selectActiveSample(track, 150, 160)?.tick).toBe(150);
  });
});

describe("ReplayAreaEffectsCanvas", () => {
  beforeEach(() => {
    global.ResizeObserver = class {
      observe() {}
      unobserve() {}
      disconnect() {}
    };
  });

  test("renders canvas when tracks exist", () => {
    HTMLCanvasElement.prototype.getContext = vi.fn(() => ({
      setTransform: vi.fn(),
      clearRect: vi.fn(),
      save: vi.fn(),
      restore: vi.fn(),
      beginPath: vi.fn(),
      arc: vi.fn(),
      fill: vi.fn(),
      createRadialGradient: vi.fn(() => ({ addColorStop: vi.fn() })),
    }));
    const tracks = [{
      id: "inferno:0:100:1",
      type: "inferno",
      start_tick: 100,
      end_tick: 200,
      samples: [{ tick: 100, cells: [[0, 0, 0, 1]] }],
    }];
    const { container } = render(
      <ReplayAreaEffectsCanvas
        tracks={tracks}
        currentTick={120}
        transform={{ pos_x: 0, pos_y: 0, scale: 5 }}
        capabilities={{ inferno_cells: true, smoke_voxels: false, smoke_mode: "legacy_circle" }}
        enabled
      />,
    );
    expect(container.querySelector("canvas")).toBeTruthy();
  });

  test("skips smoke when capability false", () => {
    const createRadialGradient = vi.fn(() => ({ addColorStop: vi.fn() }));
    HTMLCanvasElement.prototype.getContext = vi.fn(() => ({
      setTransform: vi.fn(),
      clearRect: vi.fn(),
      save: vi.fn(),
      restore: vi.fn(),
      beginPath: vi.fn(),
      arc: vi.fn(),
      fill: vi.fn(),
      createRadialGradient,
    }));
    const tracks = [{
      id: "smoke:0:100:1",
      type: "smoke",
      start_tick: 100,
      end_tick: 200,
      samples: [{ tick: 100, cells: [[10, 20, 30, 1]] }],
    }];
    render(
      <ReplayAreaEffectsCanvas
        tracks={tracks}
        currentTick={120}
        transform={{ pos_x: 0, pos_y: 4096, scale: 5 }}
        capabilities={{ inferno_cells: true, smoke_voxels: false, smoke_mode: "legacy_circle" }}
        enabled
      />,
    );
    expect(createRadialGradient).not.toHaveBeenCalled();
  });

  test("radar_cells draws squares without radial gradients", () => {
    const createRadialGradient = vi.fn(() => ({ addColorStop: vi.fn() }));
    const fillRect = vi.fn();
    const strokeRect = vi.fn();
    HTMLCanvasElement.prototype.getContext = vi.fn(() => ({
      setTransform: vi.fn(),
      clearRect: vi.fn(),
      save: vi.fn(),
      restore: vi.fn(),
      beginPath: vi.fn(),
      arc: vi.fn(),
      fill: vi.fn(),
      fillRect,
      strokeRect,
      createRadialGradient,
    }));
    const tracks = [{
      id: "smoke:0:100:1",
      type: "smoke",
      start_tick: 100,
      end_tick: 200,
      cell_size: 20,
      samples: [{ tick: 100, cells: [[100, 200, 50, 1], [120, 220, 50, 1]] }],
    }];
    render(
      <ReplayAreaEffectsCanvas
        tracks={tracks}
        currentTick={120}
        transform={{ pos_x: 0, pos_y: 4096, scale: 5 }}
        capabilities={{ inferno_cells: true, smoke_voxels: true, smoke_mode: "voxels" }}
        smokeDebugLayer="radar_cells"
        enabled
      />,
    );
    expect(fillRect).toHaveBeenCalled();
    expect(strokeRect).toHaveBeenCalled();
    expect(createRadialGradient).not.toHaveBeenCalled();
  });

  test("smoke uses path fill not radial arcs", () => {
    const arc = vi.fn();
    const createRadialGradient = vi.fn(() => ({ addColorStop: vi.fn() }));
    const lineTo = vi.fn();
    const moveTo = vi.fn();
    const fill = vi.fn();
    const fillRect = vi.fn();
    HTMLCanvasElement.prototype.getContext = vi.fn(() => ({
      setTransform: vi.fn(),
      clearRect: vi.fn(),
      save: vi.fn(),
      restore: vi.fn(),
      beginPath: vi.fn(),
      closePath: vi.fn(),
      arc,
      fill,
      fillRect,
      moveTo,
      lineTo,
      createRadialGradient,
    }));
    const cells = [];
    for (let x = 100; x <= 140; x += 20) {
      for (let y = 200; y <= 240; y += 20) cells.push([x, y, 50, 1]);
    }
    const tracks = [{
      id: "smoke:0:100:1",
      type: "smoke",
      start_tick: 100,
      end_tick: 200,
      cell_size: 20,
      samples: [{ tick: 100, cells }],
    }];
    render(
      <ReplayAreaEffectsCanvas
        tracks={tracks}
        currentTick={120}
        transform={{ pos_x: 0, pos_y: 4096, scale: 5 }}
        capabilities={{ inferno_cells: true, smoke_voxels: true, smoke_mode: "voxels" }}
        smokeDebugLayer="final_render"
        enabled
      />,
    );
    expect(arc).not.toHaveBeenCalled();
    expect(createRadialGradient).not.toHaveBeenCalled();
    expect(fill).toHaveBeenCalled();
    expect(moveTo).toHaveBeenCalled();
    expect(lineTo).toHaveBeenCalled();
    expect(fillRect).not.toHaveBeenCalled();
  });

  test("crossfades active and next smoke samples mid-interval", () => {
    const fill = vi.fn();
    HTMLCanvasElement.prototype.getContext = vi.fn(() => ({
      setTransform: vi.fn(),
      clearRect: vi.fn(),
      save: vi.fn(),
      restore: vi.fn(),
      beginPath: vi.fn(),
      closePath: vi.fn(),
      arc: vi.fn(),
      fill,
      fillRect: vi.fn(),
      moveTo: vi.fn(),
      lineTo: vi.fn(),
      createRadialGradient: vi.fn(() => ({ addColorStop: vi.fn() })),
    }));
    const cellsA = [];
    for (let x = 100; x <= 140; x += 20) {
      for (let y = 200; y <= 240; y += 20) cellsA.push([x, y, 50, 1]);
    }
    const cellsB = [];
    for (let x = 200; x <= 240; x += 20) {
      for (let y = 300; y <= 340; y += 20) cellsB.push([x, y, 50, 1]);
    }
    const tracks = [{
      id: "smoke:0:100:1",
      type: "smoke",
      start_tick: 100,
      end_tick: 300,
      cell_size: 20,
      samples: [
        { tick: 100, cells: cellsA },
        { tick: 200, cells: cellsB },
      ],
    }];
    render(
      <ReplayAreaEffectsCanvas
        tracks={tracks}
        currentTick={150}
        transform={{ pos_x: 0, pos_y: 4096, scale: 5 }}
        capabilities={{ inferno_cells: true, smoke_voxels: true, smoke_mode: "voxels" }}
        smokeDebugLayer="final_render"
        enabled
      />,
    );
    expect(fill.mock.calls.length).toBeGreaterThanOrEqual(2);
  });

  test("inferno still uses radial arcs", () => {
    const arc = vi.fn();
    const createRadialGradient = vi.fn(() => ({ addColorStop: vi.fn() }));
    const fill = vi.fn();
    HTMLCanvasElement.prototype.getContext = vi.fn(() => ({
      setTransform: vi.fn(),
      clearRect: vi.fn(),
      save: vi.fn(),
      restore: vi.fn(),
      beginPath: vi.fn(),
      arc,
      fill,
      createRadialGradient,
    }));
    const tracks = [{
      id: "inferno:0:100:1",
      type: "inferno",
      start_tick: 100,
      end_tick: 200,
      samples: [{ tick: 100, cells: [[100, 200, 50, 1]] }],
    }];
    render(
      <ReplayAreaEffectsCanvas
        tracks={tracks}
        currentTick={120}
        transform={{ pos_x: 0, pos_y: 4096, scale: 5 }}
        capabilities={{ inferno_cells: true, smoke_voxels: true, smoke_mode: "voxels" }}
        enabled
      />,
    );
    expect(arc).toHaveBeenCalled();
    expect(createRadialGradient).toHaveBeenCalled();
    expect(fill).toHaveBeenCalled();
  });

  test("radar_cells keeps inferno on radial arcs not gray squares", () => {
    const arc = vi.fn();
    const createRadialGradient = vi.fn(() => ({ addColorStop: vi.fn() }));
    const fillRect = vi.fn();
    const fill = vi.fn();
    HTMLCanvasElement.prototype.getContext = vi.fn(() => ({
      setTransform: vi.fn(),
      clearRect: vi.fn(),
      save: vi.fn(),
      restore: vi.fn(),
      beginPath: vi.fn(),
      arc,
      fill,
      fillRect,
      strokeRect: vi.fn(),
      createRadialGradient,
    }));
    const tracks = [{
      id: "inferno:0:100:1",
      type: "inferno",
      start_tick: 100,
      end_tick: 200,
      samples: [{ tick: 100, cells: [[100, 200, 50, 1]] }],
    }];
    render(
      <ReplayAreaEffectsCanvas
        tracks={tracks}
        currentTick={120}
        transform={{ pos_x: 0, pos_y: 4096, scale: 5 }}
        capabilities={{ inferno_cells: true, smoke_voxels: true, smoke_mode: "voxels" }}
        smokeDebugLayer="radar_cells"
        enabled
      />,
    );
    expect(arc).toHaveBeenCalled();
    expect(createRadialGradient).toHaveBeenCalled();
    expect(fillRect).not.toHaveBeenCalled();
  });

  test("world_cells draws detonation crosshair when present", () => {
    const createRadialGradient = vi.fn(() => ({ addColorStop: vi.fn() }));
    const fillRect = vi.fn();
    const strokeRect = vi.fn();
    const lineTo = vi.fn();
    const moveTo = vi.fn();
    const stroke = vi.fn();
    HTMLCanvasElement.prototype.getContext = vi.fn(() => ({
      setTransform: vi.fn(),
      clearRect: vi.fn(),
      save: vi.fn(),
      restore: vi.fn(),
      beginPath: vi.fn(),
      arc: vi.fn(),
      fill: vi.fn(),
      fillRect,
      strokeRect,
      lineTo,
      moveTo,
      stroke,
      createRadialGradient,
    }));
    const tracks = [{
      id: "smoke:0:100:1",
      type: "smoke",
      start_tick: 100,
      end_tick: 200,
      cell_size: 20,
      samples: [{
        tick: 100,
        cells: [[100, 200, 50, 1]],
        detonation_pos: [150, 250, 55],
      }],
    }];
    render(
      <ReplayAreaEffectsCanvas
        tracks={tracks}
        currentTick={120}
        transform={{ pos_x: 0, pos_y: 4096, scale: 5 }}
        capabilities={{ inferno_cells: true, smoke_voxels: true, smoke_mode: "voxels" }}
        smokeDebugLayer="world_cells"
        enabled
      />,
    );
    expect(fillRect).toHaveBeenCalled();
    expect(createRadialGradient).not.toHaveBeenCalled();
    expect(moveTo).toHaveBeenCalled();
    expect(lineTo).toHaveBeenCalled();
    expect(stroke).toHaveBeenCalled();
  });
});
