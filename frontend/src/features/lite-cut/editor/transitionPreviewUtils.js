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
  return transitionNodePreviewVisual(type, "to", progress);
}

/**
 * Shared material-state kernel. `to` enters from transparent/canvas and
 * `from` exits toward transparent/canvas. Boundary transitions use both
 * projections from the same event progress.
 */
export function transitionNodePreviewVisual(type, role, progress, { mode = "single", stack = null } = {}) {
  const transitionType = String(type || "none").toLowerCase();
  const p = clampUnit(progress);
  const outgoing = role === "from";
  const remaining = 1 - p;
  const midpoint = 1 - Math.abs(p * 2 - 1);
  const fadeInTypes = new Set(["fade", "flash", "dip", "zoom"]);
  const passiveBoundaryLayer = mode === "boundary" && stack === "lower";
  if (passiveBoundaryLayer) {
    return {
      mainOpacity: 1,
      mainTransform: "",
      mainClipPath: "",
      materialFilter: "",
      flashOpacity: 0,
      blackOpacity: 0,
    };
  }
  const visual = {
    mainOpacity: fadeInTypes.has(transitionType) ? (outgoing ? remaining : p) : 1,
    mainTransform: "",
    mainClipPath: "",
    materialFilter: "",
    flashOpacity: 0,
    blackOpacity: 0,
  };

  if (transitionType === "wipe_l") {
    visual.mainClipPath = `inset(0 0 0 ${percent(outgoing ? p : remaining)})`;
  } else if (transitionType === "wipe_r") {
    visual.mainClipPath = `inset(0 ${percent(outgoing ? p : remaining)} 0 0)`;
  } else if (transitionType === "slide_up") {
    visual.mainTransform = outgoing ? `translateY(-${percent(p)})` : `translateY(${percent(remaining)})`;
  } else if (transitionType === "slide_down") {
    visual.mainTransform = outgoing ? `translateY(${percent(p)})` : `translateY(-${percent(remaining)})`;
  } else if (transitionType === "zoom") {
    visual.mainTransform = outgoing
      ? `scale(${(1 + p * 0.18).toFixed(4)})`
      : `scale(${(0.82 + p * 0.18).toFixed(4)})`;
  }

  if (transitionType === "flash") {
    // Scene-object transitions operate on the material's visible pixels.
    // This keeps transparent text/image pixels transparent, like FFmpeg's
    // RGBA eq filter, instead of flashing the entire authored bounding box.
    visual.materialFilter = `brightness(${(1 + 0.85 * midpoint).toFixed(4)})`;
  }
  if (transitionType === "dip") {
    visual.materialFilter = `brightness(${Math.max(0, 1 - 0.95 * midpoint).toFixed(4)})`;
  }
  return visual;
}

/**
 * Returns the two-layer treatment used by FFmpeg's boundary xfade filters.
 * Overlay transitions intentionally keep using transitionPreviewVisual:
 * their exporter animates one overlay rather than mixing two canvas frames.
 */
export function boundaryTransitionPreviewVisual(type, progress, { mainRole = "to" } = {}) {
  const transitionType = String(type || "none").toLowerCase();
  const p = clampUnit(progress);
  const incoming = transitionNodePreviewVisual(transitionType, "to", p, { mode: "boundary", stack: "upper" });
  const outgoing = transitionNodePreviewVisual(transitionType, "from", p, { mode: "boundary", stack: "upper" });
  const outgoingOwnsPrimary = mainRole === "from";
  const visual = {
    ...(outgoingOwnsPrimary ? outgoing : incoming),
    companionTransform: outgoingOwnsPrimary ? incoming.mainTransform : outgoing.mainTransform,
    companionTransformOrigin: "",
    companionOpacity: 1,
  };
  // Compatibility aliases for callers outside the scene-node adapter.  The
  // values describe the companion layer, regardless of whether it is the
  // incoming or outgoing endpoint.
  visual.outgoingTransform = visual.companionTransform;
  visual.outgoingTransformOrigin = visual.companionTransformOrigin;
  visual.outgoingOpacity = visual.companionOpacity;
  // Canvas-boundary transitions mix two opaque frames. Their midpoint tone is
  // therefore a full-canvas layer, unlike a transparent scene material.
  visual.materialFilter = "";
  if (outgoingOwnsPrimary && transitionType === "wipe_l") {
    visual.mainClipPath = `inset(0 ${percent(p)} 0 0)`;
    visual.companionTransform = "";
  } else if (outgoingOwnsPrimary && transitionType === "wipe_r") {
    visual.mainClipPath = `inset(0 0 0 ${percent(p)})`;
    visual.companionTransform = "";
  }
  if (transitionType === "flash") {
    visual.mainOpacity = outgoingOwnsPrimary ? (p < 0.5 ? 1 : 0) : (p < 0.5 ? 0 : 1);
    visual.flashOpacity = 1 - Math.abs(p * 2 - 1);
  } else if (transitionType === "dip") {
    visual.mainOpacity = outgoingOwnsPrimary ? (p < 0.5 ? 1 : 0) : (p < 0.5 ? 0 : 1);
    visual.blackOpacity = 1 - Math.abs(p * 2 - 1);
  }
  if (transitionType !== "zoom") return visual;

  // FFmpeg xfade=zoomin passes an inverse progress value into the filter.
  // During the first half it stretches a shrinking center sample of the
  // outgoing frame; during the second half it blends that sample to incoming.
  const ffmpegProgress = 1 - p;
  const sampleScale = smoothStep(0.5, 1, ffmpegProgress);
  const outgoingScale = 1 / Math.max(sampleScale, 0.0001);
  const outgoingMix = smoothStep(0, 0.5, ffmpegProgress);
  visual.mainOpacity = outgoingOwnsPrimary ? outgoingMix : 1 - outgoingMix;
  visual.mainTransform = outgoingOwnsPrimary ? `scale(${outgoingScale.toFixed(4)})` : "";
  visual.companionTransform = outgoingOwnsPrimary ? "" : `scale(${outgoingScale.toFixed(4)})`;
  visual.outgoingTransform = visual.companionTransform;
  // FFmpeg samples ceil(0.5 * (dimension - 1)), which is the pixel just
  // below/right of the geometric midpoint for even-sized canvases.
  const sampleOrigin = "calc(50% + 0.5px) calc(50% + 0.5px)";
  visual.companionTransformOrigin = outgoingOwnsPrimary ? "" : sampleOrigin;
  visual.outgoingTransformOrigin = visual.companionTransformOrigin;
  if (outgoingOwnsPrimary) visual.mainTransformOrigin = sampleOrigin;
  return visual;
}
