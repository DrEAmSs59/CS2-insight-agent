import { memo, useMemo } from "react";
import { useLiteCutTimelineStore } from "../../../stores/liteCut/timelineStore.js";
import { liteCutClipStreamUrl } from "./clipStreamUrlUtils.js";
import AudioWaveformBars from "./AudioWaveformBars.jsx";
import { timelineSpeedRampSegments } from "./speedRampUiUtils.js";

const TRANSITION_LABELS = {
  cut: "硬切", fade: "淡化", flash: "闪白", dip: "黑场", dip_black: "黑场",
  zoom: "缩放", wipe_l: "左擦", wipe_r: "右擦", slide_up: "上滑",
  slide_down: "下滑", slide_left: "左滑", slide_right: "右滑", blur: "模糊", glitch: "故障", spin: "旋转",
};

export function timelineClipTone(type, source) {
  const kind = String(source?.meta?.kind || "").toLowerCase();
  if (type === "video") return "video";
  if (type === "audio") return "audio";
  if (kind === "audio") return "audio";
  if (source?.type === "text") return "text";
  if (kind === "image" || source?.type === "sticker") return "image";
  return type === "overlay" ? "text" : "video";
}

export function timelineClipClass(tone, selected, dragging, invalid) {
  return `litecut-timeline-clip litecut-timeline-clip--${tone} absolute inset-y-1 overflow-hidden rounded-md border shadow-sm ${selected ? "litecut-timeline-clip--selected ring-1 ring-cs2-accent/80 shadow-[0_0_0_2px_rgba(255,140,0,.12)]" : ""} ${dragging ? "opacity-35" : ""} ${invalid ? "litecut-timeline-clip--invalid" : ""}`;
}

export function waveformBarsForClipWidth(pixelWidth) {
  const raw = Math.max(16, Math.min(512, Math.round((Number(pixelWidth) || 0) / 3)));
  return Math.max(16, Math.min(512, Math.round(raw / 16) * 16));
}

export function streamUrlForTimelineClip(source) {
  return liteCutClipStreamUrl(source);
}

function keyframePointsForClip(source, width) {
  return [
    ...(source?.keyframes || []).map((keyframe) => ({ ...keyframe, kind: "transform", color: "#f59e0b" })),
    ...(source?.audio_keyframes || []).map((keyframe) => ({ ...keyframe, kind: "audio", color: "#22d3ee" })),
  ].filter((keyframe) => Number(keyframe.time_sec) >= 0 && Number(keyframe.time_sec) <= width + 0.001);
}

