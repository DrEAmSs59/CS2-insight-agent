function clampUnit(value) {
  return Math.max(0, Math.min(1, Number(value) || 0));
}

function percent(value) {
  return `${(clampUnit(value) * 100).toFixed(2)}%`;
}

function smoothStep(edge0, edge1, value) {
  const t = clampUnit((Number(value) - edge0) / (edge1 - edge0));
  return t * t * (3 - 2 * t);
}

/**
 * Returns the incoming-layer treatment for a cut-boundary transition preview.
 * The outgoing frame is rendered beneath this layer by the editor shell.
 */
export function transitionPreviewVisual(type, progress) {
  const transitionType = String(type || "none").toLowerCase();
  const p = clampUnit(progress);
  const remaining = 1 - p;
  const midpoint = 1 - Math.abs(p * 2 - 1);
  const fadeInTypes = new Set(["fade", "flash", "dip", "dip_black", "black", "zoom", "blur", "glitch", "spin"]);
  const visual = {
    mainOpacity: fadeInTypes.has(transitionType) ? p : 1,
    mainTransform: "",
    mainClipPath: "",
    flashOpacity: 0,
    blackOpacity: 0,
  };

  if (transitionType === "wipe_l") {
    // FFmpeg xfade's wipeleft reveals the incoming frame from right to left.
    visual.mainClipPath = `inset(0 0 0 ${percent(remaining)})`;
  } else if (transitionType === "wipe_r") {
    visual.mainClipPath = `inset(0 ${percent(remaining)} 0 0)`;
  } else if (transitionType === "slide_left") {
    visual.mainTransform = `translateX(${percent(remaining)})`;
  } else if (transitionType === "slide_right") {
    visual.mainTransform = `translateX(-${percent(remaining)})`;
  } else if (transitionType === "slide_up") {
    visual.mainTransform = `translateY(${percent(remaining)})`;
  } else if (transitionType === "slide_down") {
    visual.mainTransform = `translateY(-${percent(remaining)})`;
  } else if (transitionType === "zoom") {
    visual.mainTransform = `scale(${(0.82 + p * 0.18).toFixed(4)})`;
  } else if (transitionType === "blur") {
    visual.mainTransform = `scale(${(1.06 - p * 0.06).toFixed(4)})`;
  } else if (transitionType === "spin") {
    visual.mainTransform = `scale(${(0.9 + p * 0.1).toFixed(4)}) rotate(${(-14 * remaining).toFixed(2)}deg)`;
  } else if (transitionType === "glitch") {
    visual.mainTransform = `translateX(${(Math.sin(p * Math.PI * 7) * remaining * 1.5).toFixed(2)}%)`;
  }

  if (transitionType === "flash") {
    visual.mainOpacity = p < 0.5 ? 0 : 1;
    visual.flashOpacity = midpoint;
  }
  if (["dip", "dip_black", "black"].includes(transitionType)) {
    // Match the exporter's explicit outgoing -> black -> incoming phases.
    // The black layer sits above the video: before the midpoint it covers the
    // outgoing frame, afterwards it covers the fully mounted incoming frame.
    visual.mainOpacity = p < 0.5 ? 0 : 1;
    visual.blackOpacity = midpoint;
  }
  return visual;
}

/**
 * Returns the two-layer treatment used by FFmpeg's boundary xfade filters.
 * Overlay transitions intentionally keep using transitionPreviewVisual:
 * their exporter animates one overlay rather than mixing two canvas frames.
 */
export function boundaryTransitionPreviewVisual(type, progress) {
  const transitionType = String(type || "none").toLowerCase();
  const p = clampUnit(progress);
  const visual = {
    ...transitionPreviewVisual(transitionType, p),
    outgoingTransform: "",
    outgoingTransformOrigin: "",
  };
  if (transitionType === "slide_left") {
    visual.outgoingTransform = `translateX(-${percent(p)})`;
  } else if (transitionType === "slide_right") {
    visual.outgoingTransform = `translateX(${percent(p)})`;
  } else if (transitionType === "slide_up") {
    visual.outgoingTransform = `translateY(-${percent(p)})`;
  } else if (transitionType === "slide_down") {
    visual.outgoingTransform = `translateY(${percent(p)})`;
  }
  if (transitionType !== "zoom") return visual;

  // FFmpeg xfade=zoomin passes an inverse progress value into the filter.
  // During the first half it stretches a shrinking center sample of the
  // outgoing frame; during the second half it blends that sample to incoming.
  const ffmpegProgress = 1 - p;
  const sampleScale = smoothStep(0.5, 1, ffmpegProgress);
  const outgoingScale = 1 / Math.max(sampleScale, 0.0001);
  const outgoingMix = smoothStep(0, 0.5, ffmpegProgress);
  visual.mainOpacity = 1 - outgoingMix;
  visual.mainTransform = "";
  visual.outgoingTransform = `scale(${outgoingScale.toFixed(4)})`;
  // FFmpeg samples ceil(0.5 * (dimension - 1)), which is the pixel just
  // below/right of the geometric midpoint for even-sized canvases.
  visual.outgoingTransformOrigin = "calc(50% + 0.5px) calc(50% + 0.5px)";
  return visual;
}

/**
 * Text is drawn by FFmpeg's drawtext filter during export, which cannot use
 * the canvas clip-path effects available to image/video layers.  Keep text
 * transitions deliberately within the shared subset: fades for every
 * non-slide effect and canvas-relative motion for slides.  The same geometry
 * is used by the exporter so the position seen in the preview is reproducible.
 */
export function textTransitionPreviewVisual(type, progress, phase = "in") {
  const transitionType = String(type || "none").toLowerCase();
  const p = clampUnit(progress);
  const amount = 1 - p;
  const exiting = phase === "out";
  const visual = { opacity: transitionType === "cut" || transitionType === "none" ? 1 : p, offsetX: 0, offsetY: 0 };
  if (transitionType === "slide_left") visual.offsetX = (exiting ? -1 : 1) * 0.12 * amount;
  if (transitionType === "slide_right") visual.offsetX = (exiting ? 1 : -1) * 0.12 * amount;
  if (transitionType === "slide_up") visual.offsetY = (exiting ? -1 : 1) * 0.1 * amount;
  if (transitionType === "slide_down") visual.offsetY = (exiting ? 1 : -1) * 0.1 * amount;
  if (["slide_left", "slide_right", "slide_up", "slide_down"].includes(transitionType)) visual.opacity = 1;
  return visual;
}
