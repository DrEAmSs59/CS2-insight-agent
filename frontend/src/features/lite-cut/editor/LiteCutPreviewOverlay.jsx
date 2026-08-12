import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { getLiteCutAssetStreamUrl, getLiteCutBuiltinFontUrl } from "../../../api/api.js";
import { startPendingDrag } from "./timelineInteraction.js";
import { sceneMaterialLayout, sceneResolvedContentFit, sceneTransformAt, sceneTransformStyle } from "../state/sceneTransform.js";
import { filterStyleFromColor } from "./editorPresets.js";
import { transitionNodePreviewVisual } from "./transitionPreviewUtils.js";
import {
  normalizeTextLayout,
  previewFontFamilyForFace,
  resolveBuiltinTextFontFace,
  textBlockJustifyContent,
  textOutlineCss,
  textStylePreset,
} from "./textLayout.js";
import PreviewAudioItem from "./PreviewAudioItem.jsx";
import { releaseMediaElement } from "./previewMediaElementUtils.js";
import { useSegmentedPreviewSource } from "./useSegmentedPreviewSource.js";
import {
  clampSceneScale,
  clampSceneSize,
  scenePositionForCanvasDrag,
  snapCanvasRotation,
} from "./sceneCanvasInteraction.js";

const previewFontLoadPromises = new Map();

function cssString(value) {
  return JSON.stringify(String(value || ""));
}

function ensurePreviewFontLoaded(family, url, sample = "", weight = 700) {
  if (!family || !url) return Promise.resolve();
  const safeWeight = Math.max(100, Math.min(900, Number(weight) || 700));
  const key = `${family}\n${url}\n${safeWeight}`;
  if (previewFontLoadPromises.has(key)) return previewFontLoadPromises.get(key);
  let promise;
  if (document.fonts?.load) {
    // The matching @font-face rule is rendered with the overlay. FontFaceSet.load
    // works in desktop WebView builds where the global FontFace constructor is
    // unavailable, and also gives us a reliable point at which to repaint text.
    promise = document.fonts.load(`${safeWeight} 64px ${cssString(family)}`, String(sample || ""));
  } else if (typeof FontFace !== "undefined") {
    promise = new FontFace(family, `url(${cssString(url)})`, { weight: String(safeWeight) })
      .load()
      .then((loaded) => document.fonts?.add?.(loaded));
  } else {
    promise = Promise.resolve();
  }
  promise = Promise.resolve(promise).catch((error) => {
    previewFontLoadPromises.delete(key);
    throw error;
  });
  previewFontLoadPromises.set(key, promise);
  return promise;
}