function TimelineClip({
  rowType,
  rowId,
  clip,
  nextSourceClip = null,
  start,
  width,
  pixelsPerSecond,
  playheadSec,
  selected,
  dragSource,
  dragTarget,
  dragValid,
  onPointerDown,
  onContextMenu,
  onTrimPointer,
  formatTime,
}) {
  const source = clip._clip || clip._overlay || {};
  const tone = timelineClipTone(rowType, source);
  const speedSegments = useMemo(
    () => (rowType === "overlay" ? [] : timelineSpeedRampSegments(source)),
    [rowType, source],
  );
  const renderedClipWidth = Math.max(8, width * pixelsPerSecond);
  const keyframePoints = useMemo(() => keyframePointsForClip(source, width), [source, width]);
  const waveformUrl = rowType === "audio" ? streamUrlForTimelineClip(source) : null;
  const waveformBars = waveformBarsForClipWidth(renderedClipWidth);

  const startKeyframeDrag = (event, keyframe, absoluteTime) => {
    if (event.button !== 0) return;
    event.preventDefault();
    event.stopPropagation();
    const actions = useLiteCutTimelineStore.getState();
    actions.setPlaying(false);
    actions.setPlayhead(absoluteTime);
    if (rowType === "overlay") actions.selectOverlay(clip.id);
    else actions.selectClip(clip.id, rowId);

    const startClientX = event.clientX;
    let currentTime = absoluteTime;
    let moved = false;
    let historyStarted = false;
    const move = (pointerEvent) => {
      const deltaPx = Number(pointerEvent.clientX) - startClientX;
      if (Math.abs(deltaPx) < 2) return;
      const delta = deltaPx / Math.max(1, pixelsPerSecond);
      const target = Math.max(start, Math.min(start + width, absoluteTime + delta));
      if (Math.abs(target - currentTime) < 0.0001) return;
      if (!historyStarted) {
        if (rowType === "overlay") actions.beginOverlayDrag();
        else actions.beginClipDrag();
        historyStarted = true;
      }
      const changed = rowType === "overlay"
        ? actions.moveOverlayKeyframe(clip.id, currentTime, target, { recordHistory: false })
        : keyframe.kind === "audio"
          ? actions.moveClipAudioKeyframe(clip.id, rowId, currentTime, target, { recordHistory: false })
          : actions.moveClipKeyframe(clip.id, rowId, currentTime, target, { recordHistory: false });
      if (changed) {
        moved = true;
        currentTime = target;
        actions.setPlayhead(target);
      }
    };
    const end = () => {
      document.removeEventListener("pointermove", move);
      document.removeEventListener("pointerup", end);
      document.removeEventListener("pointercancel", end);
      actions.setPlayhead(currentTime);
    };
    document.addEventListener("pointermove", move);
    document.addEventListener("pointerup", end);
    document.addEventListener("pointercancel", end);
  };

  const fadeIn = Math.max(0, Number(source.fade_in_sec) || 0);
  const fadeOut = Math.max(0, Number(source.fade_out_sec) || 0);
  const transitionIn = Math.max(0, Number(source.transition_in?.duration_sec) || 0);
  const transitionOut = Math.max(0, Number(source.transition_out?.duration_sec) || 0);
  const transitionInType = String(source.transition_in?.type || "cut");
  const transitionOutType = String(source.transition_out?.type || "cut");
  const isOverlayMaterial = rowType === "overlay";
  const storedTransitionIn = transitionIn > 0 && transitionInType !== "cut";
  const storedTransitionOut = transitionOut > 0 && transitionOutType !== "cut";
  const markerInDuration = storedTransitionIn ? transitionIn : isOverlayMaterial ? fadeIn : 0;
  const markerOutDuration = storedTransitionOut ? transitionOut : isOverlayMaterial ? fadeOut : 0;
  const markerInType = storedTransitionIn ? transitionInType : String(source.text?.anim_in || "fade");
  const markerOutType = storedTransitionOut ? transitionOutType : String(source.text?.anim_out || "fade");
  const hasTransitionIn = markerInDuration > 0 && markerInType !== "cut";
  const nextStartsAtBoundary = nextSourceClip && Math.abs((Number(nextSourceClip.timeline_start) || 0) - (start + width)) <= 0.05;
  const nextOwnsBoundary = !isOverlayMaterial
    && nextStartsAtBoundary
    && Number(nextSourceClip?.transition_in?.duration_sec) > 0
    && String(nextSourceClip?.transition_in?.type || "cut") !== "cut";
  const hasTransitionOut = markerOutDuration > 0 && markerOutType !== "cut" && !nextOwnsBoundary;
  const transitionInLabel = `入 · ${TRANSITION_LABELS[markerInType] || markerInType} · ${markerInDuration.toFixed(2)}s`;
  const transitionOutLabel = `出 · ${TRANSITION_LABELS[markerOutType] || markerOutType} · ${markerOutDuration.toFixed(2)}s`;
  const transitionStripBottom = speedSegments.length ? 12 : 0;
  const transitionInWidth = Math.min(renderedClipWidth, Math.max(3, Math.min(width, markerInDuration) * pixelsPerSecond));
  const transitionOutWidth = Math.min(renderedClipWidth, Math.max(3, Math.min(width, markerOutDuration) * pixelsPerSecond));
  // Two full captions need roughly 112 px each. On a shorter clip keep the
  // duration strips at their true widths, but place compact in/out captions in
  // a separate two-column row so their overflow can never cross.
  const compactTransitionLabels = hasTransitionIn && hasTransitionOut && renderedClipWidth < 224;

  return (
    <div
      role="button"
      tabIndex={0}
      data-oc-clip-id={clip.id}
      data-oc-clip-tone={tone}
      onPointerDown={onPointerDown}
      onContextMenu={onContextMenu}
      className={`${timelineClipClass(tone, selected, dragSource && !dragTarget, dragTarget && !dragValid)} cursor-grab active:cursor-grabbing`}
      style={{ left: start * pixelsPerSecond, width: renderedClipWidth }}
    >
      <div className={`absolute inset-0 opacity-70 ${rowType === "video" ? "bg-[repeating-linear-gradient(90deg,rgba(255,255,255,.13)_0,rgba(255,255,255,.13)_1px,transparent_1px,transparent_36px)]" : ""}`} />
      {waveformUrl ? (
        <AudioWaveformBars
          sourceUrl={waveformUrl}
          bars={waveformBars}
          startSec={Math.max(0, Number(source.trim_in) || 0)}
          endSec={Number(source.trim_out) > Number(source.trim_in) ? Number(source.trim_out) : null}
          className="pointer-events-none absolute inset-x-0 bottom-0 top-3 z-[4] opacity-65"
        />
      ) : null}
      {speedSegments.length ? <div data-speed-ramp-overlay className="litecut-speed-ramp pointer-events-none absolute inset-x-0 bottom-0 z-[7] h-[12px] border-t">
        {speedSegments.map((segment) => {
          const segmentPixelWidth = renderedClipWidth * segment.width / 100;
          return <div
            key={`speed-${segment.index}`}
            data-speed-ramp-segment
            className={`litecut-speed-ramp-segment ${segment.index % 2 ? "litecut-speed-ramp-segment--odd" : "litecut-speed-ramp-segment--even"} absolute inset-y-0 flex min-w-0 items-center justify-center overflow-hidden border-r`}
            style={{ left: `${segment.left}%`, width: `${segment.width}%` }}
            title={`${segment.speed.toFixed(2)}x · 素材 ${segment.sourceFrom.toFixed(0)}%–${segment.sourceTo.toFixed(0)}%`}
          >
            {segmentPixelWidth >= 28 ? <span className="truncate px-1 font-mono text-[8px] font-bold leading-none text-white/90 drop-shadow">{segment.speed.toFixed(2)}x</span> : null}
          </div>;
        })}
      </div> : null}
      <div data-oc-trim="left" aria-label="裁切片段开头" onPointerDown={(event) => onTrimPointer(event, "left")} className="absolute inset-y-0 left-0 z-20 w-1.5 cursor-ew-resize bg-white/0 hover:bg-white/30" />
      <div data-oc-trim="right" aria-label="裁切片段结尾" onPointerDown={(event) => onTrimPointer(event, "right")} className="absolute inset-y-0 right-0 z-20 w-1.5 cursor-ew-resize bg-white/0 hover:bg-white/30" />
      {keyframePoints.map((keyframe, index) => {
        const absoluteTime = start + Number(keyframe.time_sec);
        const active = Math.abs(absoluteTime - playheadSec) <= 0.04;
        return <button
          key={`${keyframe.kind}-${Number(keyframe.time_sec).toFixed(4)}-${index}`}
          type="button"
          data-timeline-keyframe={keyframe.kind}
          title={`${keyframe.kind === "audio" ? "音量" : "画面"}关键帧 · ${formatTime(absoluteTime)}（拖动改时间，双击删除）`}
          onPointerDown={(event) => startKeyframeDrag(event, keyframe, absoluteTime)}
          onDoubleClick={(event) => {
            event.stopPropagation();
            if (!window.confirm("删除这个关键帧？")) return;
            const actions = useLiteCutTimelineStore.getState();
            if (rowType === "overlay") actions.removeOverlayKeyframe(clip.id, absoluteTime);
            else if (keyframe.kind === "audio") actions.removeClipAudioKeyframe(clip.id, rowId, absoluteTime);
            else actions.removeClipKeyframe(clip.id, rowId, absoluteTime);
          }}
          className={`absolute z-[15] h-2.5 w-2.5 -translate-x-1/2 rotate-45 border border-black/60 shadow-sm ${active ? "ring-2 ring-white" : "opacity-85 hover:opacity-100"}`}
          style={{ left: `${Math.max(0, Math.min(100, (Number(keyframe.time_sec) / Math.max(0.001, width)) * 100))}%`, top: keyframe.kind === "audio" ? 22 : 8, backgroundColor: keyframe.color }}
        />;
      })}
      {hasTransitionIn ? <div data-transition-marker="in" data-transition-annotation data-transition-duration-sec={markerInDuration} title={transitionInLabel} className={`litecut-transition-marker litecut-transition-marker--in ${compactTransitionLabels ? "litecut-transition-marker--compact" : ""} pointer-events-none absolute left-0 z-[9] flex h-[15px] min-w-0 items-center overflow-hidden border-r border-t px-1 font-mono text-[8px] font-semibold`} style={{ bottom: transitionStripBottom, width: transitionInWidth }}>
        {transitionInWidth >= 36 ? <span className="truncate">{transitionInWidth >= 86 ? transitionInLabel : `入 ${markerInDuration.toFixed(2)}s`}</span> : null}
      </div> : null}
      {hasTransitionOut ? <div data-transition-marker="out" data-transition-annotation data-transition-duration-sec={markerOutDuration} title={transitionOutLabel} className={`litecut-transition-marker litecut-transition-marker--out ${compactTransitionLabels ? "litecut-transition-marker--compact" : ""} pointer-events-none absolute right-0 z-[9] flex h-[15px] min-w-0 items-center justify-end overflow-hidden border-l border-t px-1 font-mono text-[8px] font-semibold`} style={{ bottom: transitionStripBottom, width: transitionOutWidth }}>
        {transitionOutWidth >= 36 ? <span className="truncate">{transitionOutWidth >= 86 ? transitionOutLabel : `出 ${markerOutDuration.toFixed(2)}s`}</span> : null}
      </div> : null}
      {compactTransitionLabels ? <div data-transition-label-layout="compact" className="litecut-transition-label-layout pointer-events-none absolute inset-x-0 z-[11] grid h-[15px] min-w-0 grid-cols-2 items-center font-mono text-[8px] font-semibold" style={{ bottom: transitionStripBottom }}>
        <span data-transition-compact-label="in" title={transitionInLabel} className="min-w-0 truncate px-1 text-left">入 {markerInDuration.toFixed(2)}s</span>
        <span data-transition-compact-label="out" title={transitionOutLabel} className="min-w-0 truncate px-1 text-right">出 {markerOutDuration.toFixed(2)}s</span>
      </div> : null}
      <span className="pointer-events-none relative z-10 block truncate px-1.5 pt-1 text-[9px] font-semibold text-white drop-shadow">{clip.label || source.meta?.name || "片段"}</span>
    </div>
  );
}

export default memo(TimelineClip);
