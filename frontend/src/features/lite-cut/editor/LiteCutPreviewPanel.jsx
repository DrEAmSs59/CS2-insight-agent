import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import { Loader2, Maximize2, Minimize2, Pause, Play, SkipBack, SkipForward, Volume2, ZoomIn, ZoomOut } from "lucide-react";
import { TEXT_STYLE_CARDS } from "./editorPresets.js";
import { startPendingDrag } from "./timelineInteraction.js";
import { isHandoffFrameReady, previewMediaIdentity, previewUnderlayOpacity, previewUnderlayPlaybackStateKey, previewUnderlaySyncKey, promotedUnderlayForMain, SEGMENT_HANDOFF_TOLERANCE_SEC, shouldPublishVideoTimeUpdate, shouldUseMediaPreviewClock } from "./previewFrameUtils.js";
import { normalizeSceneTransform, sceneMaterialLayout, sceneTransformStyle, VIDEO_SCENE_TRANSFORM_DEFAULTS } from "../state/sceneTransform.js";
import PreviewAudioItem from "./PreviewAudioItem.jsx";
import { captureThenReleaseMediaElements, createMediaElementRefRegistry, drawVideoFrame, isInterruptedPlaybackError, releaseMediaElement } from "./previewMediaElementUtils.js";
import PreviewOverlayItem from "./LiteCutPreviewOverlay.jsx";
import {
  usePreviewFullscreen,
  usePreviewMediaCleanup,
  usePreviewViewportFit,
} from "./usePreviewMediaLifecycle.js";
import { usePreviewFrameClock, usePreviewSeekGuard } from "./usePreviewMediaClock.js";
import {
  clampSceneScale,
  clampSceneSize,
  scenePositionForCanvasDrag,
  snapCanvasRotation,
} from "./sceneCanvasInteraction.js";

function formatTime(sec) {
  const s = Math.max(0, sec);
  const m = Math.floor(s / 60);
  const r = Math.floor(s % 60);
  const ms = Math.floor((s % 1) * 100);
  return `${m}:${String(r).padStart(2, "0")}.${String(ms).padStart(2, "0")}`;
}

function parseTime(value) {
  const text = String(value || "").trim();
  if (!text) return null;
  const parts = text.split(":").map((part) => Number(part));
  if (parts.some((part) => !Number.isFinite(part)) || parts.length > 3) return null;
  if (parts.length === 1) return Math.max(0, parts[0]);
  if (parts.length === 2) return Math.max(0, parts[0] * 60 + parts[1]);
  return Math.max(0, parts[0] * 3600 + parts[1] * 60 + parts[2]);
}

