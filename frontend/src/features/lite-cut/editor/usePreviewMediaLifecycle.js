import { useCallback, useEffect, useLayoutEffect, useState } from "react";
import { releaseMediaElement } from "./previewMediaElementUtils.js";

export function usePreviewMediaCleanup({ videoRef, backgroundVideoRef, preloadVideoRef, underlayVideoRefs, canvasRef }) {
  useLayoutEffect(() => () => {
    const elements = new Set([
      videoRef.current,
      backgroundVideoRef.current,
      preloadVideoRef.current,
      ...underlayVideoRefs.current.values(),
      ...(canvasRef.current?.querySelectorAll("video, audio") || []),
    ]);
    elements.forEach(releaseMediaElement);
    underlayVideoRefs.current.clear();
  }, [backgroundVideoRef, canvasRef, preloadVideoRef, underlayVideoRefs, videoRef]);
}

export function usePreviewFullscreen(canvasRef) {
  const [isFullscreen, setIsFullscreen] = useState(false);
  const toggleFullscreen = useCallback(async () => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    try {
      if (document.fullscreenElement === canvas) await document.exitFullscreen();
      else await canvas.requestFullscreen?.();
    } catch {
      // The browser can reject fullscreen outside a trusted user gesture.
    }
  }, [canvasRef]);

  useEffect(() => {
    const syncFullscreenState = () => setIsFullscreen(document.fullscreenElement === canvasRef.current);
    document.addEventListener("fullscreenchange", syncFullscreenState);
    syncFullscreenState();
    return () => document.removeEventListener("fullscreenchange", syncFullscreenState);
  }, [canvasRef]);

  return { isFullscreen, toggleFullscreen };
}

export function usePreviewViewportFit(viewportRef, { canvasWidth, canvasHeight, maxWidth = 920, padding = 40 }) {
  const [fitWidth, setFitWidth] = useState(maxWidth);
  useLayoutEffect(() => {
    const viewport = viewportRef.current;
    if (!viewport) return undefined;
    const updatePreviewFit = () => {
      const aspect = Math.max(1, Number(canvasWidth) || 1920) / Math.max(1, Number(canvasHeight) || 1080);
      const availableWidth = Math.max(1, viewport.clientWidth - padding);
      const availableHeight = Math.max(1, viewport.clientHeight - padding);
      const nextWidth = Math.max(1, Math.min(maxWidth, availableWidth, availableHeight * aspect));
      setFitWidth((current) => (Math.abs(current - nextWidth) < 0.5 ? current : nextWidth));
    };
    updatePreviewFit();
    const observer = typeof ResizeObserver !== "undefined" ? new ResizeObserver(updatePreviewFit) : null;
    observer?.observe(viewport);
    window.addEventListener("resize", updatePreviewFit);
    return () => {
      observer?.disconnect();
      window.removeEventListener("resize", updatePreviewFit);
    };
  }, [canvasHeight, canvasWidth, maxWidth, padding, viewportRef]);
  return fitWidth;
}
