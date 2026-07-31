/*---------------------------------------------------------------------------------------------
 *  Copyright (c) unicbm. All rights reserved.
 *  Licensed under the PolyForm Noncommercial License 1.0.0. See LICENSE in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

export function makeCanvas(width, height) {
  const w = Math.max(1, Math.floor(Number(width) || 1));
  const h = Math.max(1, Math.floor(Number(height) || 1));
  if (typeof OffscreenCanvas !== "undefined") return new OffscreenCanvas(w, h);
  if (typeof document === "undefined" || !document.createElement) return null;
  const canvas = document.createElement("canvas");
  canvas.width = w;
  canvas.height = h;
  return canvas;
}

export function resizeCanvas(canvas, width, height) {
  const w = Math.max(1, Math.floor(Number(width) || 1));
  const h = Math.max(1, Math.floor(Number(height) || 1));
  if (canvas.width !== w) canvas.width = w;
  if (canvas.height !== h) canvas.height = h;
}

function luminancePixelsToAlphaBuffer(srcPixels, sw, sh, w, h) {
  const out = new Uint8ClampedArray(w * h * 4);
  for (let py = 0; py < h; py += 1) {
    for (let px = 0; px < w; px += 1) {
      const sx = Math.min(sw - 1, Math.floor((px / w) * sw));
      const sy = Math.min(sh - 1, Math.floor((py / h) * sh));
      const si = (sy * sw + sx) * 4;
      const di = (py * w + px) * 4;
      const lum = Math.round((srcPixels[si] + srcPixels[si + 1] + srcPixels[si + 2]) / 3);
      out[di] = 255;
      out[di + 1] = 255;
      out[di + 2] = 255;
      out[di + 3] = lum;
    }
  }
  return out;
}

/** Convert a decoded grayscale mask once; callers should cache the result. */
export function luminanceMaskToAlphaCanvas(img, targetW, targetH) {
  if (!img) return null;
  const sw = Number(img.width) || 0;
  const sh = Number(img.height) || 0;
  if (sw <= 0 || sh <= 0) return null;
  const w = Number.isFinite(targetW) && targetW > 0 ? Math.floor(targetW) : sw;
  const h = Number.isFinite(targetH) && targetH > 0 ? Math.floor(targetH) : sh;
  if (w <= 0 || h <= 0) return null;

  const srcPixels = img.__pixels || (img.data instanceof Uint8ClampedArray ? img.data : null);
  if (srcPixels) {
    return { width: w, height: h, __pixels: luminancePixelsToAlphaBuffer(srcPixels, sw, sh, w, h) };
  }

  const canvas = makeCanvas(w, h);
  if (!canvas || typeof canvas.getContext !== "function") return null;
  const ctx = canvas.getContext("2d", { willReadFrequently: true });
  if (!ctx) return null;
  ctx.drawImage(img, 0, 0, w, h);
  let imageData;
  try {
    imageData = ctx.getImageData(0, 0, w, h);
  } catch {
    return canvas;
  }
  const data = imageData.data;
  for (let i = 0; i < data.length; i += 4) {
    const lum = Math.round((data[i] + data[i + 1] + data[i + 2]) / 3);
    data[i] = 255;
    data[i + 1] = 255;
    data[i + 2] = 255;
    data[i + 3] = lum;
  }
  ctx.putImageData(imageData, 0, 0);
  return canvas;
}

export function applyUtilityClip(ctx, maskSource, preparedAlphaMask = null) {
  if (!maskSource || !ctx) return;
  const w = ctx.canvas?.width;
  const h = ctx.canvas?.height;
  if (!Number.isFinite(w) || !Number.isFinite(h) || w <= 0 || h <= 0) return;
  const alphaMask = preparedAlphaMask || luminanceMaskToAlphaCanvas(maskSource, w, h);
  if (!alphaMask) return;
  ctx.save();
  ctx.globalCompositeOperation = "destination-in";
  ctx.drawImage(alphaMask, 0, 0, w, h);
  ctx.restore();
}
