import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import { Maximize2, Minimize2, Pause, Play, SkipBack, SkipForward, Volume2, ZoomIn, ZoomOut } from "lucide-react";
import { TEXT_STYLE_CARDS } from "./editorPresets.js";
import { startPendingDrag } from "./timelineInteraction.js";
import { handoffFrameAction, normalizePreviewLayerTransform, previewFrameTimes, previewMediaIdentity, promotedUnderlayForMain, shouldApplyPreviewSeek, shouldPublishPreviewClock, shouldPublishVideoTimeUpdate, shouldUseMediaPreviewClock, transitionVisualAtLocalTime } from "./previewFrameUtils.js";
import PreviewAudioItem from "./PreviewAudioItem.jsx";
import { createMediaElementRefRegistry, drawVideoFrame, isInterruptedPlaybackError, releaseMediaElement } from "./previewMediaElementUtils.js";
import PreviewOverlayItem from "./LiteCutPreviewOverlay.jsx";

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
  transitionMainClipPath = "",
  transitionFlashOpacity = 0,
  transitionBlackOpacity = 0,
  transitionSpec = null,
  clipLocalTime = 0,
  clipVisibleDuration = 0,
  clipFadeInSec = 0,
  clipFadeOutSec = 0,
  mainFlipHorizontal = false,
  mainFlipVertical = false,
  mainCrop = null,
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
  const [dropHover, setDropHover] = useState(false);
  const [mainLayerDragging, setMainLayerDragging] = useState(false);
  const [isFullscreen, setIsFullscreen] = useState(false);
  const [previewZoom, setPreviewZoom] = useState(100);
  const [previewFitWidth, setPreviewFitWidth] = useState(920);
  const [timeDraft, setTimeDraft] = useState(formatTime(timelinePlayhead ?? playheadSec));
  const [editingTime, setEditingTime] = useState(false);
  const [alignmentGuides, setAlignmentGuides] = useState({ x: null, y: null });
  const styleCard = TEXT_STYLE_CARDS.find((c) => c.id === textStyleId) || TEXT_STYLE_CARDS.find((c) => c.id === "clutch");
  const hasStream = Boolean(streamUrl);
  const mediaIdentity = previewMediaIdentity(previewClipId, streamUrl);
  const safePlaybackRate = Math.max(0.25, Math.min(4, Number(playbackRate) || 1));
  const inputTimelineTime = Math.max(0, Number(timelinePlayhead ?? playheadSec) || 0);
  const inputLocalTime = Math.max(0, Number(clipLocalTime) || 0);
  const [previewClock, setPreviewClock] = useState(() => ({
    sourceTime: Math.max(0, Number(playheadSec) || 0),
    timelineTime: inputTimelineTime,
    clipLocalTime: inputLocalTime,
  }));
  const frameAnchorRef = useRef({
    sourceTime: Math.max(0, Number(playheadSec) || 0),
    timelineTime: inputTimelineTime,
    clipLocalTime: inputLocalTime,
    playbackRate: safePlaybackRate,
  });
  const clockClipRef = useRef(previewClipId);
  const previewClipIdRef = useRef(previewClipId);
  const onPlayheadChangeRef = useRef(onPlayheadChange);
  const presentedStreamRef = useRef(null);
  const lastPreviewClockAtRef = useRef(Number.NEGATIVE_INFINITY);
  const lastGlobalClockAtRef = useRef(0);
  const previousUnderlayLayersRef = useRef([]);
  const retainedPromotionLayerRef = useRef(null);
  const handoffStartedAtRef = useRef(0);
  const handoffSeekAtRef = useRef(0);
  const appliedUserSeekTokenRef = useRef(0);
  const reverseSeekTargetRef = useRef(null);
  const [, forcePromotionRender] = useState(0);

  useLayoutEffect(() => () => {
    const elements = new Set([
      videoRef.current,
      bgVideoRef.current,
      preloadVideoRef.current,
      ...underlayVideoRefs.current.values(),
      ...(canvasRef.current?.querySelectorAll("video, audio") || []),
    ]);
    elements.forEach(releaseMediaElement);
    underlayVideoRefs.current.clear();
  }, []);

  const releasePromotedUnderlay = useCallback(() => {
    if (!retainedPromotionLayerRef.current) return;
    retainedPromotionLayerRef.current = null;
    forcePromotionRender((version) => version + 1);
  }, []);
  const promotedPlaybackTime = useCallback((fallback) => {
    const promoted = retainedPromotionLayerRef.current;
    const promotedElement = promoted ? underlayVideoRefs.current.get(String(promoted.id)) : null;
    return promotedElement?.readyState >= 2 && Number.isFinite(promotedElement.currentTime)
      ? promotedElement.currentTime
      : fallback;
  }, []);

  useLayoutEffect(() => {
    onPlayheadChangeRef.current = onPlayheadChange;
    previewClipIdRef.current = previewClipId;
    const clipChanged = clockClipRef.current !== previewClipId;
    clockClipRef.current = previewClipId;
    const nextClock = {
      sourceTime: Math.max(0, Number(playheadSec) || 0),
      timelineTime: inputTimelineTime,
      clipLocalTime: inputLocalTime,
    };
    frameAnchorRef.current = { ...nextClock, playbackRate: safePlaybackRate };
    if (!isPlaying || clipChanged || reversePlayback || freezePlayback) {
      setPreviewClock(nextClock);
    }
  }, [clipLocalTime, freezePlayback, inputLocalTime, inputTimelineTime, isPlaying, onPlayheadChange, playheadSec, previewClipId, reversePlayback, safePlaybackRate]);

  useEffect(() => {
    const el = videoRef.current;
    if (!el || !hasStream || !isPlaying || reversePlayback || freezePlayback) return;
    lastPreviewClockAtRef.current = Number.NEGATIVE_INFINITY;
    let cancelled = false;
    let videoFrameId = null;
    let animationFrameId = null;

    const publishFrame = (now, mediaTime) => {
      if (cancelled || !Number.isFinite(mediaTime) || el.readyState < 2) return;
      const hasPromotedLayer = Boolean(retainedPromotionLayerRef.current);
      const action = handoffFrameAction({
        mediaTime,
        expectedMediaTime: promotedPlaybackTime(frameAnchorRef.current.sourceTime),
        awaitingHandoff: hasPromotedLayer || presentedStreamRef.current !== mediaIdentity,
        hasPromotedLayer,
        keepPromotedFrameUntilCaughtUp: Boolean(retainedPromotionLayerRef.current?.prewarm),
        handoffStartedAt: handoffStartedAtRef.current,
        lastCorrectiveSeekAt: handoffSeekAtRef.current,
        seeking: Boolean(el.seeking),
        now,
      });
      if (action.type !== "present") {
        handoffStartedAtRef.current = action.startedAt;
        if (action.type === "seek") {
          handoffSeekAtRef.current = now;
          try {
            el.currentTime = action.target;
          } catch {
            // A transient decoder failure is retried on the next presented frame.
          }
        }
        return;
      }
      handoffStartedAtRef.current = 0;
      const frame = previewFrameTimes(frameAnchorRef.current, mediaTime);
      if (shouldPublishPreviewClock(now, lastPreviewClockAtRef.current)) {
        lastPreviewClockAtRef.current = now;
        setPreviewClock((previous) => (
          Math.abs(previous.sourceTime - frame.sourceTime) < 0.0005
          && Math.abs(previous.timelineTime - frame.timelineTime) < 0.0005
            ? previous
            : frame
        ));
      }
      releasePromotedUnderlay();
      if (presentedStreamRef.current !== mediaIdentity) {
        presentedStreamRef.current = mediaIdentity;
        setHeldSwitchFrame(null);
      }
      if (now - lastGlobalClockAtRef.current >= 45) {
        lastGlobalClockAtRef.current = now;
        onPlayheadChangeRef.current?.(mediaTime, {
          clipId: previewClipIdRef.current,
          timelineSec: frame.timelineTime,
        });
      }
    };

    if (typeof el.requestVideoFrameCallback === "function") {
      const requestNext = () => {
        videoFrameId = el.requestVideoFrameCallback((now, metadata) => {
          publishFrame(now, Number(metadata?.mediaTime ?? el.currentTime));
          if (!cancelled) requestNext();
        });
      };
      requestNext();
    } else {
      const requestNext = (now) => {
        publishFrame(now, Number(el.currentTime));
        if (!cancelled) animationFrameId = window.requestAnimationFrame(requestNext);
      };
      animationFrameId = window.requestAnimationFrame(requestNext);
    }

    return () => {
      cancelled = true;
      if (videoFrameId != null && typeof el.cancelVideoFrameCallback === "function") el.cancelVideoFrameCallback(videoFrameId);
      if (animationFrameId != null) window.cancelAnimationFrame(animationFrameId);
    };
  }, [freezePlayback, hasStream, isPlaying, mediaIdentity, previewClipId, promotedPlaybackTime, releasePromotedUnderlay, reversePlayback, streamUrl]);

  const useMediaClock = shouldUseMediaPreviewClock({ hasStream, isPlaying, reversePlayback, freezePlayback });
  const localTime = useMediaClock ? previewClock.clipLocalTime : inputLocalTime;
  const displayTimelineTime = useMediaClock ? previewClock.timelineTime : inputTimelineTime;
  const visibleDuration = Math.max(0, Number(clipVisibleDuration) || 0);
  const clipFadeIn = Math.max(0, Number(clipFadeInSec) || 0);
  const clipFadeOut = Math.max(0, Number(clipFadeOutSec) || 0);
  const clipFadeInFactor = clipFadeIn > 0 ? Math.min(1, localTime / clipFadeIn) : 1;
  const clipFadeOutFactor =
    clipFadeOut > 0 && visibleDuration > 0 ? Math.min(1, Math.max(0, (visibleDuration - localTime) / clipFadeOut)) : 1;
  const liveTransitionVisual = transitionVisualAtLocalTime(transitionSpec, localTime);
  const resolvedTransitionOpacity = liveTransitionVisual?.mainOpacity ?? transitionMainOpacity;
  const resolvedTransitionTransform = liveTransitionVisual?.mainTransform ?? transitionMainTransform;
  const resolvedTransitionClipPath = liveTransitionVisual?.mainClipPath ?? transitionMainClipPath;
  const resolvedFlashOpacity = liveTransitionVisual?.flashOpacity ?? transitionFlashOpacity;
  const resolvedBlackOpacity = liveTransitionVisual?.blackOpacity ?? transitionBlackOpacity;
  const videoOpacity = Math.min(clipFadeInFactor, clipFadeOutFactor) * Math.max(0, Math.min(1, Number(resolvedTransitionOpacity) || 0));
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
  const mainObjectFit = !mainIsVideoLayer && (fitMode === "cover" || hasMainCrop) ? "object-cover" : "object-contain";
  const showCanvasBlur = !mainIsVideoLayer && fitMode === "blur";
  const canvasBg = /^#[0-9a-f]{6}$/i.test(String(canvasBackgroundColor || "")) ? canvasBackgroundColor : "#000000";
  const blurPx = Math.max(8, Math.min(56, Number(canvasBlurAmount) || 24));

  useLayoutEffect(() => {
    const main = videoRef.current;
    const background = bgVideoRef.current;
    return () => {
      releaseMediaElement(main);
      if (background !== main) releaseMediaElement(background);
    };
  }, [mediaIdentity, showCanvasBlur]);

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
      || String(retainedPromotionLayerRef.current.streamUrl || "") !== String(streamUrl || "")
      || !hasStream
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
    .map((layer) => `${layer.id}:${layer.streamUrl}:${layer.playbackRate}:${layer.reversePlayback}`)
    .join("|");
  const hasUnderlay = renderedUnderlayLayers.length > 0;
  const hasTransitionUnderlay = renderedUnderlayLayers.some((layer) => String(layer?.id || "").startsWith("transition-"));
  useLayoutEffect(() => {
    previousUnderlayLayersRef.current = resolvedUnderlayLayers;
  }, [resolvedUnderlayLayers]);
  const mainReverse = Boolean(reversePlayback);
  const normalizedMainLayerTransform = normalizePreviewLayerTransform(mainLayerTransform);
  const transformedMainObjectFit = Math.abs(normalizedMainLayerTransform.width - normalizedMainLayerTransform.height) > 0.001
    ? "object-fill"
    : mainObjectFit;
  const mainFlipTransform = mainFlipHorizontal || mainFlipVertical ? `scale(${mainFlipHorizontal ? -1 : 1}, ${mainFlipVertical ? -1 : 1})` : undefined;
  const safeMainFilter = String(mainFilter || "").trim();
  const safeTransitionTransform = String(resolvedTransitionTransform || "").trim();
  const safeTransitionClipPath = String(resolvedTransitionClipPath || "").trim();
  const flashOpacity = Math.max(0, Math.min(1, Number(resolvedFlashOpacity) || 0));
  const blackOpacity = Math.max(0, Math.min(1, Number(resolvedBlackOpacity) || 0));
  const safeMainVolume = Math.max(0, Math.min(1, Number(mainVolume) || 0));
  const mainAudioMuted = Boolean(mainMuted || safeMainVolume <= 0);
  const mainVideoStyle = mainIsVideoLayer
    ? {
        left: `${(normalizedMainLayerTransform.x * 100).toFixed(2)}%`,
        top: `${(normalizedMainLayerTransform.y * 100).toFixed(2)}%`,
        width: `${(normalizedMainLayerTransform.width * 100).toFixed(2)}%`,
        height: `${(normalizedMainLayerTransform.height * 100).toFixed(2)}%`,
        opacity: hasPromotedUnderlay ? 0 : videoOpacity * normalizedMainLayerTransform.opacity,
        filter: safeMainFilter || undefined,
        clipPath: safeTransitionClipPath || undefined,
        transform: `${safeTransitionTransform} translate(-50%, -50%) scale(${normalizedMainLayerTransform.scale * (mainFlipHorizontal ? -1 : 1)}, ${normalizedMainLayerTransform.scale * (mainFlipVertical ? -1 : 1)}) rotate(${normalizedMainLayerTransform.rotation}deg)`.trim(),
        willChange: isPlaying ? "transform, opacity, clip-path, filter" : undefined,
      }
    : {
        opacity: hasPromotedUnderlay ? 0 : videoOpacity,
        filter: safeMainFilter || undefined,
        objectPosition: `${(cropCenter.x * 100).toFixed(2)}% ${(cropCenter.y * 100).toFixed(2)}%`,
        transformOrigin: `${(cropCenter.x * 100).toFixed(2)}% ${(cropCenter.y * 100).toFixed(2)}%`,
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
    if (!mainLayerSelected) return;
    const canvas = e.currentTarget.closest("[data-preview-canvas]");
    const rect = canvas?.getBoundingClientRect();
    if (!rect) return;
    const origin = { x: e.clientX, y: e.clientY };
    const ox = normalizedMainLayerTransform.x;
    const oy = normalizedMainLayerTransform.y;
    startPendingDrag(e.pointerId, origin, {
      onDragStart: () => setMainLayerDragging(true),
      onDragMove: (ev) => {
        const sx = snapCanvasValue(Math.max(0, Math.min(1, ox + (ev.clientX - origin.x) / rect.width)));
        const sy = snapCanvasValue(Math.max(0, Math.min(1, oy + (ev.clientY - origin.y) / rect.height)));
        setAlignmentGuides({ x: sx.guide, y: sy.guide });
        onMainLayerTransform?.({ x: sx.value, y: sy.value });
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
        onMainLayerTransform?.({ scale: Math.max(0.1, Math.min(5, originScale * (dist / originDist))) });
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
        if (axis === "x") onMainLayerTransform?.({ width: Math.max(0.05, Math.min(1, originW + direction * ((ev.clientX - origin.x) * 2) / rect.width)) });
        if (axis === "y") onMainLayerTransform?.({ height: Math.max(0.05, Math.min(1, originH + direction * ((ev.clientY - origin.y) * 2) / rect.height)) });
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
        onMainLayerTransform?.({ rotation: snapRotation(originRotation + ((angle - startAngle) * 180) / Math.PI) });
      },
      onDragEnd: () => setMainLayerDragging(false),
    });
  };

  useEffect(() => {
    setVideoDuration(null);
    setPlayError(null);
  }, [mediaIdentity]);

  useLayoutEffect(() => {
    if (!hasStream) setHeldSwitchFrame(null);
  }, [hasStream]);

  useLayoutEffect(() => {
    handoffStartedAtRef.current = 0;
    handoffSeekAtRef.current = 0;
    const element = videoRef.current;
    const captureConfig = switchCaptureConfigRef.current;
    return () => {
      if (!retainedPromotionLayerRef.current) holdCompositedFrame(element, captureConfig);
    };
  }, [holdCompositedFrame, mediaIdentity]);

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

  useEffect(() => {
    // During ordinary forward playback the media element is the clock. Seeking
    // it again whenever React publishes the playhead causes large sources to
    // discard decoded frames and repeatedly rebuffer. Stream hand-offs perform
    // their own initial seek in handleVideoCanPlay below.
    const shouldSeek = shouldApplyPreviewSeek({
      isPlaying,
      reversePlayback: mainReverse,
      freezePlayback,
      userSeekToken,
      appliedUserSeekToken: appliedUserSeekTokenRef.current,
    });
    if (!shouldSeek) return;
    const pendingUserSeek = Number(userSeekToken) > 0 && userSeekToken !== appliedUserSeekTokenRef.current;
    const applySeek = (el) => {
      try {
        const fallback = Math.max(0, playheadSec);
        const seekTo = el === videoRef.current ? promotedPlaybackTime(fallback) : fallback;
        const seekTolerance = el === videoRef.current && retainedPromotionLayerRef.current ? 0.04 : 0.15;
        if (Math.abs(el.currentTime - seekTo) > seekTolerance) el.currentTime = seekTo;
      } catch {
        // ignore seek before metadata
      }
    };
    const cleanup = [];
    let seekScheduled = false;
    for (const el of [videoRef.current, bgVideoRef.current]) {
      if (!el || !hasStream) continue;
      seekScheduled = true;
      const onLoaded = () => applySeek(el);
      if (el.readyState >= 1) applySeek(el);
      else {
        el.addEventListener("loadedmetadata", onLoaded, { once: true });
        cleanup.push(() => el.removeEventListener("loadedmetadata", onLoaded));
      }
    }
    if (pendingUserSeek && seekScheduled) appliedUserSeekTokenRef.current = userSeekToken;
    return () => cleanup.forEach((fn) => fn());
  }, [mediaIdentity, hasStream, playheadSec, fitMode, isPlaying, mainReverse, freezePlayback, promotedPlaybackTime, userSeekToken]);

  useEffect(() => {
    if (!hasStream || !isPlaying || !mainReverse || freezePlayback) {
      reverseSeekTargetRef.current = null;
      return;
    }
    const el = videoRef.current;
    const target = Math.max(0, Number(playheadSec) || 0);
    reverseSeekTargetRef.current = target;
    if (!el || el.readyState < 1 || el.seeking) return;
    if (Math.abs(el.currentTime - target) <= 0.012) return;
    try {
      el.currentTime = target;
    } catch {
      // Metadata or a previous decoder seek may still be settling. The latest
      // target stays queued and is retried by handleVideoSeeked.
    }
  }, [freezePlayback, hasStream, isPlaying, mainReverse, mediaIdentity, playheadSec]);

  const underlaySeekSignature = resolvedUnderlayLayers
    .map((layer) => `${layer.id}:${Number(layer.sourceTime) || 0}`)
    .join("|");

  useEffect(() => {
    const cleanup = [];
    for (const layer of resolvedUnderlayLayers) {
      const el = underlayVideoRefs.current.get(String(layer.id));
      if (!el) continue;
      const seekTo = Math.max(0, Number(layer.sourceTime) || 0);
      const applySeek = () => {
        try {
          if (Math.abs(el.currentTime - seekTo) > 0.15) el.currentTime = seekTo;
        } catch {
          // ignore seek before metadata
        }
      };
      if (el.readyState >= 1) applySeek();
      else {
        el.addEventListener("loadedmetadata", applySeek, { once: true });
        cleanup.push(() => el.removeEventListener("loadedmetadata", applySeek));
      }
    }
    return () => cleanup.forEach((fn) => fn());
  }, [underlayLayerSignature, underlaySeekSignature, isPlaying]);

  useEffect(() => {
    if (!hasStream) return;
    for (const el of [videoRef.current, bgVideoRef.current]) {
      if (!el) continue;
      if (isPlaying && !mainReverse && !freezePlayback) {
        void el.play().catch((err) => {
          if (isInterruptedPlaybackError(err)) return;
          setPlayError(err?.message || "play_failed");
          onTogglePlay?.(false);
        });
      } else {
        el.pause();
      }
    }
  }, [isPlaying, hasStream, onTogglePlay, fitMode, mainReverse, freezePlayback, mediaIdentity]);

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
      hasStream,
      freezePlayback,
      reversePlayback,
      awaitingHandoff: Boolean(retainedPromotionLayerRef.current || presentedStreamRef.current !== mediaIdentity),
    })) return;
    // During a stream handoff the freshly mounted element briefly reports
    // pre-seek times; publishing them would rewind the global timeline clock.
    onPlayheadChangeRef.current?.(el.currentTime, { clipId: previewClipIdRef.current });
  }, [hasStream, freezePlayback, mediaIdentity, reversePlayback]);

  const revealPresentedFrame = useCallback((el) => {
    if (!el) return;
    let revealed = false;
    const reveal = (_now, metadata) => {
      if (revealed || videoRef.current !== el) return;
      const presentedTime = Number(metadata?.mediaTime ?? el.currentTime);
      const expectedTime = promotedPlaybackTime(frameAnchorRef.current.sourceTime);
      const tolerance = retainedPromotionLayerRef.current ? 0.1 : 0.2;
      if (Math.abs(presentedTime - expectedTime) > tolerance) return;
      revealed = true;
      presentedStreamRef.current = mediaIdentity;
      setHeldSwitchFrame(null);
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
  }, [mediaIdentity, promotedPlaybackTime, releasePromotedUnderlay]);

  const handleVideoLoaded = useCallback(() => {
    const el = videoRef.current;
    if (!el || !hasStream) return;
    if (Number.isFinite(el.duration) && el.duration > 0) {
      setVideoDuration(el.duration);
      onDurationChange?.(el.duration);
      setPlayError(null);
    }
  }, [hasStream, onDurationChange]);

  const handleVideoCanPlay = useCallback(() => {
    handleVideoLoaded();
    const el = videoRef.current;
    if (!el) return;
    const target = promotedPlaybackTime(Math.max(0, Number(playheadSec) || 0));
    const seekTolerance = retainedPromotionLayerRef.current ? 0.04 : 0.12;
    if (Math.abs(el.currentTime - target) > seekTolerance) {
      try {
        el.currentTime = target;
        return;
      } catch {
        // Clear the held frame below if seeking is unavailable.
      }
    }
    revealPresentedFrame(el);
  }, [handleVideoLoaded, playheadSec, promotedPlaybackTime, revealPresentedFrame]);

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
      Number.isFinite(el.duration) ? el.duration : el.currentTime,
      { clipId: previewClipIdRef.current },
    );
  }, [freezePlayback]);

  const handleVideoError = useCallback(() => {
    const el = videoRef.current;
    const code = el?.error?.code;
    if (code === 4) {
      setPlayError("浏览器无法解码此视频编码，请将 OBS 录制设为 H.264/MP4");
    } else {
      setPlayError("无法加载视频流，请确认文件存在且后端已启动");
    }
    onTogglePlay?.(false);
  }, [onTogglePlay]);

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

  useLayoutEffect(() => {
    const viewport = previewViewportRef.current;
    if (!viewport) return undefined;

    const updatePreviewFit = () => {
      const aspect = Math.max(1, Number(canvasWidth) || 1920) / Math.max(1, Number(canvasHeight) || 1080);
      const availableWidth = Math.max(1, viewport.clientWidth - 40);
      const availableHeight = Math.max(1, viewport.clientHeight - 40);
      const nextWidth = Math.max(1, Math.min(920, availableWidth, availableHeight * aspect));
      setPreviewFitWidth((current) => (Math.abs(current - nextWidth) < 0.5 ? current : nextWidth));
    };

    updatePreviewFit();
    const observer = typeof ResizeObserver !== "undefined" ? new ResizeObserver(updatePreviewFit) : null;
    observer?.observe(viewport);
    window.addEventListener("resize", updatePreviewFit);
    return () => {
      observer?.disconnect();
      window.removeEventListener("resize", updatePreviewFit);
    };
  }, [canvasHeight, canvasWidth]);

  const handleCanvasPointerDown = (e) => {
    if (e.target.closest("[data-preview-overlay]") || e.target.closest("[data-preview-video-layer]")) return;
    onOverlayDeselect?.();
  };

  const toggleFullscreen = useCallback(async () => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    try {
      if (document.fullscreenElement === canvas) await document.exitFullscreen();
      else await canvas.requestFullscreen?.();
    } catch {
      // The browser can reject fullscreen outside a trusted user gesture.
    }
  }, []);

  useEffect(() => {
    const syncFullscreenState = () => setIsFullscreen(document.fullscreenElement === canvasRef.current);
    document.addEventListener("fullscreenchange", syncFullscreenState);
    syncFullscreenState();
    return () => document.removeEventListener("fullscreenchange", syncFullscreenState);
  }, []);

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
            {hasStream ? (
              <>
                {hasUnderlay
                  ? renderedUnderlayLayers.map((layer) => {
                      const flip = layer.flipHorizontal || layer.flipVertical
                        ? `scale(${layer.flipHorizontal ? -1 : 1}, ${layer.flipVertical ? -1 : 1})`
                        : undefined;
                      const transform = layer.transform && typeof layer.transform === "object" ? normalizePreviewLayerTransform(layer.transform) : null;
                      const x = transform?.x ?? 0.5;
                      const y = transform?.y ?? 0.5;
                      const width = transform?.width ?? 1;
                      const height = transform?.height ?? 1;
                      const objectFit = Math.abs(width - height) > 0.001 ? "object-fill" : "object-contain";
                      const scale = transform?.scale ?? 1;
                      const rotation = transform?.rotation ?? 0;
                      const transformOpacity = transform?.opacity ?? 1;
                      const opacity = Math.max(0, Math.min(1, Number(layer.opacity) || 0)) * transformOpacity;
                      const ref = underlayMediaRegistryRef.current.refFor(layer.id);
                      // Lower-track clips never mount in the main <video>, so their
                      // real media duration is only learnable from the underlay element.
                      const reportUnderlayDuration = (event) => {
                        const duration = event.currentTarget?.duration;
                        if (Number.isFinite(duration) && duration > 0) onUnderlayDurationChange?.(layer.id, duration);
                      };
                      if (transform) {
                        return (
                          <div
                            key={`underlay:${layer.streamUrl}:${layer.id}`}
                            className="pointer-events-none absolute z-0"
                            style={{
                              left: `${(x * 100).toFixed(2)}%`,
                              top: `${(y * 100).toFixed(2)}%`,
                              width: `${(width * 100).toFixed(2)}%`,
                              height: `${(height * 100).toFixed(2)}%`,
                              opacity,
                              filter: layer.filter || undefined,
                              transform: `translate(-50%, -50%) scale(${scale * (layer.flipHorizontal ? -1 : 1)}, ${scale * (layer.flipVertical ? -1 : 1)}) rotate(${rotation}deg)`,
                            }}
                          >
                            <video ref={ref} src={layer.streamUrl} className={`block h-full w-full ${objectFit}`} playsInline preload="auto" muted onLoadedMetadata={reportUnderlayDuration} />
                          </div>
                        );
                      }
                      return (
                        <video
                          ref={ref}
                          key={`underlay:${layer.streamUrl}:${layer.id}`}
                          src={layer.streamUrl}
                          className="absolute inset-0 z-0 h-full w-full object-contain"
                          style={{ opacity, filter: layer.filter || undefined, transform: flip }}
                          playsInline
                          preload="auto"
                          muted
                          onLoadedMetadata={reportUnderlayDuration}
                        />
                      );
                    })
                  : null}
                {showCanvasBlur ? (
                  <video
                    ref={bgVideoRef}
                    key={`bg:${mediaIdentity}`}
                    src={streamUrl}
                    className="absolute inset-0 z-0 h-full w-full object-cover opacity-75"
                    style={{
                      filter: `${safeMainFilter ? `${safeMainFilter} ` : ""}blur(${blurPx}px)`,
                      objectPosition: `${(cropCenter.x * 100).toFixed(2)}% ${(cropCenter.y * 100).toFixed(2)}%`,
                      transformOrigin: `${(cropCenter.x * 100).toFixed(2)}% ${(cropCenter.y * 100).toFixed(2)}%`,
                      transform: `${mainFlipTransform || ""} scale(${(cropPreviewScale * 1.1).toFixed(4)})`.trim(),
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
                    <video
                      ref={videoRef}
                      key={mediaIdentity}
                      src={streamUrl}
                      className={`pointer-events-none block h-full w-full ${transformedMainObjectFit}`}
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
                    canvasHeight={canvasHeight}
                  />
                ))
              : null}
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
                  <span className={`select-none whitespace-pre-wrap break-words ${styleCard?.className || ""}`}>
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
                  el.currentTime = t;
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
