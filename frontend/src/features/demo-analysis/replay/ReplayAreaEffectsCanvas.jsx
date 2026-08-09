import { useEffect, useMemo, useRef, useState } from "react";
import { getDemoUtilityMaskUrl } from "../../../api/api";
import {
  activeEffectLayerSignature,
  buildActiveEffectLayers,
  createAreaEffectsRenderer,
} from "./replayAreaEffectsRenderer";

export {
  applyUtilityClip,
  effectPalette,
  infernoFlameGeometry,
  infernoPointHalfExtentPx,
  luminanceMaskToAlphaCanvas,
  selectActiveSample,
  selectSamplePair,
  smokeParticleState,
} from "./replayAreaEffectsRenderer";

function canvasSize(canvas, container) {
  const width = Math.max(1, container?.clientWidth || 1);
  const height = Math.max(1, container?.clientHeight || 1);
  const dpr = Math.max(1, Math.min(2, window.devicePixelRatio || 1));
  canvas.style.width = `${width}px`;
  canvas.style.height = `${height}px`;
  return { width, height, dpr };
}

/**
 * Dynamic smoke/inferno overlay.
 *
 * Geometry follows authoritative Demo voxels/cells and is cached by sample.
 * Animation is deterministic from demo tick. Production WebViews render on an
 * OffscreenCanvas worker; older/test environments use the same cached renderer
 * on the main thread.
 */