function PreviewOverlayItem({ ov, assetPreviewVersion = "", playheadSec = 0, mediaPlayheadSec = playheadSec, isPlaying = false, selected, onSelect, onDragStart, onTransform, onGuides, canvasWidth = 1920, canvasHeight = 1080, blurAmount = 24, fontAssetSources = {} }) {
  const videoRef = useRef(null);
  const backgroundVideoRef = useRef(null);
  const [live, setLive] = useState(null);
  const [isDragging, setIsDragging] = useState(false);
  const animatedTransform = sceneTransformAt(ov, playheadSec);
  const tx = live?.x ?? animatedTransform.x;
  const ty = live?.y ?? animatedTransform.y;
  const scale = live?.scale ?? animatedTransform.scale;
  const rotation = live?.rotation ?? animatedTransform.rotation;
  const boxW = live?.width ?? animatedTransform.width;
  const boxH = live?.height ?? animatedTransform.height;
  const flipHorizontal = Boolean(ov.flip_horizontal);
  const flipVertical = Boolean(ov.flip_vertical);
  const resolvedContentFit = sceneResolvedContentFit(ov, ov.content_fit || "fill");
  const materialLayout = sceneMaterialLayout({
    transform: { ...animatedTransform, ...(live || {}), width: boxW, height: boxH },
    crop: ov.crop,
    contentFit: resolvedContentFit === "blur" ? "contain" : resolvedContentFit,
    canvasWidth,
    canvasHeight,
    sourceWidth: Number(ov.meta?.source_width) || canvasWidth,
    sourceHeight: Number(ov.meta?.source_height) || canvasHeight,
  });
  const blurLayout = sceneMaterialLayout({
    transform: { ...animatedTransform, ...(live || {}), width: boxW, height: boxH },
    crop: ov.crop,
    contentFit: "cover",
    canvasWidth,
    canvasHeight,
    sourceWidth: Number(ov.meta?.source_width) || canvasWidth,
    sourceHeight: Number(ov.meta?.source_height) || canvasHeight,
  });
  const blurFilter = `blur(${(Math.max(4, Math.min(80, Number(blurAmount) || 24)) / Math.max(1, Number(canvasHeight) || 1080)) * 100}cqh)`;
  const color = ov.color || {};
  const colorFilter = filterStyleFromColor({
    brightness: color.brightness ?? 0,
    contrast: color.contrast ?? 0,
    saturation: color.saturation ?? 0,
    preset: color.filter_preset || "none",
  }).filter;
  const start = Math.max(0, Number(ov.timeline_start) || 0);
  const duration = Math.max(0, Number(ov.duration) || 0);
  const elapsed = Math.max(0, Number(playheadSec) - start);
  let opacity = 1;
  const aid = ov.meta?.asset_id;
  const directSrc = aid ? getLiteCutAssetStreamUrl(aid, assetPreviewVersion || ov.meta?.preview_proxy_version) : null;
  const isVideo = ov.type === "webm" || ov.meta?.kind === "webm" || ov.meta?.kind === "video";
  const isLoopingAnimation = Boolean(ov.meta?.is_looping_animation) || /\.(gif|webp)$/i.test(String(ov.meta?.name || ov.asset_path || ""));
  const mediaElapsed = Math.max(0, Number(mediaPlayheadSec) - start);
  const rawOverlaySourceTime = Math.max(0, (Number(ov.trim_in) || 0) + mediaElapsed);
  const sourceDuration = Math.max(0, Number(ov.meta?.duration_sec) || 0);
  const segmentStepSec = Number(ov.meta?.preview_segment_step_sec) || 4;
  const overlaySourceTime = isLoopingAnimation && sourceDuration > 0
    ? rawOverlaySourceTime % sourceDuration
    : rawOverlaySourceTime;
  const segmentedSource = useSegmentedPreviewSource({
    assetId: aid,
    directStreamUrl: directSrc,
    enabled: Boolean(isVideo && aid && ov.meta?.preview_proxy_required && ov.meta?.preview_proxy_mode === "segmented"),
    isPlaying,
    segmentStepSec,
    sourceDurationSec: sourceDuration,
    sourceTime: overlaySourceTime,
  });
  const src = segmentedSource.streamUrl;
  const overlayVideoTime = Math.max(0, overlaySourceTime - Math.max(0, Number(segmentedSource.mediaTimeOffset) || 0));
  const loopMediaElement = isLoopingAnimation && (
    !segmentedSource.segmented || (sourceDuration > 0 && sourceDuration <= segmentStepSec + 0.05)
  );

  useLayoutEffect(() => {
    const elements = [videoRef.current, backgroundVideoRef.current];
    return () => elements.forEach((element) => releaseMediaElement(element));
  }, [src]);
  const overlayVideoTimeRef = useRef(overlayVideoTime);
  overlayVideoTimeRef.current = overlayVideoTime;
  const isText = ov.type === "text";
  const textContent = isText ? (ov.text?.content || ov.meta?.name || "Text") : "";
  const textLayout = isText ? normalizeTextLayout(ov.text) : null;
  const textAlign = textLayout?.align || "center";
  const textFontWeight = textLayout?.fontWeight;
  const textPreset = isText ? textStylePreset(ov.text?.preset_id || ov.meta?.textStyleId) : null;
  const customFont = isText ? fontAssetSources[String(ov.text?.font_file || "")] : null;
  const builtinFontFace = isText ? resolveBuiltinTextFontFace(ov.text?.font_family, textFontWeight) : null;
  const resolvedFontFamily = isText ? (customFont?.family || previewFontFamilyForFace(builtinFontFace)) : "";
  const previewFontUrl = isText ? (customFont?.url || getLiteCutBuiltinFontUrl(builtinFontFace.file)) : "";
  const previewFontFaceRule = isText && previewFontUrl
    ? `@font-face{font-family:${cssString(resolvedFontFamily)};src:url(${cssString(previewFontUrl)});font-style:normal;font-weight:${textFontWeight};font-display:swap;}`
    : "";
  const [fontLoadRevision, setFontLoadRevision] = useState(0);
  const transitionState = ov._transition_state && typeof ov._transition_state === "object" ? ov._transition_state : null;
  const transitionVisual = transitionState
    ? transitionNodePreviewVisual(transitionState.type, transitionState.role, transitionState.progress, transitionState)
    : transitionNodePreviewVisual("none", "to", 1);
  opacity *= transitionVisual.mainOpacity;
  const materialFilter = [colorFilter, transitionVisual.materialFilter].filter(Boolean).join(" ") || undefined;

  useLayoutEffect(() => () => {
    releaseMediaElement(videoRef.current);
    releaseMediaElement(backgroundVideoRef.current);
  }, []);

  useEffect(() => {
    if (!isText || !previewFontUrl) return undefined;
    let cancelled = false;
    void ensurePreviewFontLoaded(resolvedFontFamily, previewFontUrl, textContent, textFontWeight)
      .then(() => {
        if (!cancelled) setFontLoadRevision((value) => value + 1);
      })
      .catch(() => {});
    return () => { cancelled = true; };
  }, [isText, previewFontUrl, resolvedFontFamily, textContent, textFontWeight]);

  useEffect(() => {
    const el = videoRef.current;
    if (!el || !isVideo || !src) return;
    const applySeek = () => {
      try {
        const maxTime = Number.isFinite(el.duration) && el.duration > 0 ? Math.max(0, el.duration - 0.05) : overlayVideoTime;
        const target = loopMediaElement && maxTime > 0
          ? overlayVideoTime % Math.max(0.05, maxTime)
          : Math.min(overlayVideoTime, maxTime);
        if (Math.abs(el.currentTime - target) > 0.18) el.currentTime = target;
      } catch {
        // ignore seek before metadata
      }
    };
    let waitingForMetadata = false;
    if (el.readyState >= 1) {
      applySeek();
    } else {
      waitingForMetadata = true;
      el.addEventListener("loadedmetadata", applySeek, { once: true });
    }
    if (isPlaying) {
      void el.play().catch(() => {});
    } else {
      el.pause();
    }
    return () => {
      if (waitingForMetadata) el.removeEventListener("loadedmetadata", applySeek);
    };
  }, [isVideo, src, loopMediaElement, isPlaying]);

  useEffect(() => {
    const foreground = videoRef.current;
    const background = backgroundVideoRef.current;
    if (!foreground || !background || resolvedContentFit !== "blur" || !isVideo || !src) return undefined;
    const synchronize = () => {
      try {
        if (Math.abs(background.currentTime - foreground.currentTime) > 0.04) background.currentTime = foreground.currentTime;
        background.playbackRate = foreground.playbackRate;
        if (isPlaying && !foreground.paused) void background.play().catch(() => {});
        else background.pause();
      } catch {
        // The background is cosmetic; a transient seek failure must not block playback.
      }
    };
    synchronize();
    const id = window.setInterval(synchronize, 100);
    return () => window.clearInterval(id);
  }, [isPlaying, isVideo, resolvedContentFit, src]);

  useEffect(() => {
    const el = videoRef.current;
    if (!el || !isVideo || !src || isPlaying) return;
    try {
      const maxTime = Number.isFinite(el.duration) && el.duration > 0 ? Math.max(0, el.duration - 0.05) : overlayVideoTime;
      const target = loopMediaElement && maxTime > 0
        ? overlayVideoTime % Math.max(0.05, maxTime)
        : Math.min(overlayVideoTime, maxTime);
      if (Math.abs(el.currentTime - target) > 0.04) el.currentTime = target;
    } catch {
      // ignore seek before metadata
    }
  }, [isVideo, src, loopMediaElement, isPlaying, overlayVideoTime]);

  useEffect(() => {
    const el = videoRef.current;
    if (!el || !isVideo || !src || !isPlaying) return;
    const id = window.setInterval(() => {
      const rawTarget = overlayVideoTimeRef.current;
      const maxTime = Number.isFinite(el.duration) && el.duration > 0 ? Math.max(0, el.duration - 0.05) : rawTarget;
      const target = loopMediaElement && maxTime > 0
        ? rawTarget % Math.max(0.05, maxTime)
        : Math.min(rawTarget, maxTime);
      if (Math.abs(el.currentTime - target) <= 0.22) return;
      try {
        el.currentTime = target;
      } catch {
        // ignore a transient decoder seek failure
      }
    }, 250);
    return () => window.clearInterval(id);
  }, [isVideo, src, loopMediaElement, isPlaying]);

  const applyTransform = (patch) => {
    onTransform?.(ov.id, patch);
  };

  const startMove = (e) => {
    if (e.target.closest("[data-transform-handle]")) return;
    e.preventDefault();
    e.stopPropagation();
    if (!selected) {
      onSelect?.(ov.id);
    }
    const canvas = e.currentTarget.closest("[data-preview-canvas]");
    const rect = canvas?.getBoundingClientRect();
    if (!rect) return;
    const origin = { x: e.clientX, y: e.clientY };
    const ox = tx;
    const oy = ty;

    startPendingDrag(e.pointerId, origin, {
      onDragStart: () => {
        onDragStart?.();
        setIsDragging(true);
      },
      onDragMove: (ev) => {
        const position = scenePositionForCanvasDrag({
          x: ox,
          y: oy,
          deltaX: ev.clientX - origin.x,
          deltaY: ev.clientY - origin.y,
          canvasWidth: rect.width,
          canvasHeight: rect.height,
        });
        setLive({ x: position.x, y: position.y, scale, rotation, width: boxW, height: boxH });
        onGuides?.(position.guides);
        applyTransform({ x: position.x, y: position.y });
      },
      onDragEnd: () => {
        setLive(null);
        setIsDragging(false);
        onGuides?.({ x: null, y: null });
      },
      onClick: () => onSelect?.(ov.id),
    });
  };

  const startScale = (e) => {
    e.preventDefault();
    e.stopPropagation();
    if (!selected) onSelect?.(ov.id);
    const canvas = e.currentTarget.closest("[data-preview-canvas]");
    const rect = canvas?.getBoundingClientRect();
    if (!rect) return;
    const originScale = scale;
    const originDist = Math.hypot(e.clientX - rect.left - tx * rect.width, e.clientY - rect.top - ty * rect.height) || 1;
    startPendingDrag(e.pointerId, { x: e.clientX, y: e.clientY }, {
      onDragStart: () => {
        onDragStart?.();
        setIsDragging(true);
      },
      onDragMove: (ev) => {
        const dist = Math.hypot(ev.clientX - rect.left - tx * rect.width, ev.clientY - rect.top - ty * rect.height);
        const next = clampSceneScale(originScale * (dist / originDist));
        setLive({ x: tx, y: ty, scale: next, rotation });
        applyTransform({ scale: next });
      },
      onDragEnd: () => {
        setLive(null);
        setIsDragging(false);
      },
    });
  };

  const startRotate = (e) => {
    e.preventDefault();
    e.stopPropagation();
    if (!selected) onSelect?.(ov.id);
    const canvas = e.currentTarget.closest("[data-preview-canvas]");
    const rect = canvas?.getBoundingClientRect();
    if (!rect) return;
    const cx = rect.left + tx * rect.width;
    const cy = rect.top + ty * rect.height;
    const originRot = rotation;
    const startAngle = Math.atan2(e.clientY - cy, e.clientX - cx);
    startPendingDrag(e.pointerId, { x: e.clientX, y: e.clientY }, {
      onDragStart: () => {
        onDragStart?.();
        setIsDragging(true);
      },
      onDragMove: (ev) => {
        const angle = Math.atan2(ev.clientY - cy, ev.clientX - cx);
        const deg = snapCanvasRotation(originRot + ((angle - startAngle) * 180) / Math.PI);
        setLive({ x: tx, y: ty, scale, rotation: deg });
        applyTransform({ rotation: deg });
      },
      onDragEnd: () => {
        setLive(null);
        setIsDragging(false);
      },
    });
  };

  const startBoxResize = (axis, direction) => (e) => {
    e.preventDefault();
    e.stopPropagation();
    if (!selected) onSelect?.(ov.id);
    const canvas = e.currentTarget.closest("[data-preview-canvas]");
    const rect = canvas?.getBoundingClientRect();
    if (!rect) return;
    const origin = { x: e.clientX, y: e.clientY };
    const originW = boxW;
    const originH = boxH;
    startPendingDrag(e.pointerId, origin, {
      onDragStart: () => { onDragStart?.(); setIsDragging(true); },
      onDragMove: (ev) => {
        const patch = {};
        if (axis === "x") patch.width = clampSceneSize(originW + direction * ((ev.clientX - origin.x) * 2) / rect.width);
        if (axis === "y") patch.height = clampSceneSize(originH + direction * ((ev.clientY - origin.y) * 2) / rect.height);
        setLive({ x: tx, y: ty, scale, rotation, width: patch.width ?? originW, height: patch.height ?? originH });
        applyTransform(patch);
      },
      onDragEnd: () => { setLive(null); setIsDragging(false); },
    });
  };

  const handleCls =
    "absolute z-[8] h-3.5 w-3.5 rounded-full border-2 border-white bg-cs2-accent shadow pointer-events-auto touch-none";
  const handleInverseScale = 1 / Math.max(0.01, Math.abs(scale));
  const cornerHandleStyle = { transform: `scale(${handleInverseScale})` };
  const horizontalHandleStyle = { transform: `translateY(-50%) scale(${handleInverseScale})` };
  const verticalHandleStyle = { transform: `translateX(-50%) scale(${handleInverseScale})` };

  return (
    <div
      role="button"
      tabIndex={0}
      data-preview-overlay
      onPointerDown={startMove}
      className={`absolute z-[4] touch-none ${
        isDragging ? "z-[6] cursor-grabbing" : selected ? "z-[5] cursor-grab" : "cursor-pointer"
      }`}
      style={{
        ...sceneTransformStyle(
          { ...animatedTransform, ...(live || {}), x: tx, y: ty, width: boxW, height: boxH, scale, rotation },
          { flipHorizontal, flipVertical, opacity, prefixTransform: transitionVisual.mainTransform },
        ),
        clipPath: transitionVisual.mainClipPath || undefined,
        transition: isDragging || isPlaying ? "none" : "transform 0.12s ease",
        willChange: isPlaying ? "transform, opacity, clip-path" : undefined,
      }}
    >
      {isText && previewFontFaceRule ? <style>{previewFontFaceRule}</style> : null}
      <div className={`relative h-full w-full ${selected ? "ring-2 ring-cs2-accent ring-offset-1 ring-offset-transparent" : ""}`}>
        {isText ? (
          <div
            data-font-load-revision={fontLoadRevision}
            className="pointer-events-none flex h-full min-h-8 w-full items-center overflow-hidden"
            style={{
              fontFamily: resolvedFontFamily,
              fontSize: `${(textLayout.fontSize / Math.max(1, Number(canvasHeight) || 1080)) * 100}cqh`,
              fontWeight: textFontWeight,
              fontSynthesis: "none",
              lineHeight: textLayout.lineHeight,
              justifyContent: textBlockJustifyContent(textAlign),
              color: textLayout.fillColor || textPreset.fill_color || "#ffffff",
              WebkitTextStroke: textOutlineCss(canvasHeight),
              paintOrder: "stroke fill",
              filter: transitionVisual.materialFilter || undefined,
            }}
          >
            <span
              data-preview-text-block
              style={{
                flex: "0 0 auto",
                letterSpacing: "0px",
                textAlign,
                whiteSpace: "pre",
              }}
            >
              {textContent}
            </span>
          </div>
        ) : src ? (
          <div className="pointer-events-none absolute inset-0 overflow-hidden">
            {resolvedContentFit === "blur" ? (
              <div style={blurLayout.viewportStyle}>
                {isVideo ? (
                  <video
                    ref={backgroundVideoRef}
                    src={src}
                    className="pointer-events-none absolute max-w-none"
                    muted
                    playsInline
                    loop={loopMediaElement}
                    preload="auto"
                    style={{ ...blurLayout.mediaStyle, filter: [materialFilter, blurFilter].filter(Boolean).join(" ") }}
                  />
                ) : (
                  <img src={src} alt="" draggable={false} className="pointer-events-none absolute max-w-none" style={{ ...blurLayout.mediaStyle, filter: [materialFilter, blurFilter].filter(Boolean).join(" ") }} />
                )}
              </div>
            ) : null}
            <div style={materialLayout.viewportStyle}>
              {isVideo ? (
                <video
                  ref={videoRef}
                  src={src}
                  className="pointer-events-none absolute max-w-none drop-shadow-lg"
                  muted
                  playsInline
                  loop={loopMediaElement}
                  preload="auto"
                  style={{ ...materialLayout.mediaStyle, filter: materialFilter }}
                />
              ) : (
                <img src={src} alt="" draggable={false} className="pointer-events-none absolute max-w-none drop-shadow-lg" style={{ ...materialLayout.mediaStyle, filter: materialFilter }} />
              )}
            </div>
          </div>
        ) : null}
        {selected ? (
          <>
            <span data-transform-handle style={cornerHandleStyle} className={`${handleCls} -left-1.5 -top-1.5 cursor-nwse-resize`} onPointerDown={startScale} />
            <span data-transform-handle style={cornerHandleStyle} className={`${handleCls} -right-1.5 -top-1.5 cursor-nesw-resize`} onPointerDown={startScale} />
            <span data-transform-handle style={cornerHandleStyle} className={`${handleCls} -bottom-1.5 -left-1.5 cursor-nesw-resize`} onPointerDown={startScale} />
            <span data-transform-handle style={cornerHandleStyle} className={`${handleCls} -bottom-1.5 -right-1.5 cursor-nwse-resize`} onPointerDown={startScale} />
            <span data-transform-handle style={horizontalHandleStyle} className={`${handleCls} -left-1.5 top-1/2 cursor-ew-resize`} onPointerDown={startBoxResize("x", -1)} />
            <span data-transform-handle style={horizontalHandleStyle} className={`${handleCls} -right-1.5 top-1/2 cursor-ew-resize`} onPointerDown={startBoxResize("x", 1)} />
            <span data-transform-handle style={verticalHandleStyle} className={`${handleCls} left-1/2 -top-1.5 cursor-ns-resize`} onPointerDown={startBoxResize("y", -1)} />
            <span data-transform-handle style={verticalHandleStyle} className={`${handleCls} -bottom-1.5 left-1/2 cursor-ns-resize`} onPointerDown={startBoxResize("y", 1)} />
            <span
              data-transform-handle
              className="absolute -top-6 left-1/2 z-[8] h-3.5 w-3.5 cursor-grab rounded-full border-2 border-white bg-cs2-accent-light shadow pointer-events-auto touch-none"
              style={verticalHandleStyle}
              onPointerDown={startRotate}
            />
          </>
        ) : null}
      </div>
    </div>
  );
}

export default PreviewOverlayItem;
