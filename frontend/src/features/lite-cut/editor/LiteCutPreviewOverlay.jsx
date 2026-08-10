import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { getLiteCutAssetStreamUrl, getLiteCutBuiltinFontUrl } from "../../../api/api.js";
import { TEXT_STYLE_CARDS } from "./editorPresets.js";
import { startPendingDrag } from "./timelineInteraction.js";
import { overlayTransformAt } from "../state/overlayKeyframeUtils.js";
import { textTransitionPreviewVisual, transitionPreviewVisual } from "./transitionPreviewUtils.js";
import PreviewAudioItem from "./PreviewAudioItem.jsx";
import { releaseMediaElement } from "./previewMediaElementUtils.js";

const ROTATION_SNAP_POINTS = [-180, -120, -90, -60, -30, 0, 30, 60, 90, 120, 180];
const BUILTIN_FONT_FILES = {
  "思源黑体 Medium": "NotoSansSC-Medium.ttf",
  "Noto Sans SC": "NotoSansSC-Bold.ttf",
};
const previewFontLoadPromises = new Map();

function cssString(value) {
  return JSON.stringify(String(value || ""));
}

function ensurePreviewFontLoaded(family, url, sample = "") {
  if (!family || !url) return Promise.resolve();
  const key = `${family}\n${url}`;
  if (previewFontLoadPromises.has(key)) return previewFontLoadPromises.get(key);
  let promise;
  if (document.fonts?.load) {
    // The matching @font-face rule is rendered with the overlay. FontFaceSet.load
    // works in desktop WebView builds where the global FontFace constructor is
    // unavailable, and also gives us a reliable point at which to repaint text.
    promise = document.fonts.load(`700 64px ${cssString(family)}`, String(sample || ""));
  } else if (typeof FontFace !== "undefined") {
    promise = new FontFace(family, `url(${cssString(url)})`, { weight: "100 900" })
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

function previewFontFamily(ov, fontAssetSources = {}) {
  const raw = String(ov?.text?.font_family || "微软雅黑");
  const requested = /^rajdhani(?:\s+bold)?$/i.test(raw) ? "微软雅黑" : raw;
  const custom = fontAssetSources[String(ov?.text?.font_file || "")];
  if (custom?.family) return custom.family;
  return BUILTIN_FONT_FILES[requested] ? `LiteCut ${requested}` : requested;
}

function snapCanvasValue(value) {
  const points = [0, 0.25, 0.5, 0.75, 1];
  const nearest = points.reduce((best, point) => Math.abs(point - value) < Math.abs(best - value) ? point : best, points[0]);
  return Math.abs(nearest - value) <= 0.012 ? { value: nearest, guide: nearest } : { value, guide: null };
}

function snapRotation(value) {
  const normalized = Math.max(-180, Math.min(180, value));
  const nearest = ROTATION_SNAP_POINTS.reduce((best, point) => Math.abs(point - normalized) < Math.abs(best - normalized) ? point : best, 0);
  return Math.abs(nearest - normalized) <= 3 ? nearest : normalized;
}

function PreviewOverlayItem({ ov, assetPreviewVersion = "", playheadSec = 0, mediaPlayheadSec = playheadSec, isPlaying = false, selected, onSelect, onDragStart, onTransform, onGuides, canvasHeight = 1080, fontAssetSources = {} }) {
  const videoRef = useRef(null);
  const [live, setLive] = useState(null);
  const [isDragging, setIsDragging] = useState(false);
  const animatedTransform = overlayTransformAt(ov, playheadSec);
  const tx = live?.x ?? animatedTransform.x;
  const ty = live?.y ?? animatedTransform.y;
  const scale = live?.scale ?? animatedTransform.scale;
  const rotation = live?.rotation ?? animatedTransform.rotation;
  const boxW = live?.width ?? animatedTransform.width;
  const boxH = live?.height ?? animatedTransform.height;
  const flipHorizontal = Boolean(ov.flip_horizontal);
  const flipVertical = Boolean(ov.flip_vertical);
  const boxObjectFit = Math.abs(boxW - boxH) > 0.001 ? "object-fill" : "object-contain";
  const baseOpacity = animatedTransform.opacity;
  const start = Math.max(0, Number(ov.timeline_start) || 0);
  const duration = Math.max(0, Number(ov.duration) || 0);
  const elapsed = Math.max(0, Number(playheadSec) - start);
  const fadeIn = Math.max(0, Number(ov.fade_in_sec) || 0);
  const fadeOut = Math.max(0, Number(ov.fade_out_sec) || 0);
  const fadeInFactor = fadeIn > 0 ? Math.min(1, elapsed / fadeIn) : 1;
  const fadeOutFactor = fadeOut > 0 && duration > 0 ? Math.min(1, Math.max(0, (duration - elapsed) / fadeOut)) : 1;
  let opacity = baseOpacity * Math.min(fadeInFactor, fadeOutFactor);
  const aid = ov.meta?.asset_id;
  const src = aid ? getLiteCutAssetStreamUrl(aid, assetPreviewVersion || ov.meta?.preview_proxy_version) : null;
  const isVideo = ov.type === "webm" || ov.meta?.kind === "webm" || ov.meta?.kind === "video";
  const isLoopingAnimation = Boolean(ov.meta?.is_looping_animation) || /\.gif$/i.test(String(ov.meta?.name || ov.asset_path || ""));

  useLayoutEffect(() => {
    const element = videoRef.current;
    return () => releaseMediaElement(element);
  }, [src]);
  const mediaElapsed = Math.max(0, Number(mediaPlayheadSec) - start);
  const overlayVideoTime = Math.max(0, (Number(ov.trim_in) || 0) + mediaElapsed);
  const overlayVideoTimeRef = useRef(overlayVideoTime);
  overlayVideoTimeRef.current = overlayVideoTime;
  const isText = ov.type === "text";
  // Text scaling follows the export path: it enlarges glyphs but keeps the
  // authored alignment box anchored in place. File overlays still scale their
  // full box as before.
  const visualScale = isText ? 1 : scale;
  const textCard = TEXT_STYLE_CARDS.find((c) => c.id === (ov.text?.preset_id || ov.meta?.textStyleId)) || TEXT_STYLE_CARDS.find((c) => c.id === "plain");
  const textContent = ov.text?.content || ov.meta?.name || "Text";
  const textAlign = ["left", "center", "right"].includes(ov.text?.align) ? ov.text.align : "center";
  const customFont = fontAssetSources[String(ov.text?.font_file || "")];
  const resolvedFontFamily = previewFontFamily(ov, fontAssetSources);
  const requestedFont = String(ov.text?.font_family || "微软雅黑");
  const builtinFontFile = BUILTIN_FONT_FILES[requestedFont];
  const previewFontUrl = customFont?.url || (builtinFontFile ? getLiteCutBuiltinFontUrl(builtinFontFile) : "");
  const previewFontFaceRule = previewFontUrl
    ? `@font-face{font-family:${cssString(resolvedFontFamily)};src:url(${cssString(previewFontUrl)});font-style:normal;font-weight:100 900;font-display:swap;}`
    : "";
  const [fontLoadRevision, setFontLoadRevision] = useState(0);
  const animDur = Math.min(0.45, duration || 0.45);
  const animIn = String(ov.text?.anim_in || "");
  const animOut = String(ov.text?.anim_out || "");
  const inProgress = animDur > 0 ? Math.min(1, elapsed / animDur) : 1;
  const outProgress = animDur > 0 && duration > 0 && elapsed > duration - animDur ? Math.min(1, (elapsed - (duration - animDur)) / animDur) : 0;
  let motionX = 0;
  let motionY = 0;
  const applyAnim = (name, progress, entering) => {
    const amount = entering ? 1 - progress : progress;
    if (name === "fade") opacity *= entering ? progress : 1 - progress;
    // Use output-canvas fractions instead of a percentage of the text box.
    // FFmpeg uses these same 12% / 10% offsets when exporting drawtext.
    if (name === "slide_left") motionX += entering ? 0.12 * amount : -0.12 * amount;
    if (name === "slide_right") motionX += entering ? -0.12 * amount : 0.12 * amount;
    if (name === "slide_up") motionY += entering ? 0.1 * amount : -0.1 * amount;
    if (name === "slide_down") motionY += entering ? -0.1 * amount : 0.1 * amount;
  };
  if (isText) {
    applyAnim(animIn, inProgress, true);
    if (outProgress > 0) applyAnim(animOut, outProgress, false);
  }
  const transitionIn = ov.transition_in && typeof ov.transition_in === "object" ? ov.transition_in : null;
  const transitionOut = ov.transition_out && typeof ov.transition_out === "object" ? ov.transition_out : null;
  const transitionInDuration = Math.max(0, Number(transitionIn?.duration_sec) || 0);
  const transitionOutDuration = Math.max(0, Number(transitionOut?.duration_sec) || 0);
  let transitionVisual = transitionPreviewVisual("none", 1);
  if (transitionIn?.type && transitionIn.type !== "cut" && transitionInDuration > 0 && elapsed < transitionInDuration) {
    transitionVisual = transitionPreviewVisual(transitionIn.type, elapsed / transitionInDuration);
    if (isText) {
      const textVisual = textTransitionPreviewVisual(transitionIn.type, elapsed / transitionInDuration, "in");
      transitionVisual = { ...transitionPreviewVisual("none", 1), mainOpacity: textVisual.opacity };
      motionX += textVisual.offsetX;
      motionY += textVisual.offsetY;
    }
  } else if (transitionOut?.type && transitionOut.type !== "cut" && transitionOutDuration > 0 && elapsed > duration - transitionOutDuration) {
    const progress = 1 - ((elapsed - (duration - transitionOutDuration)) / transitionOutDuration);
    transitionVisual = transitionPreviewVisual(transitionOut.type, progress);
    if (isText) {
      const textVisual = textTransitionPreviewVisual(transitionOut.type, progress, "out");
      transitionVisual = { ...transitionPreviewVisual("none", 1), mainOpacity: textVisual.opacity };
      motionX += textVisual.offsetX;
      motionY += textVisual.offsetY;
    }
  }
  opacity *= transitionVisual.mainOpacity;

  useLayoutEffect(() => () => releaseMediaElement(videoRef.current), []);

  useEffect(() => {
    if (!isText || !previewFontUrl) return undefined;
    let cancelled = false;
    void ensurePreviewFontLoaded(resolvedFontFamily, previewFontUrl, textContent)
      .then(() => {
        if (!cancelled) setFontLoadRevision((value) => value + 1);
      })
      .catch(() => {});
    return () => { cancelled = true; };
  }, [isText, previewFontUrl, resolvedFontFamily, textContent]);

  useEffect(() => {
    const el = videoRef.current;
    if (!el || !isVideo || !src) return;
    const applySeek = () => {
      try {
        const maxTime = Number.isFinite(el.duration) && el.duration > 0 ? Math.max(0, el.duration - 0.05) : overlayVideoTime;
        const target = isLoopingAnimation && maxTime > 0
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
  }, [isVideo, src, isLoopingAnimation, isPlaying]);

  useEffect(() => {
    const el = videoRef.current;
    if (!el || !isVideo || !src || isPlaying) return;
    try {
      const maxTime = Number.isFinite(el.duration) && el.duration > 0 ? Math.max(0, el.duration - 0.05) : overlayVideoTime;
      const target = isLoopingAnimation && maxTime > 0
        ? overlayVideoTime % Math.max(0.05, maxTime)
        : Math.min(overlayVideoTime, maxTime);
      if (Math.abs(el.currentTime - target) > 0.04) el.currentTime = target;
    } catch {
      // ignore seek before metadata
    }
  }, [isVideo, src, isLoopingAnimation, isPlaying, overlayVideoTime]);

  useEffect(() => {
    const el = videoRef.current;
    if (!el || !isVideo || !src || !isPlaying) return;
    const id = window.setInterval(() => {
      const rawTarget = overlayVideoTimeRef.current;
      const maxTime = Number.isFinite(el.duration) && el.duration > 0 ? Math.max(0, el.duration - 0.05) : rawTarget;
      const target = isLoopingAnimation && maxTime > 0
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
  }, [isVideo, src, isLoopingAnimation, isPlaying]);

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
        const sx = snapCanvasValue(Math.max(0, Math.min(1, ox + (ev.clientX - origin.x) / rect.width)));
        const sy = snapCanvasValue(Math.max(0, Math.min(1, oy + (ev.clientY - origin.y) / rect.height)));
        setLive({ x: sx.value, y: sy.value, scale, rotation, width: boxW, height: boxH });
        onGuides?.({ x: sx.guide, y: sy.guide });
        applyTransform({ x: sx.value, y: sy.value });
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
        const next = Math.max(0.01, Math.min(5, originScale * (dist / originDist)));
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
        const deg = snapRotation(originRot + ((angle - startAngle) * 180) / Math.PI);
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
        if (axis === "x") patch.width = Math.max(0.05, Math.min(10, originW + direction * ((ev.clientX - origin.x) * 2) / rect.width));
        if (axis === "y") patch.height = Math.max(0.05, Math.min(10, originH + direction * ((ev.clientY - origin.y) * 2) / rect.height));
        setLive({ x: tx, y: ty, scale, rotation, width: patch.width ?? originW, height: patch.height ?? originH });
        applyTransform(patch);
      },
      onDragEnd: () => { setLive(null); setIsDragging(false); },
    });
  };

  const handleCls =
    "absolute z-[8] h-3.5 w-3.5 rounded-full border-2 border-white bg-cs2-accent shadow pointer-events-auto touch-none";
  const handleInverseScale = 1 / Math.max(0.01, Math.abs(visualScale));
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
        left: `${((tx + motionX) * 100).toFixed(2)}%`,
        top: `${((ty + motionY) * 100).toFixed(2)}%`,
        width: `${(boxW * 100).toFixed(2)}%`,
        height: `${(boxH * 100).toFixed(2)}%`,
        opacity,
        clipPath: transitionVisual.mainClipPath || undefined,
        transform: `${transitionVisual.mainTransform || ""} translate(-50%, -50%) scale(${visualScale * (flipHorizontal ? -1 : 1)}, ${visualScale * (flipVertical ? -1 : 1)}) rotate(${rotation}deg)`.trim(),
        transition: isDragging || isPlaying ? "none" : "transform 0.12s ease",
        willChange: isPlaying ? "transform, opacity, clip-path" : undefined,
      }}
    >
      {isText && previewFontFaceRule ? <style>{previewFontFaceRule}</style> : null}
      <div className={`relative h-full w-full ${selected ? "ring-2 ring-cs2-accent ring-offset-1 ring-offset-transparent" : ""}`}>
        {transitionVisual.flashOpacity > 0 ? <span className="pointer-events-none absolute inset-0 z-20 bg-white" style={{ opacity: transitionVisual.flashOpacity }} /> : null}
        {transitionVisual.blackOpacity > 0 ? <span className="pointer-events-none absolute inset-0 z-20 bg-black" style={{ opacity: transitionVisual.blackOpacity }} /> : null}
        {isText ? (
          <div
            data-font-load-revision={fontLoadRevision}
            className={`pointer-events-none flex h-full min-h-8 w-full items-center justify-center overflow-hidden leading-tight whitespace-pre-wrap break-words ${textCard?.className || "font-bold text-white"}`}
            style={{
              fontFamily: resolvedFontFamily,
              fontSize: `${(Math.max(1, Number(ov.text?.font_size) || 48) * Math.max(0.1, Number(scale) || 1) / Math.max(1, Number(canvasHeight) || 1080)) * 100}cqh`,
              textAlign,
              textShadow: "0 2px 12px rgba(0,0,0,0.72)",
            }}
          >
            {textContent}
          </div>
        ) : src && isVideo ? (
          <video
            ref={videoRef}
            src={src}
            className={`pointer-events-none h-full w-full ${boxObjectFit} drop-shadow-lg`}
            muted
            playsInline
            loop={isLoopingAnimation}
            preload="auto"
          />
        ) : src ? (
          <img src={src} alt="" draggable={false} className={`pointer-events-none h-full w-full ${boxObjectFit} drop-shadow-lg`} />
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
