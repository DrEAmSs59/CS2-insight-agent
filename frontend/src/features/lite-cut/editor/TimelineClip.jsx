import { memo, useMemo } from "react";
import { useLiteCutTimelineStore } from "../state/timelineStore.js";
import { liteCutClipStreamUrl } from "./clipStreamUrlUtils.js";
import AudioWaveformBars from "./AudioWaveformBars.jsx";
import { timelineSpeedRampSegments } from "./speedRampUiUtils.js";
import { timelineWaveformTiles } from "./timelineWaveformUtils.js";
import { useT } from "../../../i18n/useT.js";

const TRANSITION_TYPES = new Set([
  "cut", "fade", "flash", "dip", "zoom", "wipe_l", "wipe_r",
  "slide_up", "slide_down",
]);

// 工程里可能存着更新的、这个版本还不认识的转场类型，那就原样显示。
const transitionLabel = (type, t) => (TRANSITION_TYPES.has(type) ? t(`liteCut.transition.${type}`) : type);

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
  return `litecut-timeline-clip litecut-timeline-clip--${tone} absolute inset-y-1 overflow-hidden rounded-md border ${selected ? "litecut-timeline-clip--selected ring-1 ring-cs2-accent/80" : ""} ${dragging ? "opacity-35" : ""} ${invalid ? "litecut-timeline-clip--invalid" : ""}`;
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
  start,
  width,
  pixelsPerSecond,
  visibleRange,
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
  const t = useT();
  const selectedTransitionId = useLiteCutTimelineStore((state) => state.selectedTransitionId);
  const source = clip._clip || clip._overlay || {};
  const tone = timelineClipTone(rowType, source);
  const speedSegments = useMemo(
    () => (rowType === "overlay" ? [] : timelineSpeedRampSegments(source)),
    [rowType, source],
  );
  const renderedClipWidth = Math.max(8, width * pixelsPerSecond);
  const keyframePoints = useMemo(() => keyframePointsForClip(source, width), [source, width]);
  const waveformUrl = rowType === "audio" ? streamUrlForTimelineClip(source) : null;
  const waveformTiles = useMemo(
    () => (rowType === "audio" ? timelineWaveformTiles({
      clip: source,
      clipStart: start,
      clipDuration: width,
      pixelsPerSecond,
      visibleRange,
    }) : []),
    [pixelsPerSecond, rowType, source, start, visibleRange, width],
  );

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

  const transitionMarkers = Array.isArray(clip._transitionMarkers) ? clip._transitionMarkers : [];
  const markerIn = transitionMarkers.find((marker) => marker.edge === "in") || null;
  const markerOut = transitionMarkers.find((marker) => marker.edge === "out") || null;
  const markerInDuration = Math.max(0, Number(markerIn?.duration) || 0);
  const markerOutDuration = Math.max(0, Number(markerOut?.duration) || 0);
  const markerInType = String(markerIn?.type || "cut");
  const markerOutType = String(markerOut?.type || "cut");
  const hasTransitionIn = Boolean(markerIn && markerInDuration > 0);
  const hasTransitionOut = Boolean(markerOut && markerOutDuration > 0);
  const transitionInLabel = t("liteCut.clip.transitionIn", { type: transitionLabel(markerInType, t), duration: Number(markerIn?.totalDuration || markerInDuration).toFixed(2) });
  const transitionOutLabel = t("liteCut.clip.transitionOut", { type: transitionLabel(markerOutType, t), duration: Number(markerOut?.totalDuration || markerOutDuration).toFixed(2) });
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
      {waveformUrl ? waveformTiles.map((tile) => (
        <AudioWaveformBars
          key={tile.key}
          sourceUrl={waveformUrl}
          bars={tile.bars}
          startSec={tile.sourceStartSec}
          endSec={tile.sourceEndSec}
          sampleSourceTimes={tile.sourceTimes}
          className="pointer-events-none absolute z-[4] opacity-65"
          style={{ left: tile.leftPx, top: 12, width: tile.widthPx, height: "calc(100% - 12px)" }}
        />
      )) : null}
      {speedSegments.length ? <div data-speed-ramp-overlay className="litecut-speed-ramp pointer-events-none absolute inset-x-0 bottom-0 z-[7] h-[12px] border-t">
        {speedSegments.map((segment) => {
          const segmentPixelWidth = renderedClipWidth * segment.width / 100;
          return <div
            key={`speed-${segment.index}`}
            data-speed-ramp-segment
            className={`litecut-speed-ramp-segment ${segment.index % 2 ? "litecut-speed-ramp-segment--odd" : "litecut-speed-ramp-segment--even"} absolute inset-y-0 flex min-w-0 items-center justify-center overflow-hidden border-r`}
            style={{ left: `${segment.left}%`, width: `${segment.width}%` }}
            title={t("liteCut.clip.speedSegment", {
              speed: segment.speed.toFixed(2),
              from: segment.sourceFrom.toFixed(0),
              to: segment.sourceTo.toFixed(0),
            })}
          >
            {segmentPixelWidth >= 28 ? <span className="truncate px-1 font-mono text-[8px] font-bold leading-none text-white/90 drop-shadow">{segment.speed.toFixed(2)}x</span> : null}
          </div>;
        })}
      </div> : null}
      <div data-oc-trim="left" aria-label={t("liteCut.clip.trimStart")} onPointerDown={(event) => onTrimPointer(event, "left")} className="absolute inset-y-0 left-0 z-20 w-1.5 cursor-ew-resize bg-white/0 hover:bg-white/30" />
      <div data-oc-trim="right" aria-label={t("liteCut.clip.trimEnd")} onPointerDown={(event) => onTrimPointer(event, "right")} className="absolute inset-y-0 right-0 z-20 w-1.5 cursor-ew-resize bg-white/0 hover:bg-white/30" />
      {keyframePoints.map((keyframe, index) => {
        const absoluteTime = start + Number(keyframe.time_sec);
        const active = Math.abs(absoluteTime - playheadSec) <= 0.04;
        return <button
          key={`${keyframe.kind}-${Number(keyframe.time_sec).toFixed(4)}-${index}`}
          type="button"
          data-timeline-keyframe={keyframe.kind}
          title={t("liteCut.clip.keyframeTooltip", {
            kind: t(keyframe.kind === "audio" ? "liteCut.clip.keyframeKindAudio" : "liteCut.clip.keyframeKindTransform"),
            time: formatTime(absoluteTime),
          })}
          onPointerDown={(event) => startKeyframeDrag(event, keyframe, absoluteTime)}
          onDoubleClick={(event) => {
            event.stopPropagation();
            if (!window.confirm(t("liteCut.clip.keyframeDeleteConfirm"))) return;
            const actions = useLiteCutTimelineStore.getState();
            if (rowType === "overlay") actions.removeOverlayKeyframe(clip.id, absoluteTime);
            else if (keyframe.kind === "audio") actions.removeClipAudioKeyframe(clip.id, rowId, absoluteTime);
            else actions.removeClipKeyframe(clip.id, rowId, absoluteTime);
          }}
          className={`absolute z-[15] h-2.5 w-2.5 -translate-x-1/2 rotate-45 border border-black/60 shadow-sm ${active ? "ring-2 ring-white" : "opacity-85 hover:opacity-100"}`}
          style={{ left: `${Math.max(0, Math.min(100, (Number(keyframe.time_sec) / Math.max(0.001, width)) * 100))}%`, top: keyframe.kind === "audio" ? 22 : 8, backgroundColor: keyframe.color }}
        />;
      })}
      {hasTransitionIn ? <div data-transition-marker="in" data-transition-event-id={markerIn.eventId} data-transition-paired={markerIn.paired || undefined} data-transition-annotation data-transition-duration-sec={markerInDuration} title={transitionInLabel} onPointerDown={(event) => { event.preventDefault(); event.stopPropagation(); useLiteCutTimelineStore.getState().selectTransition(markerIn.eventId); }} className={`litecut-transition-marker litecut-transition-marker--in ${compactTransitionLabels ? "litecut-transition-marker--compact" : ""} ${String(selectedTransitionId) === String(markerIn.eventId) ? "ring-1 ring-white" : ""} absolute left-0 z-[21] flex h-[15px] min-w-0 cursor-pointer items-center overflow-hidden border-r border-t px-1 font-mono text-[8px] font-semibold`} style={{ bottom: transitionStripBottom, width: transitionInWidth }}>
        {transitionInWidth >= 36 ? <span className="truncate">{transitionInWidth >= 86 ? transitionInLabel : t("liteCut.clip.transitionInShort", { duration: markerInDuration.toFixed(2) })}</span> : null}
      </div> : null}
      {hasTransitionOut ? <div data-transition-marker="out" data-transition-event-id={markerOut.eventId} data-transition-paired={markerOut.paired || undefined} data-transition-annotation data-transition-duration-sec={markerOutDuration} title={transitionOutLabel} onPointerDown={(event) => { event.preventDefault(); event.stopPropagation(); useLiteCutTimelineStore.getState().selectTransition(markerOut.eventId); }} className={`litecut-transition-marker litecut-transition-marker--out ${compactTransitionLabels ? "litecut-transition-marker--compact" : ""} ${String(selectedTransitionId) === String(markerOut.eventId) ? "ring-1 ring-white" : ""} absolute right-0 z-[21] flex h-[15px] min-w-0 cursor-pointer items-center justify-end overflow-hidden border-l border-t px-1 font-mono text-[8px] font-semibold`} style={{ bottom: transitionStripBottom, width: transitionOutWidth }}>
        {transitionOutWidth >= 36 ? <span className="truncate">{transitionOutWidth >= 86 ? transitionOutLabel : t("liteCut.clip.transitionOutShort", { duration: markerOutDuration.toFixed(2) })}</span> : null}
      </div> : null}
      {compactTransitionLabels ? <div data-transition-label-layout="compact" className="litecut-transition-label-layout pointer-events-none absolute inset-x-0 z-[11] grid h-[15px] min-w-0 grid-cols-2 items-center font-mono text-[8px] font-semibold" style={{ bottom: transitionStripBottom }}>
        <span data-transition-compact-label="in" title={transitionInLabel} className="min-w-0 truncate px-1 text-left">{t("liteCut.clip.transitionInShort", { duration: markerInDuration.toFixed(2) })}</span>
        <span data-transition-compact-label="out" title={transitionOutLabel} className="min-w-0 truncate px-1 text-right">{t("liteCut.clip.transitionOutShort", { duration: markerOutDuration.toFixed(2) })}</span>
      </div> : null}
      <span className="pointer-events-none relative z-10 block truncate px-1.5 pt-1 text-[9px] font-semibold text-current">{clip.label || source.meta?.name || t("liteCut.clip.untitled")}</span>
    </div>
  );
}

export default memo(TimelineClip);