export default function ReplayAreaEffectsCanvas({
  tracks = [],
  currentTick = 0,
  hideAfterTick = null,
  tickRate = 64,
  transform = null,
  mapName = "",
  mapLayer = "upper",
  enabled = true,
  capabilities = null,
  smokeDebugLayer = "off",
}) {
  const canvasRef = useRef(null);
  const containerRef = useRef(null);
  const workerRef = useRef(null);
  const workerModeRef = useRef(false);
  const rendererRef = useRef(null);
  const renderStateRef = useRef(null);
  const mainHasContentRef = useRef(false);
  const [utilityMask, setUtilityMask] = useState(null);

  if (!rendererRef.current) rendererRef.current = createAreaEffectsRenderer();

  useEffect(() => {
    if (!mapName) {
      setUtilityMask(null);
      return undefined;
    }
    const layer = mapLayer || "upper";
    const url = getDemoUtilityMaskUrl(mapName, layer === "upper" ? "" : layer);
    let cancelled = false;
    const img = new Image();
    // Tauri webview origin differs from the local API origin. This keeps the
    // one-time luminance conversion and ImageBitmap creation untainted.
    img.crossOrigin = "anonymous";
    img.onload = () => {
      if (!cancelled) setUtilityMask(img);
    };
    img.onerror = () => {
      if (!cancelled) setUtilityMask(null);
    };
    img.src = url;
    return () => {
      cancelled = true;
    };
  }, [mapName, mapLayer]);

  const activeLayers = useMemo(
    () => buildActiveEffectLayers({
      tracks,
      currentTick,
      hideAfterTick,
      enabled,
      capabilities,
    }),
    [tracks, currentTick, hideAfterTick, enabled, capabilities],
  );
  const layerSignature = useMemo(
    () => activeEffectLayerSignature(activeLayers),
    [activeLayers],
  );

  renderStateRef.current = {
    layers: activeLayers,
    transform,
    mapLayer,
    smokeDebugLayer,
    currentTick,
    tickRate,
  };

  const paintMainThread = () => {
    const canvas = canvasRef.current;
    const container = containerRef.current;
    const state = renderStateRef.current;
    if (!canvas || !container || !state) return;
    if ((!state.transform || !state.layers?.length) && !mainHasContentRef.current) return;
    const { width, height, dpr } = canvasSize(canvas, container);
    const backingWidth = Math.max(1, Math.floor(width * dpr));
    const backingHeight = Math.max(1, Math.floor(height * dpr));
    if (canvas.width !== backingWidth) canvas.width = backingWidth;
    if (canvas.height !== backingHeight) canvas.height = backingHeight;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, width, height);
    if (!state.transform || !state.layers?.length) {
      mainHasContentRef.current = false;
      return;
    }
    rendererRef.current.render(ctx, { ...state, width, height });
    mainHasContentRef.current = true;
  };

  useEffect(() => {
    if (!enabled) return undefined;
    const canvas = canvasRef.current;
    const container = containerRef.current;
    if (!canvas || !container) return undefined;

    const canUseWorker = (
      typeof Worker !== "undefined"
      && typeof canvas.transferControlToOffscreen === "function"
      && typeof createImageBitmap === "function"
    );

    if (canUseWorker) {
      let worker = null;
      try {
        worker = new Worker(
          new URL("./replayAreaEffects.worker.js", import.meta.url),
          { type: "module", name: "replay-area-effects" },
        );
        const offscreen = canvas.transferControlToOffscreen();
        const { width, height, dpr } = canvasSize(canvas, container);
        workerRef.current = worker;
        workerModeRef.current = true;
        worker.postMessage({ type: "init", canvas: offscreen, width, height, dpr }, [offscreen]);

        const observer = typeof ResizeObserver !== "undefined"
          ? new ResizeObserver(() => {
            const size = canvasSize(canvas, container);
            worker.postMessage({ type: "resize", ...size });
          })
          : null;
        observer?.observe(container);
        return () => {
          observer?.disconnect();
          worker.terminate();
          if (workerRef.current === worker) workerRef.current = null;
          workerModeRef.current = false;
        };
      } catch {
        worker?.terminate();
        workerRef.current = null;
        workerModeRef.current = false;
      }
    }

    const observer = typeof ResizeObserver !== "undefined"
      ? new ResizeObserver(() => paintMainThread())
      : null;
    observer?.observe(container);
    return () => observer?.disconnect();
  }, [enabled]);

  useEffect(() => {
    rendererRef.current.clearGeometryCache();
    workerRef.current?.postMessage({ type: "clear-geometry-cache" });
  }, [tracks]);

  useEffect(() => {
    const worker = workerRef.current;
    if (workerModeRef.current && worker) {
      worker.postMessage({
        type: "configure",
        layers: activeLayers,
        transform,
        mapLayer,
        smokeDebugLayer,
        tickRate,
      });
      return;
    }
    paintMainThread();
    // tracks is intentional: same tick/id data can be replaced after a Demo switch.
  }, [layerSignature, tracks, transform, mapLayer, smokeDebugLayer, tickRate]);

  useEffect(() => {
    const worker = workerRef.current;
    if (workerModeRef.current && worker) {
      worker.postMessage({ type: "tick", currentTick });
      return;
    }
    paintMainThread();
  }, [currentTick]);

  useEffect(() => {
    rendererRef.current.setUtilityMask(utilityMask);
    const worker = workerRef.current;
    if (!workerModeRef.current || !worker) {
      paintMainThread();
      return undefined;
    }
    if (!utilityMask) {
      worker.postMessage({ type: "utility-mask", bitmap: null });
      return undefined;
    }

    let cancelled = false;
    createImageBitmap(utilityMask).then((bitmap) => {
      if (cancelled) {
        bitmap.close?.();
        return;
      }
      worker.postMessage({ type: "utility-mask", bitmap }, [bitmap]);
    }).catch(() => {
      // A missing/tainted mask must not break replay. The worker keeps drawing
      // authoritative effect geometry without the optional wall clip.
      if (!cancelled) worker.postMessage({ type: "utility-mask", bitmap: null });
    });
    return () => {
      cancelled = true;
    };
  }, [utilityMask, enabled]);

  if (!enabled) return null;
  return (
    <div ref={containerRef} className="pointer-events-none absolute inset-0 z-[8]" aria-hidden="true">
      <canvas ref={canvasRef} className="h-full w-full" />
    </div>
  );
}
