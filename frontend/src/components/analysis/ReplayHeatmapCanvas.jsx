import { memo, useEffect, useRef } from "react";

const RENDER_SIZE = 256;
const COLOR_STOPS = [
  [0, 24, 74, 160, 0],
  [0.08, 37, 99, 235, 18],
  [0.28, 34, 211, 238, 105],
  [0.5, 250, 204, 21, 155],
  [0.72, 249, 115, 22, 195],
  [1, 225, 29, 72, 225],
];

function interpolateColor(value) {
  const normalized = Math.max(0, Math.min(1, Number(value) || 0));
  let left = COLOR_STOPS[0];
  let right = COLOR_STOPS.at(-1);
  for (let index = 1; index < COLOR_STOPS.length; index += 1) {
    if (normalized <= COLOR_STOPS[index][0]) {
      left = COLOR_STOPS[index - 1];
      right = COLOR_STOPS[index];
      break;
    }
  }
  const span = Math.max(0.0001, right[0] - left[0]);
  const ratio = (normalized - left[0]) / span;
  return [
    Math.round(left[1] + (right[1] - left[1]) * ratio),
    Math.round(left[2] + (right[2] - left[2]) * ratio),
    Math.round(left[3] + (right[3] - left[3]) * ratio),
    Math.round(left[4] + (right[4] - left[4]) * ratio),
  ];
}

function bilinearValue(heatmap, x, y) {
  const size = Number(heatmap?.size) || 0;
  const values = heatmap?.values;
  if (size < 2 || !(values instanceof Float32Array)) return 0;
  const gridX = (x / (RENDER_SIZE - 1)) * (size - 1);
  const gridY = (y / (RENDER_SIZE - 1)) * (size - 1);
  const x0 = Math.floor(gridX);
  const y0 = Math.floor(gridY);
  const x1 = Math.min(size - 1, x0 + 1);
  const y1 = Math.min(size - 1, y0 + 1);
  const fx = gridX - x0;
  const fy = gridY - y0;
  const top = values[y0 * size + x0] * (1 - fx) + values[y0 * size + x1] * fx;
  const bottom = values[y1 * size + x0] * (1 - fx) + values[y1 * size + x1] * fx;
  return top * (1 - fy) + bottom * fy;
}

export default memo(function ReplayHeatmapCanvas({ heatmap, mode = "off" }) {
  const canvasRef = useRef(null);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas || !heatmap || mode === "off") return;
    // jsdom exposes getContext but only emits a noisy "not implemented" error.
    if (typeof navigator !== "undefined" && /jsdom/i.test(navigator.userAgent)) return;
    const context = canvas.getContext("2d", { alpha: true });
    if (!context) return;
    const image = context.createImageData(RENDER_SIZE, RENDER_SIZE);
    for (let y = 0; y < RENDER_SIZE; y += 1) {
      for (let x = 0; x < RENDER_SIZE; x += 1) {
        const value = bilinearValue(heatmap, x, y);
        const [red, green, blue, alpha] = interpolateColor(value);
        const offset = (y * RENDER_SIZE + x) * 4;
        image.data[offset] = red;
        image.data[offset + 1] = green;
        image.data[offset + 2] = blue;
        image.data[offset + 3] = alpha;
      }
    }
    context.clearRect(0, 0, RENDER_SIZE, RENDER_SIZE);
    context.putImageData(image, 0, 0);
  }, [heatmap, mode]);

  if (!heatmap || mode === "off") return null;
  return (
    <canvas
      ref={canvasRef}
      width={RENDER_SIZE}
      height={RENDER_SIZE}
      data-heatmap-mode={mode}
      aria-label={mode === "combat" ? "整场交战热力图" : "整场走位热力图"}
      className="pointer-events-none absolute inset-0 h-full w-full opacity-90"
      style={{ mixBlendMode: "screen" }}
    />
  );
});
