/**
 * Smoke density mask + marching-squares contour helpers (pure JS).
 * smoothMask uses a local 3x3 weighted kernel; keep radiusCells <= 0.4 so diagonal edges survive.
 */

function maskIndex(mask, x, y) {
  return y * mask.width + x;
}

function sampleMask(mask, x, y) {
  if (x < 0 || y < 0 || x >= mask.width || y >= mask.height) return 0;
  return mask.data[maskIndex(mask, x, y)];
}

function worldFromGrid(mask, gx, gy) {
  return [
    mask.originX + (gx + 0.5) * mask.cellSize,
    mask.originY + (gy + 0.5) * mask.cellSize,
  ];
}

function lerpPoint(p0, p1, v0, v1, threshold) {
  if (v0 === v1) return [p0[0], p0[1]];
  const t = (threshold - v0) / (v1 - v0);
  return [
    p0[0] + t * (p1[0] - p0[0]),
    p0[1] + t * (p1[1] - p0[1]),
  ];
}

// edge index: 0 bottom, 1 right, 2 top, 3 left
const MARCHING_SQUARES_SEGMENTS = [
  [],
  [[3, 0]],
  [[0, 1]],
  [[3, 1]],
  [[1, 2]],
  [[3, 0], [1, 2]],
  [[0, 2]],
  [[3, 2]],
  [[2, 3]],
  [[0, 3]],
  [[0, 1], [2, 3]],
  [[1, 3]],
  [[1, 2]],
  [[0, 1]],
  [[0, 3]],
  [],
];

export function buildDensityMask(cells, cellSize) {
  if (!cells?.length) {
    return {
      originX: 0,
      originY: 0,
      width: 0,
      height: 0,
      cellSize,
      data: new Float32Array(0),
    };
  }

  let minGx = Infinity;
  let minGy = Infinity;
  let maxGx = -Infinity;
  let maxGy = -Infinity;
  const densities = new Map();

  for (const cell of cells) {
    const x = Number(cell[0]);
    const y = Number(cell[1]);
    const density = Number(cell[3]) || 0;
    const gx = Math.floor(x / cellSize);
    const gy = Math.floor(y / cellSize);
    minGx = Math.min(minGx, gx);
    minGy = Math.min(minGy, gy);
    maxGx = Math.max(maxGx, gx);
    maxGy = Math.max(maxGy, gy);
    const key = gx * 1_000_003 + gy;
    densities.set(key, Math.max(densities.get(key) || 0, density));
  }

  const width = maxGx - minGx + 1;
  const height = maxGy - minGy + 1;
  const data = new Float32Array(width * height);

  for (const [key, density] of densities) {
    const gy = key % 1_000_003;
    const gx = (key - gy) / 1_000_003;
    data[maskIndex({ width }, gx - minGx, gy - minGy)] = density;
  }

  return {
    originX: minGx * cellSize,
    originY: minGy * cellSize,
    width,
    height,
    cellSize,
    data,
  };
}

export function supersampleMask(mask, factor = 2) {
  const f = Math.max(1, Math.floor(factor));
  if (f === 1) return { ...mask, data: mask.data.slice() };

  const width = mask.width * f;
  const height = mask.height * f;
  const data = new Float32Array(width * height);
  const cellSize = mask.cellSize / f;

  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const srcX = x / f;
      const srcY = y / f;
      const x0 = Math.floor(srcX);
      const y0 = Math.floor(srcY);
      const x1 = Math.min(mask.width - 1, x0 + 1);
      const y1 = Math.min(mask.height - 1, y0 + 1);
      const tx = srcX - x0;
      const ty = srcY - y0;
      const v00 = sampleMask(mask, x0, y0);
      const v10 = sampleMask(mask, x1, y0);
      const v01 = sampleMask(mask, x0, y1);
      const v11 = sampleMask(mask, x1, y1);
      const top = v00 + (v10 - v00) * tx;
      const bottom = v01 + (v11 - v01) * tx;
      data[y * width + x] = top + (bottom - top) * ty;
    }
  }

  return {
    originX: mask.originX,
    originY: mask.originY,
    width,
    height,
    cellSize,
    data,
  };
}

