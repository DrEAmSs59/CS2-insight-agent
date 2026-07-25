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
});
