import { createAreaEffectsRenderer } from "./replayAreaEffectsRenderer";

const renderer = createAreaEffectsRenderer();
let canvas = null;
let context = null;
let width = 1;
let height = 1;
let dpr = 1;
let currentTick = 0;
let config = {
  layers: [],
  transform: null,
  mapLayer: "upper",
  smokeDebugLayer: "off",
  tickRate: 64,
};
let scheduled = false;

function render() {
  scheduled = false;
  if (!canvas || !context) return;
  const backingWidth = Math.max(1, Math.floor(width * dpr));
  const backingHeight = Math.max(1, Math.floor(height * dpr));
  if (canvas.width !== backingWidth) canvas.width = backingWidth;
  if (canvas.height !== backingHeight) canvas.height = backingHeight;
  context.setTransform(dpr, 0, 0, dpr, 0, 0);
  context.clearRect(0, 0, width, height);
  renderer.render(context, {
    ...config,
    width,
    height,
    currentTick,
  });
}

function scheduleRender() {
  if (scheduled) return;
  scheduled = true;
  if (typeof self.requestAnimationFrame === "function") {
    self.requestAnimationFrame(render);
  } else {
    setTimeout(render, 16);
  }
}

self.onmessage = (event) => {
  const message = event.data || {};
  switch (message.type) {
    case "init":
      canvas = message.canvas || null;
      context = canvas?.getContext?.("2d") || null;
      width = Math.max(1, Number(message.width) || 1);
      height = Math.max(1, Number(message.height) || 1);
      dpr = Math.max(1, Number(message.dpr) || 1);
      scheduleRender();
      break;
    case "resize":
      width = Math.max(1, Number(message.width) || 1);
      height = Math.max(1, Number(message.height) || 1);
      dpr = Math.max(1, Number(message.dpr) || 1);
      renderer.clearGeometryCache();
      scheduleRender();
      break;
    case "configure":
      config = {
        ...config,
        layers: Array.isArray(message.layers) ? message.layers : [],
        transform: message.transform || null,
        mapLayer: message.mapLayer || "upper",
        smokeDebugLayer: message.smokeDebugLayer || "off",
        tickRate: Math.max(1, Number(message.tickRate) || 64),
      };
      scheduleRender();
      break;
    case "tick":
      currentTick = Number(message.currentTick) || 0;
      scheduleRender();
      break;
    case "utility-mask":
      renderer.setUtilityMask(message.bitmap || null);
      scheduleRender();
      break;
    case "clear-geometry-cache":
      renderer.clearGeometryCache();
      scheduleRender();
      break;
    default:
      break;
  }
};
