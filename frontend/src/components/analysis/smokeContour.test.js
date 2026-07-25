import { describe, expect, test } from "vitest";
import { buildDensityMask, marchingSquares, sampleCrossfadeAlpha } from "./smokeContour";

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

test("marchingSquares returns a ring for a filled block", () => {
  const cells = [];
  for (let x = 0; x <= 40; x += 20) for (let y = 0; y <= 40; y += 20) cells.push([x, y, 0, 1]);
  const mask = buildDensityMask(cells, 20);
  const { rings } = marchingSquares(mask, 0.15);
  expect(rings.length).toBeGreaterThanOrEqual(1);
  expect(rings[0].length).toBeGreaterThanOrEqual(3);
});

test("sampleCrossfadeAlpha midpoints", () => {
  expect(sampleCrossfadeAlpha(100, 200, 150)).toEqual({ prevA: 0.5, nextA: 0.5 });
});