export default function LiteCutPreviewPanel({
  playheadSec = 0,
  totalSec = 68,
  isPlaying = false,
  userSeekToken = 0,
  onTogglePlay,
  onPlayheadChange,
  onTimelineSeek,
  onDurationChange,
  onUnderlayDurationChange,
  overlayText = "CLUTCH",
  textStyleId = "clutch",
  selectedElement = "text",
  streamUrl = null,
  mediaTimeOffset = 0,
  segmentedPreview = false,
  previewPending = false,
  previewProxyError = "",
  onPreviewRetry,
  preloadStreamUrl = null,
  preloadSourceTime = 0,
  previewClipId = null,
  previewLabel = null,
  sequenceMode = false,
  timelinePlayhead = null,
  timelineTotal = null,
  previewOverlays = [],
  playbackRate = 1,
  reversePlayback = false,
  freezePlayback = false,
  transitionMainOpacity = 1,
  transitionMainTransform = "",
  transitionMainTransformOrigin = "",
  transitionMainClipPath = "",
  transitionCompanionTransform = "",
  transitionCompanionTransformOrigin = "",
  transitionFlashOpacity = 0,
  transitionBlackOpacity = 0,
  clipLocalTime = 0,
  mainFlipHorizontal = false,
  mainFlipVertical = false,
  mainCrop = null,
  mainSourceWidth = 0,
  mainSourceHeight = 0,
  mainFilter = "",
  mainLayerTransform = null,
  mainLayerSelected = false,
  onMainLayerTransform,
  onMainLayerSelect,
  mainIsVideoLayer = false,
  mainMuted = false,
  mainVolume = 1,
  audioPreviewItems = [],
  underlayStreamUrl = null,
  underlaySourceTime = 0,
  underlayPlaybackRate = 1,
  underlayReversePlayback = false,
  underlayClipId = null,
  underlayOpacity = 1,
  underlayFlipHorizontal = false,
  underlayFlipVertical = false,
  underlayLayers = [],
  assetPreviewVersions = {},
  fontAssetSources = {},
  canvasFit = "contain",
  canvasBackgroundColor = "#000000",
  canvasBlurAmount = 24,
  canvasWidth = 1920,
  canvasHeight = 1080,
  onDropMedia,
  selectedOverlayId = null,
  onOverlaySelect,
  onOverlayDeselect,
  onOverlayDragStart,
  onOverlayTransform,
}) {
  const videoRef = useRef(null);
  const bgVideoRef = useRef(null);
  const preloadVideoRef = useRef(null);
  const underlayVideoRefs = useRef(new Map());
  const underlayMediaRegistryRef = useRef(null);
  if (!underlayMediaRegistryRef.current) {
    underlayMediaRegistryRef.current = createMediaElementRefRegistry(underlayVideoRefs.current);
  }
  const canvasRef = useRef(null);
  const previewViewportRef = useRef(null);
  const [videoDuration, setVideoDuration] = useState(null);
  const [playError, setPlayError] = useState(null);
  const [heldSwitchFrame, setHeldSwitchFrame] = useState(null);
  const [segmentMediaLoading, setSegmentMediaLoading] = useState(false);
  const [dropHover, setDropHover] = useState(false);
  const [mainLayerDragging, setMainLayerDragging] = useState(false);
  const [mainNaturalSize, setMainNaturalSize] = useState({ width: 0, height: 0 });
  const [previewZoom, setPreviewZoom] = useState(100);
  const previewFitWidth = usePreviewViewportFit(previewViewportRef, { canvasWidth, canvasHeight });
  const { isFullscreen, toggleFullscreen } = usePreviewFullscreen(canvasRef);
  const [timeDraft, setTimeDraft] = useState(formatTime(timelinePlayhead ?? playheadSec));
  const [editingTime, setEditingTime] = useState(false);
  const [alignmentGuides, setAlignmentGuides] = useState({ x: null, y: null });
  const styleCard = TEXT_STYLE_CARDS.find((c) => c.id === textStyleId) || TEXT_STYLE_CARDS.find((c) => c.id === "clutch");
  const hasStream = Boolean(streamUrl);
  const sourceOffset = Math.max(0, Number(mediaTimeOffset) || 0);
  const playbackStreamReady = hasStream && (!segmentedPreview || !previewPending);
  const mediaIdentity = previewMediaIdentity(previewClipId, streamUrl);
  const safePlaybackRate = Math.max(0.25, Math.min(4, Number(playbackRate) || 1));
  const inputTimelineTime = Math.max(0, Number(timelinePlayhead ?? playheadSec) || 0);
  const inputLocalTime = Math.max(0, Number(clipLocalTime) || 0);
  const previousUnderlayLayersRef = useRef([]);

  usePreviewMediaCleanup({
    videoRef,
    backgroundVideoRef: bgVideoRef,
    preloadVideoRef,
    underlayVideoRefs,
    canvasRef,
  });

  const {
    previewClock,
    frameAnchorRef,
    previewClipIdRef,
    onPlayheadChangeRef,
    presentedStreamRef,
    retainedPromotionLayerRef,
    handoffStartedAtRef,
    handoffSeekAtRef,
    releasePromotedUnderlay,
    promotedPlaybackTime,
  } = usePreviewFrameClock({
    clipLocalTime,
    freezePlayback,
    hasStream: playbackStreamReady,
    inputLocalTime,
    inputTimelineTime,
    isPlaying,
    mediaTimeOffset: sourceOffset,
    mediaIdentity,
    onPlayheadChange,
    playheadSec,
    preventBackwardHandoff: segmentedPreview,
    previewClipId,
    reversePlayback,
    safePlaybackRate,
    setHeldSwitchFrame,
    streamUrl,
    handoffToleranceSec: segmentedPreview ? SEGMENT_HANDOFF_TOLERANCE_SEC : undefined,
    underlayVideoRefs,
    videoRef,
  });

  const useMediaClock = shouldUseMediaPreviewClock({ hasStream: playbackStreamReady, isPlaying, reversePlayback, freezePlayback });
  const localTime = useMediaClock ? previewClock.clipLocalTime : inputLocalTime;
  const displayTimelineTime = useMediaClock ? previewClock.timelineTime : inputTimelineTime;
  const videoOpacity = Math.max(0, Math.min(1, Number(transitionMainOpacity) || 0));
  const fitMode = ["contain", "cover", "blur"].includes(canvasFit) ? canvasFit : "contain";
  const normalizedMainCrop = {
    x: Math.max(0, Math.min(1, Number(mainCrop?.x) || 0)),
    y: Math.max(0, Math.min(1, Number(mainCrop?.y) || 0)),
    width: Math.max(0.05, Math.min(1, Number(mainCrop?.width) || 1)),
    height: Math.max(0.05, Math.min(1, Number(mainCrop?.height) || 1)),
  };
  normalizedMainCrop.x = Math.min(normalizedMainCrop.x, 1 - normalizedMainCrop.width);
  normalizedMainCrop.y = Math.min(normalizedMainCrop.y, 1 - normalizedMainCrop.height);
  const hasMainCrop = normalizedMainCrop.width < 0.999 || normalizedMainCrop.height < 0.999;
  const cropCenter = {
    x: normalizedMainCrop.x + normalizedMainCrop.width / 2,
    y: normalizedMainCrop.y + normalizedMainCrop.height / 2,
  };
  const cropPreviewScale = hasMainCrop ? 1 / Math.min(normalizedMainCrop.width, normalizedMainCrop.height) : 1;
  const mainObjectFit = fitMode === "cover" || hasMainCrop ? "object-cover" : fitMode === "fill" ? "object-fill" : "object-contain";
  const showCanvasBlur = !mainIsVideoLayer && fitMode === "blur";
  const canvasBg = /^#[0-9a-f]{6}$/i.test(String(canvasBackgroundColor || "")) ? canvasBackgroundColor : "#000000";
  const blurPx = Math.max(4, Math.min(80, Number(canvasBlurAmount) || 24));
  const blurFilter = `blur(${((blurPx / Math.max(1, Number(canvasHeight) || 1080)) * 100).toFixed(6)}cqh)`;

  useLayoutEffect(() => () => underlayMediaRegistryRef.current?.releaseAll(), []);

  const resolvedUnderlayLayers = underlayLayers.length
    ? underlayLayers
    : underlayStreamUrl
      ? [{
          id: underlayClipId ?? underlayStreamUrl,
          streamUrl: underlayStreamUrl,
          sourceTime: underlaySourceTime,
          playbackRate: underlayPlaybackRate,
          reversePlayback: underlayReversePlayback,
          opacity: underlayOpacity,
          flipHorizontal: underlayFlipHorizontal,
          flipVertical: underlayFlipVertical,
        }]
      : [];
  const previousUnderlays = previousUnderlayLayersRef.current;
  // Promotion is a playing-handoff aid only. While paused it would pin every
  // seek to the promoted element's stale currentTime instead of the playhead,
  // leaving the paused preview desynced after scrubbing across a clip seam.
  const canPromoteUnderlay = isPlaying && !reversePlayback && !freezePlayback;
  const promotedCandidate = canPromoteUnderlay
    ? promotedUnderlayForMain(previousUnderlays, previewClipId, streamUrl)
    : null;
  if (
    retainedPromotionLayerRef.current
    && (
      !canPromoteUnderlay
      || String(retainedPromotionLayerRef.current.id) !== String(previewClipId)
    )
  ) {
    retainedPromotionLayerRef.current = null;
  }
  if (promotedCandidate) retainedPromotionLayerRef.current = promotedCandidate;
  const promotedUnderlayLayer = retainedPromotionLayerRef.current;
  const renderedUnderlayLayers = promotedUnderlayLayer
    && !resolvedUnderlayLayers.some((layer) => String(layer.id) === String(promotedUnderlayLayer.id))
    ? [...resolvedUnderlayLayers, promotedUnderlayLayer]
    : resolvedUnderlayLayers;
  const hasPromotedUnderlay = Boolean(promotedUnderlayLayer);
  const underlayLayerSignature = resolvedUnderlayLayers
    .map(previewUnderlayPlaybackStateKey)
    .join("|");
  const hasUnderlay = renderedUnderlayLayers.length > 0;
  const hasTransitionUnderlay = renderedUnderlayLayers.some((layer) => Boolean(layer?.transitionLayer));
  useLayoutEffect(() => {
    previousUnderlayLayersRef.current = resolvedUnderlayLayers;
  }, [resolvedUnderlayLayers]);
  const mainReverse = Boolean(reversePlayback);
  const normalizedMainLayerTransform = normalizeSceneTransform(mainLayerTransform, VIDEO_SCENE_TRANSFORM_DEFAULTS);
  const transformedMaterialFit = fitMode === "blur" ? "contain" : fitMode;
  const mainMaterialLayout = sceneMaterialLayout({
    transform: normalizedMainLayerTransform,
    crop: normalizedMainCrop,
    contentFit: transformedMaterialFit,
    canvasWidth,
    canvasHeight,
    sourceWidth: mainNaturalSize.width || mainSourceWidth || canvasWidth,
    sourceHeight: mainNaturalSize.height || mainSourceHeight || canvasHeight,
  });
  const mainBlurLayout = sceneMaterialLayout({
    transform: normalizedMainLayerTransform,
    crop: normalizedMainCrop,
    contentFit: "cover",
    canvasWidth,
    canvasHeight,
    sourceWidth: mainNaturalSize.width || mainSourceWidth || canvasWidth,
    sourceHeight: mainNaturalSize.height || mainSourceHeight || canvasHeight,
  });
  const mainFlipTransform = mainFlipHorizontal || mainFlipVertical ? `scale(${mainFlipHorizontal ? -1 : 1}, ${mainFlipVertical ? -1 : 1})` : undefined;
  const safeMainFilter = String(mainFilter || "").trim();
  const safeTransitionTransform = String(transitionMainTransform || "").trim();
  const safeTransitionTransformOrigin = String(transitionMainTransformOrigin || "").trim();
  const safeTransitionClipPath = String(transitionMainClipPath || "").trim();
  const safeCompanionTransitionTransform = String(transitionCompanionTransform || "").trim();
  const safeCompanionTransitionTransformOrigin = String(transitionCompanionTransformOrigin || "").trim();
  const flashOpacity = Math.max(0, Math.min(1, Number(transitionFlashOpacity) || 0));
  const blackOpacity = Math.max(0, Math.min(1, Number(transitionBlackOpacity) || 0));
  const safeMainVolume = Math.max(0, Math.min(1, Number(mainVolume) || 0));
  const mainAudioMuted = Boolean(mainMuted || safeMainVolume <= 0);
  const mainVideoStyle = mainIsVideoLayer
    ? {
        ...sceneTransformStyle(normalizedMainLayerTransform, {
          defaults: VIDEO_SCENE_TRANSFORM_DEFAULTS,
          flipHorizontal: mainFlipHorizontal,
          flipVertical: mainFlipVertical,
          opacity: hasPromotedUnderlay ? 0 : videoOpacity,
          prefixTransform: safeTransitionTransform,
        }),
        clipPath: safeTransitionClipPath || undefined,
        ...(safeTransitionTransformOrigin ? { transformOrigin: safeTransitionTransformOrigin } : {}),
        willChange: isPlaying ? "transform, opacity, clip-path, filter" : undefined,
      }
    : {
        opacity: hasPromotedUnderlay ? 0 : videoOpacity,
        filter: safeMainFilter || undefined,
        objectPosition: `${(cropCenter.x * 100).toFixed(2)}% ${(cropCenter.y * 100).toFixed(2)}%`,
        transformOrigin: safeTransitionTransformOrigin || `${(cropCenter.x * 100).toFixed(2)}% ${(cropCenter.y * 100).toFixed(2)}%`,
        clipPath: safeTransitionClipPath || undefined,
        transform: `${safeTransitionTransform} ${mainFlipTransform || ""} scale(${cropPreviewScale.toFixed(4)})`.trim(),
        willChange: isPlaying ? "transform, opacity, clip-path, filter" : undefined,
      };
  const switchCaptureConfigRef = useRef(null);
  switchCaptureConfigRef.current = {
    background: canvasBg,
    canvasWidth: Math.max(1, Number(canvasWidth) || 1920),
    canvasHeight: Math.max(1, Number(canvasHeight) || 1080),
    fit: fitMode,
    mainFilter: safeMainFilter,
    mainOpacity: Math.max(0, Math.min(1, videoOpacity * normalizedMainLayerTransform.opacity)),
    underlayLayers: resolvedUnderlayLayers,
  };

  const holdCompositedFrame = useCallback((mainElement = videoRef.current, configOverride = null) => {
    const config = configOverride || switchCaptureConfigRef.current;
    if (!config || !mainElement || mainElement.readyState < 2) return;
    try {
      const canvas = document.createElement("canvas");
      canvas.width = Math.min(1280, config.canvasWidth);
      canvas.height = Math.max(1, Math.round(canvas.width * config.canvasHeight / config.canvasWidth));
      const ctx = canvas.getContext("2d");
      if (!ctx) return;
      ctx.fillStyle = config.background;
      ctx.fillRect(0, 0, canvas.width, canvas.height);
      for (const layer of config.underlayLayers) {
        const element = underlayVideoRefs.current.get(String(layer.id));
        if (!element || element.readyState < 2) continue;
        const rawOpacity = Number(layer.opacity);
        ctx.globalAlpha = Number.isFinite(rawOpacity) ? Math.max(0, Math.min(1, rawOpacity)) : 1;
        ctx.filter = String(layer.filter || "none");
        drawVideoFrame(ctx, element, 0, 0, canvas.width, canvas.height, "contain");
      }
      ctx.globalAlpha = config.mainOpacity;
      ctx.filter = config.mainFilter || "none";
      drawVideoFrame(ctx, mainElement, 0, 0, canvas.width, canvas.height, config.fit === "cover" ? "cover" : "contain");
      ctx.globalAlpha = 1;
      ctx.filter = "none";
      setHeldSwitchFrame(canvas.toDataURL("image/webp", 0.86));
    } catch {
      // Frame holding is best-effort; playback must continue if capture is unavailable.
    }
  }, []);

  const startMainLayerMove = (e) => {
    if (!mainIsVideoLayer || e.target.closest("[data-main-layer-handle]")) return;
    e.preventDefault();
    e.stopPropagation();
    onMainLayerSelect?.();
    const canvas = e.currentTarget.closest("[data-preview-canvas]");
    const rect = canvas?.getBoundingClientRect();
    if (!rect) return;
    const origin = { x: e.clientX, y: e.clientY };
    const ox = normalizedMainLayerTransform.x;
    const oy = normalizedMainLayerTransform.y;
    startPendingDrag(e.pointerId, origin, {
      onDragStart: () => setMainLayerDragging(true),
      onDragMove: (ev) => {
        const position = scenePositionForCanvasDrag({
          x: ox,
          y: oy,
          deltaX: ev.clientX - origin.x,
          deltaY: ev.clientY - origin.y,
          canvasWidth: rect.width,
          canvasHeight: rect.height,
        });
        setAlignmentGuides(position.guides);
        onMainLayerTransform?.({ x: position.x, y: position.y });
      },
      onDragEnd: () => { setMainLayerDragging(false); setAlignmentGuides({ x: null, y: null }); },
    });
  };

  const startMainLayerScale = (e) => {
    e.preventDefault();
    e.stopPropagation();
    const canvas = e.currentTarget.closest("[data-preview-canvas]");
    const rect = canvas?.getBoundingClientRect();
    if (!rect) return;
    const cx = rect.left + normalizedMainLayerTransform.x * rect.width;
    const cy = rect.top + normalizedMainLayerTransform.y * rect.height;
    const originScale = normalizedMainLayerTransform.scale;
    const originDist = Math.hypot(e.clientX - cx, e.clientY - cy) || 1;
    startPendingDrag(e.pointerId, { x: e.clientX, y: e.clientY }, {
      onDragStart: () => setMainLayerDragging(true),
      onDragMove: (ev) => {
        const dist = Math.hypot(ev.clientX - cx, ev.clientY - cy);
        onMainLayerTransform?.({ scale: clampSceneScale(originScale * (dist / originDist)) });
      },
      onDragEnd: () => setMainLayerDragging(false),
    });
  };

  const startMainLayerBoxResize = (axis, direction) => (e) => {
    e.preventDefault();
    e.stopPropagation();
    const canvas = e.currentTarget.closest("[data-preview-canvas]");
    const rect = canvas?.getBoundingClientRect();
    if (!rect) return;
    const origin = { x: e.clientX, y: e.clientY };
    const originW = normalizedMainLayerTransform.width;
    const originH = normalizedMainLayerTransform.height;
    startPendingDrag(e.pointerId, origin, {
      onDragStart: () => setMainLayerDragging(true),
      onDragMove: (ev) => {
        if (axis === "x") onMainLayerTransform?.({ width: clampSceneSize(originW + direction * ((ev.clientX - origin.x) * 2) / rect.width) });
        if (axis === "y") onMainLayerTransform?.({ height: clampSceneSize(originH + direction * ((ev.clientY - origin.y) * 2) / rect.height) });
      },
      onDragEnd: () => setMainLayerDragging(false),
    });
  };

  const startMainLayerRotate = (e) => {
    e.preventDefault();
    e.stopPropagation();
    const canvas = e.currentTarget.closest("[data-preview-canvas]");
    const rect = canvas?.getBoundingClientRect();
    if (!rect) return;
    const cx = rect.left + normalizedMainLayerTransform.x * rect.width;
    const cy = rect.top + normalizedMainLayerTransform.y * rect.height;
    const originRotation = normalizedMainLayerTransform.rotation;
    const startAngle = Math.atan2(e.clientY - cy, e.clientX - cx);
    startPendingDrag(e.pointerId, { x: e.clientX, y: e.clientY }, {
      onDragStart: () => setMainLayerDragging(true),
      onDragMove: (ev) => {
        const angle = Math.atan2(ev.clientY - cy, ev.clientX - cx);
        onMainLayerTransform?.({ rotation: snapCanvasRotation(originRotation + ((angle - startAngle) * 180) / Math.PI) });
      },
      onDragEnd: () => setMainLayerDragging(false),
    });
  };

  useEffect(() => {
    setVideoDuration(null);
    setPlayError(null);
    setMainNaturalSize({ width: 0, height: 0 });
  }, [mediaIdentity]);

  useLayoutEffect(() => {
    if (!hasStream) setHeldSwitchFrame(null);
  }, [hasStream]);

  useLayoutEffect(() => {
    handoffStartedAtRef.current = 0;
    handoffSeekAtRef.current = 0;
    const element = videoRef.current;
    const background = bgVideoRef.current;
    const captureConfig = switchCaptureConfigRef.current;
    return () => {
      captureThenReleaseMediaElements({
        main: element,
        background,
        capture: (outgoing) => {
          if (!retainedPromotionLayerRef.current) holdCompositedFrame(outgoing, captureConfig);
        },
      });
    };
  }, [holdCompositedFrame, mediaIdentity]);

  useLayoutEffect(() => {
    const background = bgVideoRef.current;
    return () => releaseMediaElement(background);
  }, [mediaIdentity, showCanvasBlur]);

  useLayoutEffect(() => {
    setSegmentMediaLoading(Boolean(segmentedPreview && hasStream));
  }, [hasStream, mediaIdentity, segmentedPreview]);

  useEffect(() => {
    const el = preloadVideoRef.current;
    if (!el || !preloadStreamUrl) return;
    const seekToNextStart = () => {
      try {
        el.currentTime = Math.max(0, Number(preloadSourceTime) || 0);
      } catch {
        // Preloading is opportunistic; the active player remains authoritative.
      }
    };
    if (el.readyState >= 1) seekToNextStart();
    else el.addEventListener("loadedmetadata", seekToNextStart, { once: true });
    return () => {
      el.removeEventListener("loadedmetadata", seekToNextStart);
      releaseMediaElement(el);
    };
  }, [preloadSourceTime, preloadStreamUrl]);

  useEffect(() => {
    for (const el of [videoRef.current, bgVideoRef.current]) {
      if (!el || !hasStream) continue;
      el.playbackRate = safePlaybackRate;
    }
  }, [hasStream, mediaIdentity, safePlaybackRate]);

  useEffect(() => {
    const el = videoRef.current;
    if (!el || !hasStream) return;
    el.volume = safeMainVolume;
    el.muted = mainAudioMuted;
  }, [hasStream, mainAudioMuted, mediaIdentity, safeMainVolume]);

  useEffect(() => {
    for (const layer of resolvedUnderlayLayers) {
      const el = underlayVideoRefs.current.get(String(layer.id));
      if (el) el.playbackRate = Math.max(0.25, Math.min(4, Number(layer.playbackRate) || 1));
    }
  }, [underlayLayerSignature]);

  const underlaySeekSignature = resolvedUnderlayLayers
    .map((layer) => previewUnderlaySyncKey(layer, isPlaying))
    .join("|");
  const { reverseSeekTargetRef } = usePreviewSeekGuard({
    backgroundVideoRef: bgVideoRef,
    fitMode,
    freezePlayback,
    hasStream: playbackStreamReady,
    isPlaying,
    mainReverse,
    mediaTimeOffset: sourceOffset,
    mediaIdentity,
    playheadSec,
    promotedPlaybackTime,
    resolvedUnderlayLayers,
    retainedPromotionLayerRef,
    underlayLayerSignature,
    underlaySeekSignature,
    underlayVideoRefs,
    userSeekToken,
    videoRef,
  });

  useEffect(() => {
    if (!hasStream) return;
    for (const el of [videoRef.current, bgVideoRef.current]) {
      if (!el) continue;
      if (playbackStreamReady && isPlaying && !mainReverse && !freezePlayback) {
        void el.play().catch((err) => {
          if (isInterruptedPlaybackError(err)) return;
          setPlayError(err?.message || "play_failed");
          onTogglePlay?.(false);
        });
      } else {
        el.pause();
      }
    }
  }, [isPlaying, hasStream, onTogglePlay, fitMode, mainReverse, freezePlayback, mediaIdentity, playbackStreamReady]);

  useEffect(() => {
    for (const layer of renderedUnderlayLayers) {
      const el = underlayVideoRefs.current.get(String(layer.id));
      if (!el) continue;
      const isPromotedPrewarm = Boolean(layer.prewarm && retainedPromotionLayerRef.current && String(layer.id) === String(retainedPromotionLayerRef.current.id));
      if (layer.freezePlayback || (layer.prewarm && !isPromotedPrewarm)) {
        el.pause();
      } else if (isPlaying && !layer.reversePlayback) {
        void el.play().catch(() => {});
      }
      else el.pause();
    }
  }, [hasPromotedUnderlay, isPlaying, underlayLayerSignature]);

  const handleVideoTimeUpdate = useCallback(() => {
    const el = videoRef.current;
    if (!el || !shouldPublishVideoTimeUpdate({
      hasStream: playbackStreamReady,
      freezePlayback,
      reversePlayback,
      awaitingHandoff: Boolean(retainedPromotionLayerRef.current || presentedStreamRef.current !== mediaIdentity),
    })) return;
    // During a stream handoff the freshly mounted element briefly reports
    // pre-seek times; publishing them would rewind the global timeline clock.
    onPlayheadChangeRef.current?.(el.currentTime + sourceOffset, { clipId: previewClipIdRef.current });
  }, [freezePlayback, mediaIdentity, playbackStreamReady, reversePlayback, sourceOffset]);

  const revealPresentedFrame = useCallback((el) => {
    if (!el) return;
    let revealed = false;
    const reveal = (_now, metadata) => {
      if (revealed || videoRef.current !== el) return;
      const presentedTime = Number(metadata?.mediaTime ?? el.currentTime) + sourceOffset;
      const expectedTime = promotedPlaybackTime(frameAnchorRef.current.sourceTime);
      const tolerance = segmentedPreview
        ? SEGMENT_HANDOFF_TOLERANCE_SEC
        : (retainedPromotionLayerRef.current ? 0.1 : 0.2);
      if (!isHandoffFrameReady({
        mediaTime: presentedTime,
        expectedMediaTime: expectedTime,
        toleranceSec: tolerance,
        preventBackwardPresentation: segmentedPreview,
      })) return;
      revealed = true;
      presentedStreamRef.current = mediaIdentity;
      setHeldSwitchFrame(null);
      setSegmentMediaLoading(false);
      releasePromotedUnderlay();
    };
    if (typeof el.requestVideoFrameCallback === "function") {
      el.requestVideoFrameCallback(reveal);
      // A cached paused stream can present its sought frame before the rVFC
      // above is registered; the callback then never fires (no further frames
      // while paused) and the held switch-frame would cover the preview
      // forever. Double-rAF runs after the next composite as a fallback.
      window.requestAnimationFrame(() => window.requestAnimationFrame(() => {
        if (!el.seeking && el.readyState >= 2) reveal(undefined, undefined);
      }));
    } else {
      window.requestAnimationFrame(() => window.requestAnimationFrame(reveal));
    }
  }, [mediaIdentity, promotedPlaybackTime, releasePromotedUnderlay, segmentedPreview, sourceOffset]);

  const handleVideoLoaded = useCallback(() => {
    const el = videoRef.current;
    if (!el || !hasStream) return;
    setPlayError(null);
    if (el.videoWidth > 0 && el.videoHeight > 0) {
      setMainNaturalSize({ width: el.videoWidth, height: el.videoHeight });
    }
    if (segmentedPreview) return;
    if (Number.isFinite(el.duration) && el.duration > 0) {
      setVideoDuration(el.duration);
      onDurationChange?.(el.duration);
    }
  }, [hasStream, onDurationChange, segmentedPreview]);

  const handleVideoCanPlay = useCallback(() => {
    handleVideoLoaded();
    const el = videoRef.current;
    if (!el) return;
    const target = Math.max(0, promotedPlaybackTime(Math.max(0, Number(playheadSec) || 0)) - sourceOffset);
    const seekTolerance = segmentedPreview
      ? SEGMENT_HANDOFF_TOLERANCE_SEC
      : (retainedPromotionLayerRef.current ? 0.04 : 0.12);
    const shouldSeek = segmentedPreview
      ? el.currentTime < target - seekTolerance
      : Math.abs(el.currentTime - target) > seekTolerance;
    if (shouldSeek) {
      try {
        el.currentTime = target;
        return;
      } catch {
        // Clear the held frame below if seeking is unavailable.
      }
    }
    revealPresentedFrame(el);
  }, [handleVideoLoaded, playheadSec, promotedPlaybackTime, revealPresentedFrame, segmentedPreview, sourceOffset]);

  const handleVideoSeeked = useCallback(() => {
    const el = videoRef.current;
    // Schedule the reveal even below HAVE_CURRENT_DATA; the frame callback
    // fires once the sought frame is actually presented, and skipping here
    // could leave a stale held switch-frame covering a paused preview.
    if (!el) return;
    revealPresentedFrame(el);
    if (!isPlaying || !reversePlayback || freezePlayback) return;
    const target = reverseSeekTargetRef.current;
    if (!Number.isFinite(target) || Math.abs(el.currentTime - target) <= 0.012) return;
    window.requestAnimationFrame(() => {
      if (videoRef.current !== el || el.seeking) return;
      const latest = reverseSeekTargetRef.current;
      if (!Number.isFinite(latest) || Math.abs(el.currentTime - latest) <= 0.012) return;
      try {
        el.currentTime = latest;
      } catch {
        // The next playhead update retries the queued target.
      }
    });
  }, [freezePlayback, isPlaying, reversePlayback, revealPresentedFrame]);

  const handleVideoEnded = useCallback(() => {
    const el = videoRef.current;
    if (!el || freezePlayback) return;
    onPlayheadChangeRef.current?.(
      sourceOffset + (Number.isFinite(el.duration) ? el.duration : el.currentTime),
      { clipId: previewClipIdRef.current },
    );
  }, [freezePlayback, sourceOffset]);

  const handleVideoError = useCallback(() => {
    const el = videoRef.current;
    const code = el?.error?.code;
    if (segmentedPreview) {
      setSegmentMediaLoading(false);
      setPlayError("无法加载已生成的预览片段，请重试或检查后端 FFmpeg");
    } else if (code === 4) {
      setPlayError("浏览器无法解码此视频编码，请将 OBS 录制设为 H.264/MP4");
    } else {
      setPlayError("无法加载视频流，请确认文件存在且后端已启动");
    }
    onTogglePlay?.(false);
  }, [onTogglePlay, segmentedPreview]);

  const effectiveTotal = videoDuration ?? totalSec;
  const rulerPlayhead = sequenceMode && timelinePlayhead != null ? timelinePlayhead : playheadSec;
  const rulerTotal = sequenceMode && timelineTotal != null ? timelineTotal : effectiveTotal;

  useEffect(() => {
    if (!editingTime) setTimeDraft(formatTime(rulerPlayhead));
  }, [editingTime, rulerPlayhead]);

  const commitTimeDraft = () => {
    const parsed = parseTime(timeDraft);
    if (parsed == null) {
      setTimeDraft(formatTime(rulerPlayhead));
      return;
    }
    const next = Math.min(Math.max(0, parsed), Math.max(0, rulerTotal));
    if (sequenceMode && onTimelineSeek) onTimelineSeek(next);
    else onPlayheadChange?.(next);
    setTimeDraft(formatTime(next));
  };

  const changePreviewZoom = (direction) => {
    const values = [25, 50, 75, 100, 125, 150, 175, 200];
    const currentIndex = values.indexOf(previewZoom);
    const fallbackIndex = values.findIndex((value) => value >= previewZoom);
    const index = currentIndex >= 0 ? currentIndex : Math.max(0, fallbackIndex);
    setPreviewZoom(values[Math.max(0, Math.min(values.length - 1, index + direction))]);
  };

  const handleCanvasPointerDown = (e) => {
    if (e.target.closest("[data-preview-overlay]") || e.target.closest("[data-preview-video-layer]")) return;
    onOverlayDeselect?.();
  };

  const handleCanvasDragOver = (e) => {
    if (!e.dataTransfer.types.includes("application/x-litecut-media")) return;
    e.preventDefault();
    e.dataTransfer.dropEffect = "copy";
    setDropHover(true);
  };

  const handleCanvasDrop = (e) => {
    e.preventDefault();
    setDropHover(false);
    const raw = e.dataTransfer.getData("application/x-litecut-media");
    if (!raw || !onDropMedia) return;
    try {
      const media = JSON.parse(raw);
      const rect = canvasRef.current?.getBoundingClientRect();
      if (!rect) return;
      const x = Math.max(0, Math.min(1, (e.clientX - rect.left) / rect.width));
      const y = Math.max(0, Math.min(1, (e.clientY - rect.top) / rect.height));
      onDropMedia(media, { x, y });
    } catch {
      // ignore
    }
  };

  return (
    <div className="flex min-h-0 flex-1 flex-col bg-cs2-bg-sidebar">
      {preloadStreamUrl ? (
        <video
          ref={preloadVideoRef}
          key={`preload:${preloadStreamUrl}`}
          src={preloadStreamUrl}
          aria-hidden="true"
          tabIndex={-1}
          playsInline
          preload="auto"
          muted
          style={{ position: "fixed", left: -10, top: -10, width: 1, height: 1, opacity: 0, pointerEvents: "none" }}
        />
      ) : null}
      <div
        ref={previewViewportRef}
        className="relative min-h-0 flex-1 overflow-auto"
        onWheel={(event) => {
          if (!event.ctrlKey) return;
          event.preventDefault();
          changePreviewZoom(event.deltaY < 0 ? 1 : -1);
        }}
      >
        <div className="flex min-h-full min-w-full items-center justify-center p-3 sm:p-5">
        <div className="relative shrink-0" style={{ width: `${previewFitWidth * (previewZoom / 100)}px` }}>
          <div
            ref={canvasRef}
            data-preview-canvas
            className={`relative overflow-hidden rounded-md bg-black ring-1 transition-shadow ${              dropHover ? "ring-2 ring-cs2-accent ring-offset-2 ring-offset-cs2-bg-page" : "ring-white/10"
            }`}
            onDragOver={handleCanvasDragOver}
            onDragLeave={() => setDropHover(false)}
            onDrop={handleCanvasDrop}
            onPointerDown={handleCanvasPointerDown}
            style={{ backgroundColor: canvasBg, aspectRatio: `${Math.max(1, Number(canvasWidth) || 1920)} / ${Math.max(1, Number(canvasHeight) || 1080)}`, containerType: "size", contain: "layout paint" }}
          >
            {hasStream || hasPromotedUnderlay ? (
              <>
                {hasUnderlay
                  ? renderedUnderlayLayers.map((layer) => {
                      const isTransitionLayer = Boolean(layer?.transitionLayer);
                      const boundaryTransform = isTransitionLayer ? safeCompanionTransitionTransform : "";
                      const boundaryTransformOrigin = isTransitionLayer ? safeCompanionTransitionTransformOrigin : "";
                      const transform = normalizeSceneTransform(layer.transform, VIDEO_SCENE_TRANSFORM_DEFAULTS);
                      const materialLayout = sceneMaterialLayout({
                        transform,
                        crop: layer.crop,
                        contentFit: layer.contentFit === "blur" ? "contain" : (layer.contentFit || "contain"),
                        canvasWidth,
                        canvasHeight,
                        sourceWidth: layer.sourceWidth || canvasWidth,
                        sourceHeight: layer.sourceHeight || canvasHeight,
                      });
                      const opacity = previewUnderlayOpacity(layer, promotedUnderlayLayer?.id);
                      const ref = underlayMediaRegistryRef.current.refFor(layer.id);
                      // Lower-track clips never mount in the main <video>, so their
                      // real media duration is only learnable from the underlay element.
                      const reportUnderlayDuration = (event) => {
                        // A segmented proxy is only a ~4.5s playback window. Its
                        // media duration must never replace the linked source duration.
                        if (layer.segmentedPreview) return;
                        const duration = event.currentTarget?.duration;
                        if (Number.isFinite(duration) && duration > 0) onUnderlayDurationChange?.(layer.id, duration);
                      };
                      return (
                        <div
                          key={`underlay:${layer.streamUrl}:${layer.id}`}
                          className="pointer-events-none absolute z-0"
                          style={{
                            ...sceneTransformStyle(transform, {
                              defaults: VIDEO_SCENE_TRANSFORM_DEFAULTS,
                              flipHorizontal: layer.flipHorizontal,
                              flipVertical: layer.flipVertical,
                              opacity,
                              prefixTransform: boundaryTransform,
                            }),
                            transformOrigin: boundaryTransformOrigin || undefined,
                          }}
                        >
                          <div className="absolute inset-0 overflow-hidden">
                            <div style={materialLayout.viewportStyle}>
                              <video
                                ref={ref}
                                src={layer.streamUrl}
                                style={{ ...materialLayout.mediaStyle, filter: layer.filter || undefined }}
                                playsInline
                                preload="auto"
                                muted
                                onLoadedMetadata={reportUnderlayDuration}
                              />
                            </div>
                          </div>
                        </div>
                      );
                    })
                  : null}
                {showCanvasBlur ? (
                  <video
                    ref={bgVideoRef}
                    key={`bg:${mediaIdentity}`}
                    src={streamUrl}
                    className="absolute inset-0 z-0 h-full w-full object-cover"
                    style={{
                      filter: `${safeMainFilter ? `${safeMainFilter} ` : ""}${blurFilter}`,
                      objectPosition: `${(cropCenter.x * 100).toFixed(2)}% ${(cropCenter.y * 100).toFixed(2)}%`,
                      transformOrigin: `${(cropCenter.x * 100).toFixed(2)}% ${(cropCenter.y * 100).toFixed(2)}%`,
                      transform: `${mainFlipTransform || ""} scale(${cropPreviewScale.toFixed(4)})`.trim(),
                    }}
                    playsInline
                    preload="auto"
                    muted
                  />
                ) : null}
                {heldSwitchFrame && !hasPromotedUnderlay && !hasTransitionUnderlay ? <img src={heldSwitchFrame} alt="" className="pointer-events-none absolute inset-0 z-[2] h-full w-full object-contain" /> : null}
                {mainIsVideoLayer ? (
                  <div
                    data-preview-video-layer
                    onPointerDown={startMainLayerMove}
                    className={`absolute z-[1] touch-none ${
                      mainLayerDragging ? "cursor-grabbing" : mainLayerSelected ? "cursor-grab ring-2 ring-cs2-accent ring-offset-1 ring-offset-transparent" : ""
                    }`}
                    style={mainVideoStyle}
                  >
                    <div className="pointer-events-none absolute inset-0 overflow-hidden">
                      {fitMode === "blur" ? (
                        <div style={mainBlurLayout.viewportStyle}>
                          <video
                            ref={bgVideoRef}
                            key={`layer-bg:${mediaIdentity}`}
                            src={streamUrl}
                            style={{
                              ...mainBlurLayout.mediaStyle,
                              filter: `${safeMainFilter ? `${safeMainFilter} ` : ""}${blurFilter}`,
                            }}
                            playsInline
                            preload="auto"
                            muted
                          />
                        </div>
                      ) : null}
                      <div style={mainMaterialLayout.viewportStyle}>
                        <video
                          ref={videoRef}
                          key={mediaIdentity}
                          src={streamUrl}
                          style={{ ...mainMaterialLayout.mediaStyle, filter: safeMainFilter || undefined }}
                          playsInline
                          preload="auto"
                          muted={mainAudioMuted}
                          onTimeUpdate={handleVideoTimeUpdate}
                          onLoadedMetadata={handleVideoLoaded}
                          onCanPlay={handleVideoCanPlay}
                          onSeeked={handleVideoSeeked}
                          onError={handleVideoError}
                          onEnded={handleVideoEnded}
                        />
                      </div>
                    </div>
                    {mainLayerSelected ? (
                      <>
                        <span data-main-layer-handle onPointerDown={startMainLayerScale} className="absolute -left-1.5 -top-1.5 h-2.5 w-2.5 cursor-nwse-resize rounded-full border-2 border-white bg-cs2-accent shadow" />
                        <span data-main-layer-handle onPointerDown={startMainLayerScale} className="absolute -right-1.5 -top-1.5 h-2.5 w-2.5 cursor-nesw-resize rounded-full border-2 border-white bg-cs2-accent shadow" />
                        <span data-main-layer-handle onPointerDown={startMainLayerScale} className="absolute -bottom-1.5 -left-1.5 h-2.5 w-2.5 cursor-nesw-resize rounded-full border-2 border-white bg-cs2-accent shadow" />
                        <span data-main-layer-handle onPointerDown={startMainLayerScale} className="absolute -bottom-1.5 -right-1.5 h-2.5 w-2.5 cursor-nwse-resize rounded-full border-2 border-white bg-cs2-accent shadow" />
                        <span data-main-layer-handle onPointerDown={startMainLayerBoxResize("x", -1)} className="absolute -left-1.5 top-1/2 h-2.5 w-2.5 -translate-y-1/2 cursor-ew-resize rounded-full border-2 border-white bg-cyan-400 shadow" />
                        <span data-main-layer-handle onPointerDown={startMainLayerBoxResize("x", 1)} className="absolute -right-1.5 top-1/2 h-2.5 w-2.5 -translate-y-1/2 cursor-ew-resize rounded-full border-2 border-white bg-cyan-400 shadow" />
                        <span data-main-layer-handle onPointerDown={startMainLayerBoxResize("y", -1)} className="absolute left-1/2 -top-1.5 h-2.5 w-2.5 -translate-x-1/2 cursor-ns-resize rounded-full border-2 border-white bg-cyan-400 shadow" />
                        <span data-main-layer-handle onPointerDown={startMainLayerBoxResize("y", 1)} className="absolute -bottom-1.5 left-1/2 h-2.5 w-2.5 -translate-x-1/2 cursor-ns-resize rounded-full border-2 border-white bg-cyan-400 shadow" />
                        <span data-main-layer-handle onPointerDown={startMainLayerRotate} className="absolute -top-6 left-1/2 h-2.5 w-2.5 -translate-x-1/2 cursor-grab rounded-full border-2 border-white bg-cs2-accent-light shadow" />
                      </>
                    ) : null}
                  </div>
                ) : (
                  <>
                  <video
                    ref={videoRef}
                    key={mediaIdentity}
                    src={streamUrl}
                    className={`absolute inset-0 z-[1] h-full w-full ${mainObjectFit}`}
                    style={mainVideoStyle}
                    playsInline
                    preload="auto"
                    muted={mainAudioMuted}
                    onTimeUpdate={handleVideoTimeUpdate}
                    onLoadedMetadata={handleVideoLoaded}
                    onCanPlay={handleVideoCanPlay}
                    onSeeked={handleVideoSeeked}
                    onError={handleVideoError}
                    onEnded={handleVideoEnded}
                  />
                  </>
                )}
                {flashOpacity > 0 ? <div className="pointer-events-none absolute inset-0 z-[3] bg-white" style={{ opacity: flashOpacity }} /> : null}
                {blackOpacity > 0 ? <div className="pointer-events-none absolute inset-0 z-[3] bg-black" style={{ opacity: blackOpacity }} /> : null}
                {previewLabel ? (
                  <div className="pointer-events-none absolute left-3 top-3 z-[2] rounded bg-black/55 px-2 py-1 text-[10px] text-white/90">
                    {previewLabel}
                  </div>
                ) : null}
                {playError ? (
                  <div className="pointer-events-none absolute inset-x-4 bottom-4 z-[2] rounded-lg bg-rose-950/90 px-3 py-2 text-center text-[11px] text-rose-200">
                    {playError}
                  </div>
                ) : null}
              </>
            ) : sequenceMode ? (
              <div className="absolute inset-0" style={{ backgroundColor: canvasBg }} />
            ) : (
              <div className="absolute inset-0 bg-gradient-to-br from-slate-800 via-zinc-900 to-black">
                <div
                  className="absolute inset-0 opacity-[0.35]"
                  style={{
                    backgroundImage:
                      "linear-gradient(90deg, transparent 49%, rgba(255,255,255,0.03) 50%, transparent 51%), linear-gradient(0deg, transparent 49%, rgba(255,255,255,0.03) 50%, transparent 51%)",
                    backgroundSize: "48px 48px",
                  }}
                />
                <div className="absolute inset-x-0 bottom-0 flex h-1/3 items-end justify-center pb-8">
                  <p className="text-xs text-white/50">从媒体库拖入素材到此处预览区</p>
                </div>
              </div>
            )}

            {previewOverlays.length > 0
              ? previewOverlays.map((ov) => (
                  <PreviewOverlayItem
                    key={ov.id}
                    ov={ov}
                    assetPreviewVersion={assetPreviewVersions?.[Number(ov.meta?.asset_id)] || ""}
                    fontAssetSources={fontAssetSources}
                    playheadSec={displayTimelineTime}
                    mediaPlayheadSec={inputTimelineTime}
                    isPlaying={isPlaying}
                    selected={selectedOverlayId === ov.id}
                    onSelect={onOverlaySelect}
                    onDragStart={onOverlayDragStart}
                    onTransform={onOverlayTransform}
                    onGuides={setAlignmentGuides}
                    canvasWidth={canvasWidth}
                    canvasHeight={canvasHeight}
                    blurAmount={canvasBlurAmount}
                  />
                ))
              : null}
            {segmentedPreview && previewPending && !previewProxyError && !hasPromotedUnderlay && !hasTransitionUnderlay ? (
              <div className="pointer-events-none absolute inset-0 z-[30] flex items-center justify-center bg-black/35">
                <div className="flex items-center gap-2 rounded-lg border border-white/10 bg-zinc-950/90 px-3 py-2 text-xs text-white/85 shadow-xl backdrop-blur">
                  <Loader2 className="h-4 w-4 animate-spin text-cs2-accent" />
                  <span>正在生成素材附近的预览片段...</span>
                </div>
              </div>
            ) : null}
            {segmentedPreview && segmentMediaLoading && !previewPending && !previewProxyError && !heldSwitchFrame && !hasPromotedUnderlay && !hasTransitionUnderlay ? (
              <div className="pointer-events-none absolute inset-0 z-[30] flex items-center justify-center bg-black/35">
                <div className="flex items-center gap-2 rounded-lg border border-white/10 bg-zinc-950/90 px-3 py-2 text-xs text-white/85 shadow-xl backdrop-blur">
                  <Loader2 className="h-4 w-4 animate-spin text-cs2-accent" />
                  <span>正在载入已生成的预览片段…</span>
                </div>
              </div>
            ) : null}
            {segmentedPreview && previewProxyError ? (
              <div className="absolute inset-x-4 bottom-4 z-[31] flex items-center justify-center gap-2 rounded-lg bg-rose-950/90 px-3 py-2 text-center text-[11px] text-rose-200">
                <span>{previewProxyError}</span>
                <button
                  type="button"
                  onClick={() => onPreviewRetry?.()}
                  className="shrink-0 rounded border border-rose-300/30 bg-white/10 px-2 py-1 font-medium text-rose-100 hover:bg-white/20"
                >
                  重试
                </button>
              </div>
            ) : null}
            {alignmentGuides.x != null ? <div className="pointer-events-none absolute inset-y-0 z-[20] w-px bg-cyan-300 shadow-[0_0_6px_rgba(103,232,249,.9)]" style={{ left: `${alignmentGuides.x * 100}%` }} /> : null}
            {alignmentGuides.y != null ? <div className="pointer-events-none absolute inset-x-0 z-[20] h-px bg-cyan-300 shadow-[0_0_6px_rgba(103,232,249,.9)]" style={{ top: `${alignmentGuides.y * 100}%` }} /> : null}
            {!hasStream && !sequenceMode ? (
              <>
                <div className="absolute bottom-5 right-5 h-[26%] w-[20%] overflow-hidden rounded border-2 border-white/25 shadow-xl">
                  <div className="h-full w-full bg-gradient-to-br from-cyan-800/90 to-zinc-900" />
                </div>
                <div
                  className={`absolute left-1/2 top-[16%] -translate-x-1/2 ${
                    selectedElement === "text" ? "ring-2 ring-cs2-accent ring-offset-2 ring-offset-transparent" : ""
                  }`}
                >
                  <span className={`select-none whitespace-pre-wrap break-words ${styleCard?.className || ""}`} style={styleCard?.previewStyle}>
                    {overlayText || styleCard?.sample}
                  </span>
                </div>
              </>
            ) : null}
          </div>

          {audioPreviewItems.map((item) => (
            <PreviewAudioItem key={`${item.trackId}:${item.id}:${item.src}`} item={item} isPlaying={isPlaying} />
          ))}

          <button
            type="button"
            onClick={toggleFullscreen}
            className="absolute right-2 top-2 z-[3] rounded-md bg-black/40 p-1.5 text-white/70 backdrop-blur hover:text-white"
            title="全屏"
          >
            {isFullscreen ? <Minimize2 className="h-4 w-4" /> : <Maximize2 className="h-4 w-4" />}
          </button>
        </div>
        </div>
      </div>

      <div className="shrink-0 border-t border-cs2-border bg-cs2-bg-card px-4 py-2.5">
        <div className="mx-auto flex max-w-[920px] flex-wrap items-center gap-3">
          <div className="flex items-center gap-1">
            <button type="button" className="rounded-full p-2 text-cs2-text-muted hover:bg-white/5 hover:text-white" onClick={() => sequenceMode && onTimelineSeek ? onTimelineSeek(0) : onPlayheadChange?.(0)}>
              <SkipBack className="h-4 w-4" />
            </button>
            <button
              type="button"
              onClick={() => onTogglePlay?.()}
              disabled={!hasStream && !sequenceMode}
              className="rounded-full bg-white p-2.5 text-black shadow-lg hover:bg-zinc-100 disabled:cursor-not-allowed disabled:opacity-40"
            >
              {isPlaying ? <Pause className="h-4 w-4 fill-current" /> : <Play className="h-4 w-4 fill-current" />}
            </button>
            <button
              type="button"
              className="rounded-full p-2 text-cs2-text-muted hover:bg-white/5 hover:text-white"
              onClick={() => sequenceMode && onTimelineSeek ? onTimelineSeek(rulerTotal) : onPlayheadChange?.(effectiveTotal)}
              disabled={!hasStream && !sequenceMode}
            >
              <SkipForward className="h-4 w-4" />
            </button>
          </div>

          <span className="inline-flex shrink-0 items-center gap-1.5 font-mono text-[11px] tabular-nums">
            <input
              value={timeDraft}
              onFocus={() => setEditingTime(true)}
              onChange={(event) => setTimeDraft(event.target.value)}
              onBlur={() => { commitTimeDraft(); setEditingTime(false); }}
              onKeyDown={(event) => {
                if (event.key === "Enter") event.currentTarget.blur();
                if (event.key === "Escape") { setTimeDraft(formatTime(rulerPlayhead)); event.currentTarget.blur(); }
              }}
              className="h-6 w-[66px] cursor-text rounded-md border border-cs2-border-subtle bg-cs2-bg-input px-1.5 text-center font-mono text-[11px] font-medium text-cs2-text-primary outline-none transition-colors hover:border-cs2-border-focus focus:border-cs2-accent"
              aria-label="当前时间"
              title="输入时间并按回车跳转"
            />
            <span className="select-none text-cs2-text-muted">/</span>
            <span className="min-w-[52px] text-cs2-text-secondary">{formatTime(rulerTotal)}</span>
          </span>

          <input
            type="range"
            min={0}
            max={rulerTotal || 1}
            step={0.01}
            value={Math.min(rulerPlayhead, rulerTotal || 0)}
            onChange={(e) => {
              const t = Number(e.target.value);
              if (sequenceMode && onTimelineSeek) {
                onTimelineSeek(t);
                return;
              }
              onPlayheadChange?.(t);
              const el = videoRef.current;
              if (el && hasStream) {
                try {
                  const localTarget = Math.max(0, t - sourceOffset);
                  if (!segmentedPreview || !Number.isFinite(el.duration) || localTarget <= el.duration) {
                    el.currentTime = localTarget;
                  }
                } catch {
                  // ignore
                }
              }
            }}
            disabled={!hasStream && !sequenceMode}
            style={{ "--cs2-range-progress": `${rulerTotal > 0 ? Math.max(0, Math.min(100, (rulerPlayhead / rulerTotal) * 100)) : 0}%` }}
            className="cs2-data-slider min-w-[100px] flex-1 disabled:opacity-40"
          />

          <div className="ml-auto flex items-center gap-2">
            <button type="button" title="缩小预览" onClick={() => changePreviewZoom(-1)} className="rounded p-1 text-cs2-text-muted hover:bg-white/5 hover:text-white"><ZoomOut className="h-4 w-4" /></button>
            <select value={previewZoom} onChange={(event) => setPreviewZoom(Number(event.target.value))} className="rounded border border-cs2-border bg-cs2-bg-input px-1.5 py-1 font-mono text-[10px] text-cs2-text-secondary" aria-label="预览缩放">
              {[25, 50, 75, 100, 125, 150, 175, 200].map((value) => <option key={value} value={value}>{value}%</option>)}
            </select>
            <button type="button" title="放大预览" onClick={() => changePreviewZoom(1)} className="rounded p-1 text-cs2-text-muted hover:bg-white/5 hover:text-white"><ZoomIn className="h-4 w-4" /></button>
            <Volume2 className="h-4 w-4 text-cs2-text-muted" />
            <input
              type="range"
              defaultValue={85}
              style={{ "--cs2-range-progress": "85%" }}
              onInput={(event) => event.currentTarget.style.setProperty("--cs2-range-progress", `${event.currentTarget.value}%`)}
              className="cs2-data-slider w-20 disabled:opacity-40"
              disabled={!hasStream}
            />
          </div>
        </div>
        <p className="mx-auto mt-1.5 max-w-[920px] text-center text-[10px] text-cs2-text-muted">
          选中叠加层可拖动、缩放、旋转 · 点击空白取消选中
        </p>      </div>
    </div>
  );
}
