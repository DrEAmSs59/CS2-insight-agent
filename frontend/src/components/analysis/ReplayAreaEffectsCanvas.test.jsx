import { beforeEach, describe, expect, test, vi } from "vitest";
import { render } from "@testing-library/react";
import ReplayAreaEffectsCanvas, { applyUtilityClip, selectActiveSample } from "./ReplayAreaEffectsCanvas";

/** Minimal ImageData-backed 2d context for destination-in clip tests (jsdom has no canvas). */
function createImageDataCanvas(width, height) {
  const pixels = new Uint8ClampedArray(width * height * 4);
  const canvas = { width, height };
  const stack = [];
  const ctx = {
    canvas,
    fillStyle: "#000",
    globalCompositeOperation: "source-over",
    save() {
      stack.push({ fillStyle: this.fillStyle, globalCompositeOperation: this.globalCompositeOperation });
    },
    restore() {
      const prev = stack.pop();
      if (!prev) return;
      this.fillStyle = prev.fillStyle;
      this.globalCompositeOperation = prev.globalCompositeOperation;
    },
    fillRect(x, y, w, h) {
      const color = parseCssColor(this.fillStyle);
      const x0 = Math.max(0, Math.floor(x));
      const y0 = Math.max(0, Math.floor(y));
      const x1 = Math.min(width, Math.ceil(x + w));
      const y1 = Math.min(height, Math.ceil(y + h));
      for (let py = y0; py < y1; py += 1) {
        for (let px = x0; px < x1; px += 1) {
          const i = (py * width + px) * 4;
          if (this.globalCompositeOperation === "destination-in") {
            const ma = color[3] / 255;
            pixels[i + 3] = Math.round(pixels[i + 3] * ma);
            if (pixels[i + 3] === 0) {
              pixels[i] = 0;
              pixels[i + 1] = 0;
              pixels[i + 2] = 0;
            }
          } else {
            pixels[i] = color[0];
            pixels[i + 1] = color[1];
            pixels[i + 2] = color[2];
            pixels[i + 3] = color[3];
          }
        }
      }
    },
    drawImage(source, dx, dy, dw, dh) {
      const src = source.__pixels || source;
      const sw = source.width || width;
      const sh = source.height || height;
      const destW = dw ?? sw;
      const destH = dh ?? sh;
      for (let py = 0; py < destH; py += 1) {
        for (let px = 0; px < destW; px += 1) {
          const sx = Math.min(sw - 1, Math.floor((px / destW) * sw));
          const sy = Math.min(sh - 1, Math.floor((py / destH) * sh));
          const si = (sy * sw + sx) * 4;
          const di = ((dy + py) * width + (dx + px)) * 4;
          if (di < 0 || di + 3 >= pixels.length) continue;
          const ma = (src[si + 3] ?? 255) / 255;
          // White mask → high alpha; black → 0. Use luminance * alpha as coverage.
          const lum = ((src[si] + src[si + 1] + src[si + 2]) / 3) / 255;
          const cover = lum * ma;
          if (this.globalCompositeOperation === "destination-in") {
            pixels[di + 3] = Math.round(pixels[di + 3] * cover);
            if (pixels[di + 3] === 0) {
              pixels[di] = 0;
              pixels[di + 1] = 0;
              pixels[di + 2] = 0;
            }
          } else {
            pixels[di] = src[si];
            pixels[di + 1] = src[si + 1];
            pixels[di + 2] = src[si + 2];
            pixels[di + 3] = src[si + 3];
          }
        }
      }
    },
    getImageData(x, y, w, h) {
      const out = new Uint8ClampedArray(w * h * 4);
      for (let row = 0; row < h; row += 1) {
        for (let col = 0; col < w; col += 1) {
          const si = ((y + row) * width + (x + col)) * 4;
          const di = (row * w + col) * 4;
          out[di] = pixels[si];
          out[di + 1] = pixels[si + 1];
          out[di + 2] = pixels[si + 2];
          out[di + 3] = pixels[si + 3];
        }
      }
      return { data: out, width: w, height: h };
    },
  };
  canvas.getContext = () => ctx;
  canvas.__pixels = pixels;
  return canvas;
}

function parseCssColor(style) {
  if (style === "#000" || style === "#000000") return [0, 0, 0, 255];
  if (style === "#fff" || style === "#ffffff") return [255, 255, 255, 255];
  const m = String(style).match(/rgba?\(([^)]+)\)/i);
  if (!m) return [0, 0, 0, 255];
  const parts = m[1].split(",").map((p) => Number(p.trim()));
  return [parts[0] || 0, parts[1] || 0, parts[2] || 0, parts.length > 3 ? Math.round(parts[3] * 255) : 255];
}

describe("applyUtilityClip", () => {
  test("applyUtilityClip zeros outside white mask", () => {
    const canvas = createImageDataCanvas(4, 4);
    const ctx = canvas.getContext("2d");
    ctx.fillStyle = "rgba(255,0,0,1)";
    ctx.fillRect(0, 0, 4, 4);
    const mask = createImageDataCanvas(4, 4);
    const mctx = mask.getContext("2d");
    mctx.fillStyle = "#000";
    mctx.fillRect(0, 0, 4, 4);
    mctx.fillStyle = "#fff";
    mctx.fillRect(0, 0, 2, 2);
    applyUtilityClip(ctx, mask);
    const outside = ctx.getImageData(3, 3, 1, 1).data[3];
    const inside = ctx.getImageData(0, 0, 1, 1).data[3];
    expect(outside).toBe(0);
    expect(inside).toBeGreaterThan(0);
  });

  test("applyUtilityClip no-ops when mask is missing", () => {
    const canvas = createImageDataCanvas(2, 2);
    const ctx = canvas.getContext("2d");
    ctx.fillStyle = "rgba(255,0,0,1)";
    ctx.fillRect(0, 0, 2, 2);
    applyUtilityClip(ctx, null);
    expect(ctx.getImageData(0, 0, 1, 1).data[3]).toBe(255);
  });
});

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
      fillRect: vi.fn(),
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

  test("inferno uses occupancy squares not radial bloom", () => {
    const arc = vi.fn();
    const createRadialGradient = vi.fn(() => ({ addColorStop: vi.fn() }));
    const fill = vi.fn();
    const fillRect = vi.fn();
    HTMLCanvasElement.prototype.getContext = vi.fn(() => ({
      setTransform: vi.fn(),
      clearRect: vi.fn(),
      save: vi.fn(),
      restore: vi.fn(),
      beginPath: vi.fn(),
      arc,
      fill,
      fillRect,
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
    expect(fillRect).toHaveBeenCalled();
    expect(arc).not.toHaveBeenCalled();
    expect(createRadialGradient).not.toHaveBeenCalled();
  });

  test("radar_cells keeps inferno on occupancy squares not gray debug stroke", () => {
    const arc = vi.fn();
    const createRadialGradient = vi.fn(() => ({ addColorStop: vi.fn() }));
    const fillRect = vi.fn();
    const strokeRect = vi.fn();
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
      strokeRect,
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
    expect(fillRect).toHaveBeenCalled();
    expect(arc).not.toHaveBeenCalled();
    expect(createRadialGradient).not.toHaveBeenCalled();
    expect(strokeRect).not.toHaveBeenCalled();
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
