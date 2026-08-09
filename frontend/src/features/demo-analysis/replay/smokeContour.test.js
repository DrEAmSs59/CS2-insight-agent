import { expect, test } from "vitest";
import {
  MARCHING_SQUARES_SEGMENTS,
  buildDensityMask,
  dilateMask,
  marchingSquares,
  sampleCrossfadeAlpha,
} from "./smokeContour";

// BL=1, BR=2, TR=4, TL=8; edges 0=bottom, 1=right, 2=top, 3=left
test("marching-squares LUT cases 9/11/12 (and verified neighbors)", () => {
  expect(MARCHING_SQUARES_SEGMENTS[4]).toEqual([[1, 2]]);
  expect(MARCHING_SQUARES_SEGMENTS[5]).toEqual([[3, 0], [1, 2]]);
  expect(MARCHING_SQUARES_SEGMENTS[9]).toEqual([[0, 2]]);
  expect(MARCHING_SQUARES_SEGMENTS[10]).toEqual([[0, 1], [2, 3]]);
  expect(MARCHING_SQUARES_SEGMENTS[11]).toEqual([[1, 2]]);
  expect(MARCHING_SQUARES_SEGMENTS[12]).toEqual([[1, 3]]);
  expect(MARCHING_SQUARES_SEGMENTS[13]).toEqual([[0, 1]]);
});

test("buildDensityMask handles negative world coords", () => {
  const cells = [[-10, 90, 0, 1], [-10, 110, 0, 1]];
  const mask = buildDensityMask(cells, 20);
  let nonzero = 0;
  for (const v of mask.data) if (v > 0) nonzero += 1;
  expect(nonzero).toBeGreaterThanOrEqual(2);
});

test("buildDensityMask keeps diagonal occupancy", () => {
  const cells = [[0, 0, 0, 1], [20, 20, 0, 1], [40, 40, 0, 1]];
  const mask = buildDensityMask(cells, 20);
  expect(mask.width).toBeGreaterThanOrEqual(3);
  expect(mask.height).toBeGreaterThanOrEqual(3);
  // three distinct cells on diagonal must be non-zero
  let nonzero = 0;
  for (const v of mask.data) if (v > 0) nonzero += 1;
  expect(nonzero).toBe(3);
});

test("buildDensityMask preserves each smoke's arbitrary world-grid phase", () => {
  const cells = [
    [41.25, 1495.75, 1686, 1],
    [61.25, 1515.75, 1686, 0.8],
  ];
  const mask = buildDensityMask(cells, 20);
  // worldFromGrid(mask, 0, 0) must reconstruct the first voxel centre exactly.
  expect(mask.originX + mask.cellSize / 2).toBeCloseTo(41.25, 6);
  expect(mask.originY + mask.cellSize / 2).toBeCloseTo(1495.75, 6);
  expect(mask.width).toBe(2);
  expect(mask.height).toBe(2);
});

test("marchingSquares returns a ring for a filled block", () => {
  const cells = [];
  for (let x = 0; x <= 40; x += 20) for (let y = 0; y <= 40; y += 20) cells.push([x, y, 0, 1]);
  const mask = buildDensityMask(cells, 20);
  const { rings } = marchingSquares(mask, 0.15);
  expect(rings.length).toBeGreaterThanOrEqual(1);
  expect(rings[0].length).toBeGreaterThanOrEqual(3);
});

test("marchingSquares keeps disconnected smoke islands as separate rings", () => {
  const mask = buildDensityMask([
    [0, 0, 0, 1],
    [20, 0, 0, 1],
    [0, 20, 0, 1],
    [20, 20, 0, 1],
    [120, 120, 0, 1],
    [140, 120, 0, 1],
    [120, 140, 0, 1],
    [140, 140, 0, 1],
  ], 20);
  const { rings } = marchingSquares(mask, 0.15);
  expect(rings).toHaveLength(2);
  expect(rings.every((ring) => ring.length >= 3)).toBe(true);
});

test("sampleCrossfadeAlpha midpoints", () => {
  expect(sampleCrossfadeAlpha(100, 200, 150)).toEqual({ prevA: 0.5, nextA: 0.5 });
});

test("dilateMask expands occupancy by one cell", () => {
  const mask = buildDensityMask([[0, 0, 0, 1]], 20);
  const dilated = dilateMask(mask, 1);
  let nonzero = 0;
  for (const v of dilated.data) if (v > 0) nonzero += 1;
  expect(nonzero).toBeGreaterThan(1);
  expect(dilated.width).toBe(mask.width + 2);
  expect(dilated.height).toBe(mask.height + 2);
});