const SMOOTH_KERNEL = [
  1, 2, 1,
  2, 4, 2,
  1, 2, 1,
];
const SMOOTH_KERNEL_SUM = 16;

export function smoothMask(mask, radiusCells = 0.35) {
  const { width, height } = mask;
  const out = new Float32Array(width * height);

  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      let sum = 0;
      let weight = 0;
      let ki = 0;
      for (let ky = -1; ky <= 1; ky += 1) {
        for (let kx = -1; kx <= 1; kx += 1) {
          const w = SMOOTH_KERNEL[ki];
          ki += 1;
          sum += sampleMask(mask, x + kx, y + ky) * w;
          weight += w;
        }
      }
      out[y * width + x] = sum / weight;
    }
  }

  return {
    originX: mask.originX,
    originY: mask.originY,
    width,
    height,
    cellSize: mask.cellSize,
    data: out,
  };
}

function edgeVertex(mask, x, y, edge, threshold, bl, br, tr, tl) {
  const pBl = worldFromGrid(mask, x, y);
  const pBr = worldFromGrid(mask, x + 1, y);
  const pTr = worldFromGrid(mask, x + 1, y + 1);
  const pTl = worldFromGrid(mask, x, y + 1);

  switch (edge) {
    case 0:
      return lerpPoint(pBl, pBr, bl, br, threshold);
    case 1:
      return lerpPoint(pBr, pTr, br, tr, threshold);
    case 2:
      return lerpPoint(pTl, pTr, tl, tr, threshold);
    case 3:
      return lerpPoint(pBl, pTl, bl, tl, threshold);
    default:
      return pBl;
  }
}

function samePoint(a, b, eps = 1e-4) {
  return Math.abs(a[0] - b[0]) <= eps && Math.abs(a[1] - b[1]) <= eps;
}

function segmentsToRings(segments) {
  if (!segments.length) return [];

  const unused = segments.map((seg) => ({ seg, used: false }));
  const rings = [];

  for (let i = 0; i < unused.length; i += 1) {
    if (unused[i].used) continue;

    const ring = [unused[i].seg[0], unused[i].seg[1]];
    unused[i].used = true;
    let current = ring[1];
    let guard = 0;

    while (guard < unused.length + 2) {
      guard += 1;
      let found = null;
      for (let j = 0; j < unused.length; j += 1) {
        if (unused[j].used) continue;
        const [a, b] = unused[j].seg;
        if (samePoint(a, current)) {
          found = { index: j, next: b };
          break;
        }
        if (samePoint(b, current)) {
          found = { index: j, next: a };
          break;
        }
      }
      if (!found) break;

      unused[found.index].used = true;
      if (samePoint(found.next, ring[0])) break;
      ring.push(found.next);
      current = found.next;
    }

    if (ring.length >= 3) rings.push(ring);
  }

  return rings;
}

export function marchingSquares(mask, threshold = 0.15) {
  const segments = [];

  for (let y = -1; y < mask.height; y += 1) {
    for (let x = -1; x < mask.width; x += 1) {
      const bl = sampleMask(mask, x, y);
      const br = sampleMask(mask, x + 1, y);
      const tr = sampleMask(mask, x + 1, y + 1);
      const tl = sampleMask(mask, x, y + 1);

      let caseIndex = 0;
      if (bl >= threshold) caseIndex |= 1;
      if (br >= threshold) caseIndex |= 2;
      if (tr >= threshold) caseIndex |= 4;
      if (tl >= threshold) caseIndex |= 8;

      const edges = MARCHING_SQUARES_SEGMENTS[caseIndex];
      for (const [e0, e1] of edges) {
        const p0 = edgeVertex(mask, x, y, e0, threshold, bl, br, tr, tl);
        const p1 = edgeVertex(mask, x, y, e1, threshold, bl, br, tr, tl);
        segments.push([p0, p1]);
      }
    }
  }

  return { rings: segmentsToRings(segments) };
}

export function sampleCrossfadeAlpha(prevTick, nextTick, currentTick) {
  if (nextTick === prevTick) {
    return { prevA: 1, nextA: 0 };
  }
  const t = Math.max(0, Math.min(1, (currentTick - prevTick) / (nextTick - prevTick)));
  return { prevA: 1 - t, nextA: t };
}
