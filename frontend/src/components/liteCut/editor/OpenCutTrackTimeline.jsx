import { Fragment, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import {
  Film,
  Magnet,
  Music2,
  Type,
  PanelLeftClose,
  PanelRightClose,
  Plus,
  Redo2,
  Scissors,
  Trash2,
  Undo2,
  ZoomIn,
  ZoomOut,
} from "lucide-react";

import { useLiteCutEditorStore } from "../../../stores/liteCutEditorStore.js";
import { useLiteCutHistoryStore } from "../../../stores/liteCut/historyStore.js";
import { liteCutMediaDragSource } from "../../../stores/liteCut/mediaDragSource.js";
import { overlayBlocks, trackBlocks } from "../../../stores/liteCut/playbackUtils.js";
import { canPlaceOnTrack, clipTimelineEnd, timelineTotalSec } from "../../../stores/liteCut/timelineUtils.js";
import { useLiteCutTimelineStore } from "../../../stores/liteCut/timelineStore.js";
import { snapPlayheadToBoundaries, timelineClipIntersectsRange, visibleTimelineRange } from "./timelineInteraction.js";
import {
  clampTimelineZoom,
  timelineZoomFromSliderPercent,
  timelineZoomToSliderPercent,
} from "../../../stores/liteCut/timelineZoomUtils.js";
import TimelineClip, { timelineClipClass, timelineClipTone } from "./TimelineClip.jsx";
import TimelineTrackHeader from "./TimelineTrackHeader.jsx";

const TRACK_HEADER_WIDTH = 128;
const RULER_HEIGHT = 34;
const ROW_HEIGHTS = { overlay: 46, video: 58, audio: 42 };
const DRAG_THRESHOLD = 5;

function formatTime(seconds) {
  const total = Math.max(0, Math.floor(Number(seconds) || 0));
  return `${String(Math.floor(total / 60)).padStart(2, "0")}:${String(total % 60).padStart(2, "0")}`;
}

function ToolButton({ title, label, active = false, disabled = false, onClick, children }) {
  return (
    <button
      type="button"
      title={title}
      disabled={disabled}
      onClick={onClick}
      className={`inline-flex h-8 min-w-8 items-center justify-center gap-1 rounded-md border px-2 text-cs2-text-muted transition-colors hover:border-cs2-border-focus hover:bg-cs2-bg-hover hover:text-cs2-text-primary disabled:opacity-35 ${active ? "border-cs2-accent/35 bg-cs2-accent-soft text-cs2-accent" : "border-transparent"}`}
    >
      {children}
      {label ? <span className="whitespace-nowrap text-[9px] font-semibold leading-none">{label}</span> : null}
    </button>
  );
}

function ContextMenuItem({ label, shortcut = "", disabled = false, reason = "", danger = false, onClick }) {
  return (
    <button
      type="button"
      role="menuitem"
      disabled={disabled}
      title={disabled && reason ? reason : label}
      onClick={onClick}
      className={`flex w-full items-center justify-between gap-4 rounded-md px-2.5 py-1.5 text-left text-[11px] disabled:cursor-not-allowed disabled:opacity-35 ${danger ? "text-rose-300 hover:bg-rose-500/10" : "text-cs2-text-secondary hover:bg-white/5 hover:text-cs2-text-primary"}`}
    >
      <span>{label}</span>
      {shortcut ? <kbd className="font-mono text-[9px] text-cs2-text-muted">{shortcut}</kbd> : null}
    </button>
  );
}

export function snapPlacementStart(rawStart, width, body, excludeId, playheadSec, pixelsPerSecond) {
  const candidates = [0, Math.max(0, Number(playheadSec) || 0)];
  for (const track of body?.tracks || []) {
    for (const clip of track.clips || []) {
      if (String(clip.id) === String(excludeId)) continue;
      const start = Number(clip.timeline_start) || 0;
      // The visible end is the speed-adjusted timeline end, rather than the
      // source trim length.  Using the source length here left a false gap
      // after clips with segmented speed changes and made them impossible to
      // snap against.
      candidates.push(start, clipTimelineEnd(clip));
    }
  }
  for (const overlay of body?.overlays || []) {
    if (String(overlay.id) === String(excludeId)) continue;
    const start = Number(overlay.timeline_start) || 0;
    candidates.push(start, start + (Number(overlay.duration) || 0));
  }
  for (const marker of body?.markers || []) {
    const time = Number(marker?.time_sec);
    if (Number.isFinite(time) && time >= 0) candidates.push(time);
  }
  const threshold = Math.max(0.08, Math.min(0.24, 9 / Math.max(1, pixelsPerSecond)));
  let best = { start: rawStart, guide: null, distance: threshold };
  for (const candidate of candidates) {
    for (const edgeStart of [candidate, candidate - width]) {
      const distance = Math.abs(edgeStart - rawStart);
      if (distance <= best.distance && edgeStart >= 0) best = { start: edgeStart, guide: candidate, distance };
    }
  }
  return best;
}

function resolveDraggedMedia(event) {
  const active = liteCutMediaDragSource.get();
  if (active) return active;
  const raw = event.dataTransfer?.getData?.("application/x-litecut-media");
  if (!raw) return null;
  try {
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

export default function OpenCutTrackTimeline({ body, onDropMedia }) {
  const scrollRef = useRef(null);
  const canvasRef = useRef(null);
  const dragRef = useRef(null);
  const zoomAnchorRef = useRef(null);
  const [canvasWidth, setCanvasWidth] = useState(900);
  const [drag, setDrag] = useState(null);
  const [externalDrop, setExternalDrop] = useState(null);
  const [snapGuide, setSnapGuide] = useState(null);
  const [contextMenu, setContextMenu] = useState(null);
  const contextMenuRef = useRef(null);
  const [markerDrag, setMarkerDrag] = useState(null);
  const [shortcutHelpOpen, setShortcutHelpOpen] = useState(false);

  const playheadSec = useLiteCutTimelineStore((state) => state.playheadSec);
  const setPlayhead = useLiteCutTimelineStore((state) => state.seekPlayhead);
  const setPlaying = useLiteCutTimelineStore((state) => state.setPlaying);
  const selectedClipId = useLiteCutTimelineStore((state) => state.selectedClipId);
  const selectedClipIds = useLiteCutTimelineStore((state) => state.selectedClipIds);
  const selectedTrackId = useLiteCutTimelineStore((state) => state.selectedTrackId);
  const selectClip = useLiteCutTimelineStore((state) => state.selectClip);
  const selectOverlay = useLiteCutTimelineStore((state) => state.selectOverlay);
  const selectTrack = useLiteCutTimelineStore((state) => state.selectTrack);
  const toggleClipSelection = useLiteCutTimelineStore((state) => state.toggleClipSelection);
  const clearSelection = useLiteCutTimelineStore((state) => state.clearSelection);
  const moveClipToTrack = useLiteCutTimelineStore((state) => state.moveClipToTrack);
  const moveSelectionBy = useLiteCutTimelineStore((state) => state.moveSelectionBy);
  const moveOverlayToTime = useLiteCutTimelineStore((state) => state.moveOverlayToTime);
  const moveOverlayToTrack = useLiteCutTimelineStore((state) => state.moveOverlayToTrack);
  const trimClipLeft = useLiteCutTimelineStore((state) => state.trimClipLeft);
  const trimClipRight = useLiteCutTimelineStore((state) => state.trimClipRight);
  const resizeOverlay = useLiteCutTimelineStore((state) => state.resizeOverlay);
  const beginClipDrag = useLiteCutTimelineStore((state) => state.beginClipDrag);
  const beginOverlayDrag = useLiteCutTimelineStore((state) => state.beginOverlayDrag);
  const toggleTrackHidden = useLiteCutTimelineStore((state) => state.toggleTrackHidden);
  const toggleTrackLocked = useLiteCutTimelineStore((state) => state.toggleTrackLocked);
  const toggleTrackMuted = useLiteCutTimelineStore((state) => state.toggleTrackMuted);
  const addVideoTrack = useLiteCutTimelineStore((state) => state.addVideoTrack);
  const addAudioTrack = useLiteCutTimelineStore((state) => state.addAudioTrack);
  const addOverlayTrack = useLiteCutTimelineStore((state) => state.addOverlayTrack);
  const selectOverlayTrack = useLiteCutTimelineStore((state) => state.selectOverlayTrack);
  const selectedOverlayTrackId = useLiteCutTimelineStore((state) => state.selectedOverlayTrackId);
  const moveOverlayTrack = useLiteCutTimelineStore((state) => state.moveOverlayTrack);
  const moveTrack = useLiteCutTimelineStore((state) => state.moveTrack);
  const canRemoveTrack = useLiteCutTimelineStore((state) => state.canRemoveTrack);
  const removeTrack = useLiteCutTimelineStore((state) => state.removeTrack);
  const moveTrackTo = useLiteCutTimelineStore((state) => state.moveTrackTo);
  const deleteSelected = useLiteCutTimelineStore((state) => state.deleteSelected);
  const splitAtPlayhead = useLiteCutTimelineStore((state) => state.splitAtPlayhead);
  const deleteTimelineSide = useLiteCutTimelineStore((state) => state.deleteTimelineSide);
  const snapEnabled = useLiteCutTimelineStore((state) => state.snapEnabled);
  const toggleSnap = useLiteCutTimelineStore((state) => state.toggleSnap);
  const timelineZoom = useLiteCutTimelineStore((state) => state.timelineZoom);
  const setTimelineZoom = useLiteCutTimelineStore((state) => state.setTimelineZoom);
  const undo = useLiteCutTimelineStore((state) => state.undo);
  const redo = useLiteCutTimelineStore((state) => state.redo);
  const canUndo = useLiteCutHistoryStore((state) => state.past.length > 0);
  const canRedo = useLiteCutHistoryStore((state) => state.future.length > 0);

  useLayoutEffect(() => {
    const el = scrollRef.current;
    if (!el || typeof ResizeObserver === "undefined") return undefined;
    const observer = new ResizeObserver(([entry]) => setCanvasWidth(Math.max(640, entry.contentRect.width - TRACK_HEADER_WIDTH)));
    observer.observe(el);
    return () => observer.disconnect();
  }, []);

  const totalSec = timelineTotalSec(body, 30);
  const pixelsPerSecond = 44 * clampTimelineZoom(timelineZoom);
  const timelineWidth = Math.max(canvasWidth, Math.ceil(totalSec * pixelsPerSecond) + 64);
  const [visibleRange, setVisibleRange] = useState({ start: 0, end: Number.POSITIVE_INFINITY });

  useLayoutEffect(() => {
    const scroller = scrollRef.current;
    if (!scroller) return undefined;
    let frame = null;
    const update = () => {
      frame = null;
      const next = visibleTimelineRange({
        scrollLeft: scroller.scrollLeft,
        viewportWidth: scroller.clientWidth,
        pixelsPerSecond,
        headerWidth: TRACK_HEADER_WIDTH,
        overscanPx: scroller.clientWidth,
      });
      setVisibleRange((current) => (
        Math.abs(current.start - next.start) < 0.02 && Math.abs(current.end - next.end) < 0.02 ? current : next
      ));
    };
    const schedule = () => {
      if (frame != null) return;
      frame = requestAnimationFrame(update);
    };
    update();
    scroller.addEventListener("scroll", schedule, { passive: true });
    const observer = typeof ResizeObserver !== "undefined" ? new ResizeObserver(schedule) : null;
    observer?.observe(scroller);
    return () => {
      scroller.removeEventListener("scroll", schedule);
      observer?.disconnect();
      if (frame != null) cancelAnimationFrame(frame);
    };
  }, [pixelsPerSecond]);

  const applyTimelineZoom = (nextZoom, clientX = null) => {
    const scroller = scrollRef.current;
    if (scroller) {
      const rect = scroller.getBoundingClientRect();
      const viewportX = clientX != null && Number.isFinite(Number(clientX)) ? Number(clientX) - rect.left : rect.width / 2;
      const anchorTime = Math.max(0, (scroller.scrollLeft + viewportX - TRACK_HEADER_WIDTH) / pixelsPerSecond);
      zoomAnchorRef.current = { anchorTime, viewportX };
    }
    setTimelineZoom(clampTimelineZoom(nextZoom));
  };

  useLayoutEffect(() => {
    const anchor = zoomAnchorRef.current;
    const scroller = scrollRef.current;
    if (!anchor || !scroller) return;
    scroller.scrollLeft = Math.max(0, TRACK_HEADER_WIDTH + anchor.anchorTime * pixelsPerSecond - anchor.viewportX);
    zoomAnchorRef.current = null;
  }, [pixelsPerSecond]);
  const selectedIds = useMemo(() => new Set((selectedClipIds || []).map(String)), [selectedClipIds]);
  const rows = useMemo(() => {
    const overlays = overlayBlocks(body || {}).map((clip) => ({ ...clip, id: String(clip.id) }));
    const overlayTracks = Array.isArray(body?.overlay_tracks) && body.overlay_tracks.length ? body.overlay_tracks : [{ id: "ot1", label: "文字轨1" }];
    const tracks = (body?.tracks || []).filter((track) => track.type === "video" || track.type === "audio");
    return [
      ...overlayTracks.map((track, index) => ({
        id: track.id,
        type: "overlay",
        label: track.label || `文字轨${index + 1}`,
        height: ROW_HEIGHTS.overlay,
        clips: overlays.filter((clip) => String(clip._overlay?.meta?.overlay_track_id || "ot1") === String(track.id)),
        hidden: Boolean(track.hidden),
        locked: Boolean(track.locked),
        editable: !track.locked,
        removable: overlayTracks.length > 1 && !track.locked && !overlays.some((clip) => String(clip._overlay?.meta?.overlay_track_id || "ot1") === String(track.id)),
      })),
      ...tracks.map((track) => ({
        id: track.id,
        type: track.type,
        label: track.name || (track.type === "video" ? `视频轨 · ${track.label || track.id}` : `音频轨(A轨) · ${track.label || track.id}`),
        height: ROW_HEIGHTS[track.type] || ROW_HEIGHTS.video,
        clips: trackBlocks(body, track.id, selectedClipId, selectedTrackId).map((clip) => ({ ...clip, id: String(clip.id) })),
        hidden: Boolean(track.hidden),
        locked: Boolean(track.locked),
        muted: Boolean(track.muted),
        editable: !track.locked,
        removable: canRemoveTrack(track.id),
        track,
      })),
    ];
  }, [body, selectedClipId, selectedTrackId]);
  const rowsById = useMemo(() => new Map(rows.map((row) => [String(row.id), row])), [rows]);
  const playheadSnapPoints = useMemo(() => {
    const points = [0];
    for (const row of rows) {
      for (const clip of row.clips || []) {
        const start = Math.max(0, Number(clip.start) || 0);
        points.push(start, start + Math.max(0, Number(clip.width) || 0));
      }
    }
    for (const marker of body?.markers || []) {
      const time = Number(marker?.time_sec);
      if (Number.isFinite(time) && time >= 0) points.push(time);
    }
    return [...new Set(points.map((point) => point.toFixed(3)))].map(Number).sort((a, b) => a - b);
  }, [body?.markers, rows]);
  const lastOverlayRow = useMemo(() => [...rows].reverse().find((row) => row.type === "overlay") || null, [rows]);
  const lastVideoRow = useMemo(() => [...rows].reverse().find((row) => row.type === "video") || null, [rows]);
  const autoOverlayDropHeight = lastOverlayRow ? 26 : 0;
  const autoVideoDropHeight = lastVideoRow ? 26 : 0;
  const laneHeight = rows.reduce((sum, row) => sum + row.height + 2, 0) + autoOverlayDropHeight + autoVideoDropHeight;
  const ticks = useMemo(() => {
    const step = pixelsPerSecond >= 76 ? 1 : pixelsPerSecond >= 38 ? 2 : pixelsPerSecond >= 18 ? 5 : pixelsPerSecond >= 8 ? 10 : pixelsPerSecond >= 4 ? 20 : 30;
    const rangeStart = Math.max(0, Number(visibleRange.start) || 0);
    const rangeEnd = Math.min(totalSec, Number.isFinite(visibleRange.end) ? visibleRange.end : totalSec);
    const first = Math.max(0, Math.floor(rangeStart / step) * step);
    const out = [];
    for (let time = first; time <= rangeEnd + 0.001; time += step) out.push(time);
    return out;
  }, [pixelsPerSecond, totalSec, visibleRange]);
  const markerItems = useMemo(() => {
    // Dense markers get as many lanes as needed.  The previous three-lane cap
    // put the fourth and subsequent markers back on top of one another.
    const levelLastPx = [];
    return [...(body?.markers || [])]
      .sort((a, b) => (Number(a.time_sec) || 0) - (Number(b.time_sec) || 0))
      .filter((marker) => {
        const time = markerDrag?.id === marker.id ? markerDrag.time : Number(marker.time_sec) || 0;
        return time >= visibleRange.start && time <= visibleRange.end;
      })
      .map((marker) => {
        const time = markerDrag?.id === marker.id ? markerDrag.time : Math.max(0, Number(marker.time_sec) || 0);
        const pixel = time * pixelsPerSecond;
        let level = levelLastPx.findIndex((last) => pixel - last >= 18);
        if (level < 0) level = levelLastPx.length;
        levelLastPx[level] = pixel;
        return { marker, time, level };
      });
  }, [body?.markers, markerDrag, pixelsPerSecond, visibleRange]);
  const rulerHeight = Math.max(RULER_HEIGHT, Math.min(78, RULER_HEIGHT + Math.max(0, ...markerItems.map((item) => item.level)) * 6));

  const keyframeTimes = useMemo(() => {
    const values = [];
    for (const row of rows) {
      for (const clip of row.clips || []) {
        if (!selectedIds.has(String(clip.id)) && String(clip.id) !== String(selectedClipId || "")) continue;
        const source = clip._clip || clip._overlay || {};
        const start = Number(source.timeline_start) || 0;
        for (const keyframe of [...(source.keyframes || []), ...(source.audio_keyframes || [])]) {
          values.push(start + Math.max(0, Number(keyframe?.time_sec) || 0));
        }
      }
    }
    return [...new Set(values.map((value) => value.toFixed(4)))].map(Number).sort((a, b) => a - b);
  }, [rows, selectedClipId, selectedIds]);

  const jumpKeyframe = (direction) => {
    const target = direction < 0
      ? [...keyframeTimes].reverse().find((time) => time < playheadSec - 0.001)
      : keyframeTimes.find((time) => time > playheadSec + 0.001);
    if (target == null) return;
    setPlaying(false);
    setPlayhead(target);
  };

  const timeAt = (clientX, lane) => {
    const rect = lane.getBoundingClientRect();
    const x = Number(clientX);
    const safeX = Number.isFinite(x) ? x : rect.left;
    return Math.max(0, Math.min(totalSec, (safeX - rect.left) / pixelsPerSecond));
  };

  const startScrub = (event) => {
    if (event.button != null && event.button !== 0) return;
    event.preventDefault();
    const lane = canvasRef.current?.querySelector("[data-oc-lane]");
    if (!lane) return;
    const apply = (clientX) => {
      const raw = timeAt(clientX, lane);
      const result = snapEnabled
        ? snapPlayheadToBoundaries(raw, playheadSnapPoints, pixelsPerSecond)
        : { time: raw, snapped: false, point: null };
      setPlayhead(result.time);
      setSnapGuide(result.snapped ? result.point : null);
    };
    apply(event.clientX);
    const move = (next) => apply(next.clientX);
    const end = () => {
      document.removeEventListener("pointermove", move);
      document.removeEventListener("pointerup", end);
      document.removeEventListener("pointercancel", end);
      setSnapGuide(null);
    };
    document.addEventListener("pointermove", move);
    document.addEventListener("pointerup", end);
    document.addEventListener("pointercancel", end);
  };

  const startClipPointer = (event, row, clip) => {
    if ((event.button != null && event.button !== 0) || row.locked) return;
    event.preventDefault();
    event.stopPropagation();
    const lane = event.currentTarget.closest("[data-oc-lane]");
    if (!lane) return;
    const sourceStart = Number(clip.start) || 0;
    const clickOffset = Math.max(0, timeAt(event.clientX, lane) - sourceStart);
    const additiveSelection = Boolean(event.shiftKey || event.ctrlKey || event.metaKey);
    if (!additiveSelection && !selectedIds.has(String(clip.id))) {
      if (row.type === "overlay") selectOverlay(clip.id);
      else selectClip(clip.id, row.id);
    }
    const currentSelectionIds = additiveSelection
      ? [...selectedIds]
      : useLiteCutTimelineStore.getState().selectedClipIds || [];
    const selectionMove = !additiveSelection
      && currentSelectionIds.length > 1
      && currentSelectionIds.map(String).includes(String(clip.id));
    const pending = {
      id: String(clip.id),
      sourceRowId: String(row.id),
      targetRowId: String(row.id),
      type: row.type,
      originX: event.clientX,
      originY: event.clientY,
      width: Number(clip.width) || 0.1,
      label: clip.label || clip._clip?.meta?.name || "片段",
      start: sourceStart,
      clickOffset,
      selectionMove,
      selectionIds: currentSelectionIds.map(String),
      selectionDelta: 0,
      moved: false,
      valid: true,
      createBelow: false,
    };
    dragRef.current = pending;

    const move = (next) => {
      const state = dragRef.current;
      if (!state) return;
      if (!state.moved && Math.hypot(next.clientX - state.originX, next.clientY - state.originY) < DRAG_THRESHOLD) return;
      if (!state.moved) {
        state.moved = true;
        setPlaying(false);
        if (state.selectionMove) beginClipDrag();
        else if (state.type === "overlay") beginOverlayDrag();
        else beginClipDrag();
      }
      if (state.selectionMove) {
        const rawStart = Math.max(0, timeAt(next.clientX, lane) - state.clickOffset);
        const delta = rawStart - sourceStart;
        const valid = Math.abs(delta) > 1e-6 && useLiteCutTimelineStore.getState().canMoveSelectionBy(delta);
        Object.assign(state, {
          targetRowId: state.sourceRowId,
          start: sourceStart + delta,
          selectionDelta: delta,
          valid,
          createBelow: false,
        });
        setSnapGuide(null);
        setDrag({ ...state });
        return;
      }
      const hitElement = document.elementFromPoint(next.clientX, next.clientY);
      const autoTrackZone = hitElement?.closest("[data-auto-track-drop]");
      const autoTrackType = autoTrackZone?.dataset.ocAutoTrackType;
      if (autoTrackZone && state.type === autoTrackType) {
        const targetId = autoTrackZone.dataset.ocAutoAfterTrackId;
        const targetRow = targetId ? rowsById.get(targetId) : null;
        if (!targetRow || targetRow.locked || targetRow.type !== state.type) {
          setDrag({ ...state, valid: false, createBelow: false });
          return;
        }
        const rawStart = Math.max(0, timeAt(next.clientX, autoTrackZone) - state.clickOffset);
        const snapped = snapEnabled
          ? snapPlacementStart(rawStart, state.width, body, state.id, playheadSec, pixelsPerSecond)
          : { start: rawStart, guide: null };
        Object.assign(state, { targetRowId: targetId, start: snapped.start, valid: true, createBelow: true });
        setSnapGuide(snapped.guide);
        setDrag({ ...state });
        return;
      }
      const targetLane = hitElement?.closest("[data-oc-lane]");
      const targetId = targetLane?.dataset.ocTrackId;
      const targetRow = targetId ? rowsById.get(targetId) : null;
      if (!targetRow || targetRow.locked || targetRow.type !== state.type) {
        setDrag({ ...state, valid: false, createBelow: false });
        return;
      }
      const rawStart = Math.max(0, timeAt(next.clientX, targetLane) - state.clickOffset);
      const snapped = snapEnabled
        ? snapPlacementStart(rawStart, state.width, body, state.id, playheadSec, pixelsPerSecond)
        : { start: rawStart, guide: null };
      const valid = state.type === "overlay" || canPlaceOnTrack(targetRow.track?.clips || [], snapped.start, state.width, state.id);
      Object.assign(state, { targetRowId: targetId, start: snapped.start, valid, createBelow: false });
      setSnapGuide(snapped.guide);
      const scroller = scrollRef.current;
      if (scroller) {
        const bounds = scroller.getBoundingClientRect();
        const edge = 36;
        if (next.clientX < bounds.left + edge) scroller.scrollLeft -= 18;
        else if (next.clientX > bounds.right - edge) scroller.scrollLeft += 18;
      }
      setDrag({ ...state });
    };
    const end = () => {
      const state = dragRef.current;
      dragRef.current = null;
      document.removeEventListener("pointermove", move);
      document.removeEventListener("pointerup", end);
      document.removeEventListener("pointercancel", end);
      if (!state) return;
      if (!state.moved) {
        if (event.shiftKey || event.ctrlKey || event.metaKey) toggleClipSelection(state.id, state.sourceRowId);
        else if (state.type === "overlay") selectOverlay(state.id);
        else selectClip(state.id, state.sourceRowId);
      } else if (state.valid) {
        if (state.selectionMove) {
          moveSelectionBy(state.selectionDelta, { recordHistory: false });
        } else if (state.type === "overlay") {
          moveOverlayToTime(state.id, state.start, { snap: false, recordHistory: false });
          const targetTrackId = state.createBelow ? addOverlayTrack() : state.targetRowId;
          moveOverlayToTrack(state.id, targetTrackId);
        }
        else moveClipToTrack(state.id, state.sourceRowId, state.targetRowId, state.start, { snap: false, recordHistory: false, createBelow: state.createBelow });
      }
      setDrag(null);
      setSnapGuide(null);
    };
    document.addEventListener("pointermove", move);
    document.addEventListener("pointerup", end);
    document.addEventListener("pointercancel", end);
  };

  const startTrimPointer = (event, row, clip, edge) => {
    if ((event.button != null && event.button !== 0) || row.locked) return;
    event.preventDefault();
    event.stopPropagation();
    const lane = event.currentTarget.closest("[data-oc-lane]");
    if (!lane) return;
    const pending = {
      id: String(clip.id),
      sourceRowId: String(row.id),
      targetRowId: String(row.id),
      type: row.type,
      trimEdge: edge,
      originX: event.clientX,
      originY: event.clientY,
      start: Number(clip.start) || 0,
      width: Math.max(0.1, Number(clip.width) || 0.1),
      label: clip.label || clip._clip?.meta?.name || "片段",
      moved: false,
      valid: true,
    };
    dragRef.current = pending;

    const move = (next) => {
      const state = dragRef.current;
      if (!state) return;
      if (!state.moved && Math.hypot(next.clientX - state.originX, next.clientY - state.originY) < DRAG_THRESHOLD) return;
      if (!state.moved) {
        state.moved = true;
        setPlaying(false);
        if (state.type === "overlay") beginOverlayDrag();
        else beginClipDrag();
      }
      const point = timeAt(next.clientX, lane);
      const originalEnd = (Number(clip.start) || 0) + (Number(clip.width) || 0.1);
      if (state.trimEdge === "left") {
        const start = Math.max(0, Math.min(originalEnd - 0.1, point));
        Object.assign(state, { start, width: originalEnd - start });
      } else {
        const end = Math.max((Number(clip.start) || 0) + 0.1, point);
        Object.assign(state, { start: Number(clip.start) || 0, width: end - (Number(clip.start) || 0) });
      }
      setDrag({ ...state });
    };
    const end = () => {
      const state = dragRef.current;
      dragRef.current = null;
      document.removeEventListener("pointermove", move);
      document.removeEventListener("pointerup", end);
      document.removeEventListener("pointercancel", end);
      if (state?.moved) {
        if (state.type === "overlay") {
          resizeOverlay(state.id, { start: state.start, duration: state.width }, { recordHistory: false });
        } else if (state.trimEdge === "left") trimClipLeft(state.id, state.sourceRowId, state.start, { recordHistory: false });
        else trimClipRight(state.id, state.sourceRowId, state.start + state.width, { recordHistory: false });
      }
      setDrag(null);
    };
    document.addEventListener("pointermove", move);
    document.addEventListener("pointerup", end);
    document.addEventListener("pointercancel", end);
  };

  const handleExternalDragOver = (event, row) => {
    const media = resolveDraggedMedia(event);
    if (!media) return;
    const isVideoMedia = media.mediaKind !== "asset" || media.kind === "video";
    if (isVideoMedia && row.type === "video" && !row.locked) {
      const bounds = event.currentTarget.getBoundingClientRect();
      const nearBottomEdge = event.clientY >= bounds.bottom - 16;
      if (nearBottomEdge && (row.track?.clips || []).length > 0) {
        event.preventDefault();
        setExternalDrop({
          rowId: String(row.id),
          targetTrackId: String(row.id),
          time: timeAt(event.clientX, event.currentTarget),
          width: Number(media.duration_sec || media.duration || 3),
          placement: { createNewTrack: true, createBelow: true },
          createsTrack: true,
          insertionEdge: "bottom",
        });
        return;
      }
    }
    if (isVideoMedia && row.type === "audio") {
      const lastVideoRow = [...rows].reverse().find((item) => item.type === "video" && !item.locked);
      if (!lastVideoRow) return;
      event.preventDefault();
      const shouldCreateTrack = (lastVideoRow.track?.clips || []).length > 0;
      setExternalDrop({
        rowId: String(row.id),
        targetTrackId: String(lastVideoRow.id),
        time: timeAt(event.clientX, event.currentTarget),
        width: Number(media.duration_sec || media.duration || 3),
        placement: shouldCreateTrack ? { createNewTrack: true, createBelow: true } : {},
        createsTrack: shouldCreateTrack,
        insertionEdge: "top",
      });
      return;
    }
    const compatible = row.type === "overlay"
      ? media.mediaKind === "asset" && media.kind !== "video"
      : row.type === "audio"
        ? media.kind === "audio"
        : media.kind !== "audio";
    if (!compatible || row.locked) return;
    event.preventDefault();
    setExternalDrop({ rowId: String(row.id), targetTrackId: String(row.id), time: timeAt(event.clientX, event.currentTarget), width: Number(media.duration_sec || media.duration || 3), placement: {}, createsTrack: false });
  };

  const handleExternalDrop = (event, row) => {
    const media = resolveDraggedMedia(event);
    setExternalDrop(null);
    if (!media) return;
    event.preventDefault();
    const atTime = timeAt(event.clientX, event.currentTarget);
    const isVideoMedia = media.mediaKind !== "asset" || media.kind === "video";
    if (isVideoMedia && row.type === "video") {
      const bounds = event.currentTarget.getBoundingClientRect();
      const nearBottomEdge = event.clientY >= bounds.bottom - 16;
      if (nearBottomEdge && (row.track?.clips || []).length > 0) {
        onDropMedia?.(media, row.id, atTime, { createNewTrack: true, createBelow: true });
      } else {
        onDropMedia?.(media, row.id, atTime);
      }
    } else if (isVideoMedia && row.type === "audio") {
      const lastVideoRow = [...rows].reverse().find((item) => item.type === "video" && !item.locked);
      if (lastVideoRow) {
        const placement = (lastVideoRow.track?.clips || []).length > 0 ? { createNewTrack: true, createBelow: true } : {};
        onDropMedia?.(media, lastVideoRow.id, atTime, placement);
      }
    } else {
      onDropMedia?.(media, row.id, atTime);
    }
    liteCutMediaDragSource.end();
  };

  const handleAutoVideoTrackDragOver = (event, row) => {
    const media = resolveDraggedMedia(event);
    const isVideoMedia = media && (media.mediaKind !== "asset" || media.kind === "video");
    if (!isVideoMedia || row.locked) return;
    event.preventDefault();
    event.stopPropagation();
    setExternalDrop({
      rowId: `auto-video:${row.id}`,
      targetTrackId: String(row.id),
      time: timeAt(event.clientX, event.currentTarget),
      width: Number(media.duration_sec || media.duration || 3),
      placement: { createNewTrack: true, createBelow: true },
      createsTrack: true,
      insertionEdge: "zone",
    });
  };

  const handleAutoVideoTrackDrop = (event, row) => {
    const media = resolveDraggedMedia(event);
    const isVideoMedia = media && (media.mediaKind !== "asset" || media.kind === "video");
    setExternalDrop(null);
    if (!isVideoMedia || row.locked) return;
    event.preventDefault();
    event.stopPropagation();
    onDropMedia?.(media, row.id, timeAt(event.clientX, event.currentTarget), { createNewTrack: true, createBelow: true });
    liteCutMediaDragSource.end();
  };

  const handleAutoOverlayTrackDragOver = (event, row) => {
    const media = resolveDraggedMedia(event);
    const isOverlayMedia = media?.mediaKind === "asset" && media.kind !== "video" && media.kind !== "audio";
    if (!isOverlayMedia || row.locked) return;
    event.preventDefault();
    event.stopPropagation();
    setExternalDrop({
      rowId: `auto-overlay:${row.id}`,
      targetTrackId: String(row.id),
      time: timeAt(event.clientX, event.currentTarget),
      width: Number(media.duration_sec || media.duration || 3),
      placement: { createNewTrack: true, createBelow: true },
      createsTrack: true,
      insertionEdge: "zone",
    });
  };

  const handleAutoOverlayTrackDrop = (event, row) => {
    const media = resolveDraggedMedia(event);
    const isOverlayMedia = media?.mediaKind === "asset" && media.kind !== "video" && media.kind !== "audio";
    setExternalDrop(null);
    if (!isOverlayMedia || row.locked) return;
    event.preventDefault();
    event.stopPropagation();
    const newTrackId = addOverlayTrack();
    onDropMedia?.(media, newTrackId, timeAt(event.clientX, event.currentTarget));
    liteCutMediaDragSource.end();
  };

  useEffect(() => () => {
    dragRef.current = null;
  }, []);

  useEffect(() => {
    if (!contextMenu) return undefined;
    const close = (event) => {
      if (event.type === "keydown" && event.key !== "Escape") return;
      setContextMenu(null);
    };
    window.addEventListener("pointerdown", close);
    window.addEventListener("keydown", close);
    return () => {
      window.removeEventListener("pointerdown", close);
      window.removeEventListener("keydown", close);
    };
  }, [contextMenu]);

  useLayoutEffect(() => {
    const menu = contextMenuRef.current;
    if (!contextMenu || !menu) return;
    const rect = menu.getBoundingClientRect();
    const gutter = 8;
    const nextX = Math.max(gutter, Math.min(contextMenu.x, window.innerWidth - rect.width - gutter));
    const nextY = Math.max(gutter, Math.min(contextMenu.y, window.innerHeight - rect.height - gutter));
    if (Math.abs(nextX - contextMenu.x) > 0.5 || Math.abs(nextY - contextMenu.y) > 0.5) {
      setContextMenu((current) => current ? { ...current, x: nextX, y: nextY } : current);
    }
  }, [contextMenu]);

  const startMarkerPointer = (event, marker) => {
    if (event.button != null && event.button !== 0) return;
    event.preventDefault();
    event.stopPropagation();
    setPlaying(false);
    const ruler = event.currentTarget.closest("[data-oc-ruler]");
    const rect = ruler?.getBoundingClientRect();
    if (!rect) return;
    const originalTime = Math.max(0, Number(marker.time_sec) || 0);
    const originX = Number(event.clientX) || rect.left + originalTime * pixelsPerSecond;
    let nextTime = originalTime;
    let moved = false;
    const move = (next) => {
      const clientX = Number(next.clientX);
      if (!Number.isFinite(clientX)) return;
      if (!moved && Math.abs(clientX - originX) < DRAG_THRESHOLD) return;
      moved = true;
      const rawTime = Math.max(0, Math.min(totalSec, (clientX - rect.left) / pixelsPerSecond));
      const snapped = snapEnabled
        ? snapPlayheadToBoundaries(rawTime, [...playheadSnapPoints, playheadSec], pixelsPerSecond)
        : { time: rawTime, snapped: false, point: null };
      nextTime = snapped.time;
      setSnapGuide(snapped.snapped ? snapped.point : null);
      setMarkerDrag({ id: marker.id, time: nextTime });
    };
    const end = () => {
      document.removeEventListener("pointermove", move);
      document.removeEventListener("pointerup", end);
      document.removeEventListener("pointercancel", end);
      setMarkerDrag(null);
      setSnapGuide(null);
      if (moved) useLiteCutTimelineStore.getState().updateMarker(marker.id, { time_sec: nextTime });
      setPlayhead(moved ? nextTime : originalTime);
    };
    document.addEventListener("pointermove", move);
    document.addEventListener("pointerup", end);
    document.addEventListener("pointercancel", end);
  };

  const editMarker = (marker) => {
    const label = window.prompt("标记点名称", String(marker.label || ""));
    if (label == null) return;
    const color = window.prompt("标记点颜色（例如 #f59e0b）", String(marker.color || "#f59e0b"));
    if (color == null) return;
    useLiteCutTimelineStore.getState().updateMarker(marker.id, { label, color });
  };

  const runContextAction = (action) => {
    action?.();
    setContextMenu(null);
  };

  return (
    <section className="flex h-full min-h-0 flex-col overflow-hidden border-t border-cs2-border bg-cs2-bg-sidebar">
      <div className="flex shrink-0 items-center gap-1 border-b border-cs2-border bg-cs2-bg-card px-2.5 py-1.5 shadow-sm">
        <ToolButton title="撤销" label="撤销" disabled={!canUndo} onClick={undo}><Undo2 className="h-3.5 w-3.5" /></ToolButton>
        <ToolButton title="重做" label="重做" disabled={!canRedo} onClick={redo}><Redo2 className="h-3.5 w-3.5" /></ToolButton>
        <span className="mx-1 h-5 w-px bg-cs2-border" />
        <ToolButton title="分割所选片段" label="裁切" disabled={!selectedClipId} onClick={splitAtPlayhead}><Scissors className="h-3.5 w-3.5" /></ToolButton>
        <ToolButton title="删除所选片段" label="删除" disabled={!selectedClipId} onClick={deleteSelected}><Trash2 className="h-3.5 w-3.5" /></ToolButton>
        <ToolButton title="删除时间轴左侧全部内容" label="删左侧" onClick={() => deleteTimelineSide("left")}><PanelLeftClose className="h-3.5 w-3.5" /></ToolButton>
        <ToolButton title="删除时间轴右侧全部内容" label="删右侧" onClick={() => deleteTimelineSide("right")}><PanelRightClose className="h-3.5 w-3.5" /></ToolButton>
        <ToolButton title="时间吸附" label="吸附" active={snapEnabled} onClick={toggleSnap}><Magnet className="h-3.5 w-3.5" /></ToolButton>
        <ToolButton title="上一个所选素材关键帧" label="◆‹" disabled={!keyframeTimes.some((time) => time < playheadSec - 0.001)} onClick={() => jumpKeyframe(-1)}><span className="text-[10px]">◆</span></ToolButton>
        <ToolButton title="下一个所选素材关键帧" label="›◆" disabled={!keyframeTimes.some((time) => time > playheadSec + 0.001)} onClick={() => jumpKeyframe(1)}><span className="text-[10px]">◆</span></ToolButton>
        <span className="mx-1 h-5 w-px bg-cs2-border" />
        <ToolButton title="添加视频轨" label="视频轨" onClick={() => addVideoTrack(selectedTrackId)}><span className="flex"><Plus className="h-3.5 w-3.5" /><Film className="h-3 w-3" /></span></ToolButton>
        <ToolButton title="添加文字或图片轨" label="文字轨" onClick={addOverlayTrack}><span className="flex"><Plus className="h-3.5 w-3.5" /><Type className="h-3 w-3" /></span></ToolButton>
        <ToolButton title="添加音频轨(A轨)" label="音频轨(A轨)" onClick={() => addAudioTrack(selectedTrackId)}><span className="flex"><Plus className="h-3.5 w-3.5" /><Music2 className="h-3 w-3" /></span></ToolButton>
        <ToolButton title="查看时间轴快捷键" label="快捷键" onClick={() => setShortcutHelpOpen(true)}><span className="font-mono text-[10px]">⌨</span></ToolButton>
        <div className="ml-auto flex items-center gap-1">
          <ToolButton title="缩小时间轴" onClick={() => applyTimelineZoom(timelineZoom / 1.25)}><ZoomOut className="h-3.5 w-3.5" /></ToolButton>
          <div className="mr-1 flex items-center gap-1.5 rounded-md border border-cs2-border bg-cs2-bg-input px-2 py-1">
          <input
            type="range"
            min="0"
            max="100"
            step="0.25"
            value={timelineZoomToSliderPercent(timelineZoom)}
            onChange={(event) => applyTimelineZoom(timelineZoomFromSliderPercent(event.target.value))}
            className="h-1 w-24 cursor-ew-resize accent-cs2-accent"
            aria-label="时间轴无级缩放"
            title="拖动无级缩放；Ctrl + 滚轮可快速缩放"
          />
          <button type="button" onDoubleClick={() => applyTimelineZoom(1)} className="w-9 text-center font-mono text-[10px] text-cs2-text-muted hover:text-cs2-text-primary" title="双击恢复 100%">{Math.round(timelineZoom * 100)}%</button>
          </div>
          <ToolButton title="放大时间轴" onClick={() => applyTimelineZoom(timelineZoom * 1.25)}><ZoomIn className="h-3.5 w-3.5" /></ToolButton>
        </div>
      </div>

      <div
        ref={scrollRef}
        className="min-h-0 flex-1 overflow-auto"
        data-oc-timeline-scroll
        onWheel={(event) => {
          if (!event.ctrlKey && !event.metaKey) return;
          event.preventDefault();
          applyTimelineZoom(timelineZoom * Math.exp(-event.deltaY * 0.0025), event.clientX);
        }}
      >
        <div ref={canvasRef} className="relative min-h-full" style={{ minWidth: TRACK_HEADER_WIDTH + timelineWidth }}>
          <div className="sticky top-0 z-40 grid border-b border-cs2-border bg-cs2-bg-card shadow-sm" style={{ gridTemplateColumns: `${TRACK_HEADER_WIDTH}px ${timelineWidth}px`, height: rulerHeight }} onPointerDown={startScrub}>
            <div className="sticky left-0 z-50 flex items-center border-r border-cs2-border bg-cs2-bg-card px-3 text-[9px] font-semibold uppercase tracking-wider text-cs2-text-muted">时间轴</div>
            <div className="relative" data-oc-ruler>
              {ticks.map((time) => <span key={time} className="pointer-events-none absolute top-0 bottom-0 -translate-x-px border-l border-cs2-border-focus/60" style={{ left: time * pixelsPerSecond }}>
                <span className="absolute left-1 top-1 font-mono text-[9px] font-semibold text-cs2-text-secondary">{formatTime(time)}</span>
              </span>)}
              {markerItems.map(({ marker, time, level }) => (
                <button
                  key={marker.id}
                  type="button"
                  data-timeline-marker={marker.id}
                  title={`${marker.label || "未命名标记"} · ${formatTime(time)}（拖动调整，双击编辑）`}
                  onPointerDown={(event) => startMarkerPointer(event, marker)}
                  onDoubleClick={(event) => { event.stopPropagation(); editMarker(marker); }}
                  onContextMenu={(event) => {
                    event.preventDefault();
                    event.stopPropagation();
                    if (window.confirm(`删除标记点“${marker.label || formatTime(time)}”？`)) useLiteCutTimelineStore.getState().deleteMarker(marker.id);
                  }}
                  className="absolute z-[35] h-4 w-4 -translate-x-1/2 cursor-ew-resize rounded-sm border border-black/40 shadow-sm ring-1 ring-white/20"
                  style={{ left: time * pixelsPerSecond, top: 14 + level * 6, backgroundColor: marker.color || "#f59e0b", clipPath: "polygon(50% 0, 100% 45%, 50% 100%, 0 45%)" }}
                />
              ))}
              <div className="pointer-events-none absolute inset-y-0 z-20 w-px bg-cs2-accent shadow-[0_0_8px_rgba(255,140,0,0.75)]" style={{ left: playheadSec * pixelsPerSecond }} />
              <div className="pointer-events-none absolute top-1 z-30 h-3 w-3 -translate-x-1/2 rounded-full border border-white/80 bg-cs2-accent shadow" style={{ left: playheadSec * pixelsPerSecond }} />
            </div>
          </div>

          <div className="relative" style={{ minHeight: laneHeight }}>
            {rows.map((row) => {
              const selectedTrack = row.type === "overlay" ? selectedOverlayTrackId === row.id : selectedTrackId === row.id;
              const isExternalTarget = externalDrop?.rowId === row.id;
              const isLastOverlayRow = row.type === "overlay" && String(row.id) === String(lastOverlayRow?.id);
              const isLastVideoRow = row.type === "video" && String(row.id) === String(lastVideoRow?.id);
              const visibleClips = row.clips.filter((clip) => (
                selectedIds.has(String(clip.id))
                || String(drag?.id || "") === String(clip.id)
                || timelineClipIntersectsRange(clip.start, clip.width, visibleRange)
              ));
              return <Fragment key={row.id}><div className="grid border-b border-white/[0.06]" style={{ gridTemplateColumns: `${TRACK_HEADER_WIDTH}px ${timelineWidth}px`, height: row.height + 2 }}>
                <TimelineTrackHeader
                  row={row}
                  width={TRACK_HEADER_WIDTH}
                  selected={selectedTrack}
                  onSelect={() => row.type === "overlay" ? selectOverlayTrack(row.id) : selectTrack(row.id)}
                  onToggleHidden={() => toggleTrackHidden(row.id)}
                  onToggleLocked={() => toggleTrackLocked(row.id)}
                  onToggleMuted={() => toggleTrackMuted(row.id)}
                  onRemove={() => removeTrack(row.id)}
                  onMoveUp={() => row.type === "overlay" ? moveOverlayTrack(row.id, "up") : moveTrack(row.id, "up")}
                  onMoveDown={() => row.type === "overlay" ? moveOverlayTrack(row.id, "down") : moveTrack(row.id, "down")}
                />
                <div
                  data-oc-lane
                  data-oc-track-id={row.id}
                  className={`relative border-l border-cs2-border-subtle ${row.hidden ? "opacity-40" : ""} ${selectedTrack ? "bg-cs2-accent/[0.035]" : "bg-cs2-bg-sidebar"}`}
                  style={{ height: row.height }}
                  onPointerDown={(event) => {
                    if (event.target !== event.currentTarget) return;
                    if (event.shiftKey) {
                      clearSelection();
                      return;
                    }
                    const raw = timeAt(event.clientX, event.currentTarget);
                    const result = snapEnabled
                      ? snapPlayheadToBoundaries(raw, playheadSnapPoints, pixelsPerSecond)
                      : { time: raw };
                    setPlayhead(result.time);
                    if (row.type === "overlay") selectOverlayTrack(row.id);
                    else selectTrack(row.id);
                  }}
                  onDragOver={(event) => handleExternalDragOver(event, row)}
                  onDragLeave={() => setExternalDrop((value) => value?.rowId === row.id ? null : value)}
                  onDrop={(event) => handleExternalDrop(event, row)}
                >
                  {visibleClips.map((clip) => {
                    const isSelectionDragTarget = Boolean(drag?.selectionMove && drag?.selectionIds?.includes(String(clip.id)));
                    const isDragSource = isSelectionDragTarget || (drag?.id === clip.id && drag?.sourceRowId === row.id);
                    const isDragTarget = isSelectionDragTarget || (drag?.id === clip.id && drag?.targetRowId === row.id);
                    const isSelected = selectedIds.has(String(clip.id)) || (selectedClipId === clip.id && selectedTrackId === row.id);
                    const start = isSelectionDragTarget
                      ? (Number(clip.start) || 0) + (Number(drag.selectionDelta) || 0)
                      : isDragTarget ? drag.start : Number(clip.start) || 0;
                    const width = isSelectionDragTarget ? Number(clip.width) || 0.1 : isDragTarget ? drag.width : Number(clip.width) || 0.1;
                    const originalClipIndex = row.clips.findIndex((item) => String(item.id) === String(clip.id));
                    const nextSourceClip = originalClipIndex >= 0 && originalClipIndex < row.clips.length - 1
                      ? row.clips[originalClipIndex + 1]?._clip || row.clips[originalClipIndex + 1]?._overlay || null
                      : null;
                    return <TimelineClip
                      key={clip.id}
                      rowType={row.type}
                      rowId={row.id}
                      clip={clip}
                      nextSourceClip={nextSourceClip}
                      start={start}
                      width={width}
                      pixelsPerSecond={pixelsPerSecond}
                      playheadSec={playheadSec}
                      selected={isSelected}
                      dragSource={isDragSource}
                      dragTarget={isDragTarget}
                      dragValid={drag?.valid ?? true}
                      formatTime={formatTime}
                      onPointerDown={(event) => startClipPointer(event, row, clip)}
                      onTrimPointer={(event, edge) => startTrimPointer(event, row, clip, edge)}
                      onContextMenu={(event) => {
                        event.preventDefault();
                        event.stopPropagation();
                        setPlaying(false);
                        const lane = event.currentTarget.closest("[data-oc-lane]");
                        if (lane) setPlayhead(timeAt(event.clientX, lane));
                        if (!isSelected) {
                          if (row.type === "overlay") selectOverlay(clip.id);
                          else selectClip(clip.id, row.id);
                        }
                        setContextMenu({
                          x: event.clientX,
                          y: event.clientY,
                          rowType: row.type,
                          rowId: row.id,
                          clipId: clip.id,
                        });
                      }}
                    />;
                  })}
                  {drag?.targetRowId === row.id && drag.sourceRowId !== row.id ? <div
                    className={`${timelineClipClass(timelineClipTone(row.type, null), false, false, !drag.valid)} pointer-events-none cursor-grabbing`}
                    style={{ left: drag.start * pixelsPerSecond, width: Math.max(8, drag.width * pixelsPerSecond) }}
                  >
                    <span className="block truncate px-1.5 pt-1 text-[9px] font-semibold text-white">{drag.label}</span>
                  </div> : null}
                  {isExternalTarget && externalDrop.createsTrack ? <div className={`pointer-events-none absolute inset-x-0 z-30 h-0.5 bg-amber-300 shadow-[0_0_8px_rgba(252,211,77,.9)] ${externalDrop.insertionEdge === "bottom" ? "bottom-0" : "top-0"}`}><span className={`absolute left-2 rounded bg-amber-300 px-1.5 py-0.5 text-[9px] font-bold text-black ${externalDrop.insertionEdge === "bottom" ? "-bottom-5" : "-top-5"}`}>自动创建下一条视频轨</span></div> : null}
                  {isExternalTarget && !externalDrop.createsTrack ? <div className="pointer-events-none absolute inset-y-1 border border-dashed border-amber-200 bg-amber-300/20" style={{ left: externalDrop.time * pixelsPerSecond, width: Math.max(8, externalDrop.width * pixelsPerSecond) }} /> : null}
                </div>
              </div>
              {isLastOverlayRow ? <div
                className="grid border-b border-cs2-accent/20 bg-cs2-bg-page"
                style={{ gridTemplateColumns: `${TRACK_HEADER_WIDTH}px ${timelineWidth}px`, height: autoOverlayDropHeight }}
              >
                <div className="sticky left-0 z-20 flex items-center justify-center border-r border-cs2-border bg-cs2-bg-card text-[9px] font-semibold text-cs2-accent/80">
                  + T
                </div>
                <div
                  data-auto-track-drop
                  data-auto-overlay-track-drop
                  data-oc-auto-track-type="overlay"
                  data-oc-auto-after-track-id={row.id}
                  className={`relative flex items-center border-l border-dashed px-3 text-[9px] transition-colors ${externalDrop?.rowId === `auto-overlay:${row.id}` || (drag?.createBelow && drag.type === "overlay") ? "border-cs2-accent bg-cs2-accent-soft text-cs2-accent" : "border-cs2-accent/20 text-white/35"}`}
                  onDragOver={(event) => handleAutoOverlayTrackDragOver(event, row)}
                  onDragLeave={() => setExternalDrop((value) => value?.rowId === `auto-overlay:${row.id}` ? null : value)}
                  onDrop={(event) => handleAutoOverlayTrackDrop(event, row)}
                >
                  <span className="pointer-events-none">拖到这里自动创建下一条文字轨</span>
                  {externalDrop?.rowId === `auto-overlay:${row.id}` ? <div className="pointer-events-none absolute inset-y-1 border border-dashed border-cs2-accent bg-cs2-accent-soft" style={{ left: externalDrop.time * pixelsPerSecond, width: Math.max(8, externalDrop.width * pixelsPerSecond) }} /> : null}
                  {drag?.createBelow && drag.type === "overlay" ? <div className="pointer-events-none absolute inset-y-1 border border-dashed border-cs2-accent bg-cs2-accent-soft" style={{ left: drag.start * pixelsPerSecond, width: Math.max(8, drag.width * pixelsPerSecond) }}><span className="block truncate px-1.5 pt-1 text-[9px] font-semibold text-white">{drag.label}</span></div> : null}
                </div>
              </div> : null}
              {isLastVideoRow ? <div
                className="grid border-b border-amber-300/20 bg-cs2-bg-page"
                style={{ gridTemplateColumns: `${TRACK_HEADER_WIDTH}px ${timelineWidth}px`, height: autoVideoDropHeight }}
              >
                <div className="sticky left-0 z-20 flex items-center justify-center border-r border-cs2-border bg-cs2-bg-card text-[9px] font-semibold text-amber-200/75">
                  + V
                </div>
                <div
                  data-auto-track-drop
                  data-auto-video-track-drop
                  data-oc-auto-track-type="video"
                  data-oc-auto-after-track-id={row.id}
                  className={`relative flex items-center border-l border-dashed px-3 text-[9px] transition-colors ${externalDrop?.rowId === `auto-video:${row.id}` || (drag?.createBelow && drag.type === "video") ? "border-amber-200 bg-amber-300/20 text-amber-100" : "border-amber-300/20 text-white/35"}`}
                  onDragOver={(event) => handleAutoVideoTrackDragOver(event, row)}
                  onDragLeave={() => setExternalDrop((value) => value?.rowId === `auto-video:${row.id}` ? null : value)}
                  onDrop={(event) => handleAutoVideoTrackDrop(event, row)}
                >
                  <span className="pointer-events-none">拖到这里自动创建下一条视频轨</span>
                  {externalDrop?.rowId === `auto-video:${row.id}` ? <div className="pointer-events-none absolute inset-y-1 border border-dashed border-amber-200 bg-amber-300/20" style={{ left: externalDrop.time * pixelsPerSecond, width: Math.max(8, externalDrop.width * pixelsPerSecond) }} /> : null}
                  {drag?.createBelow && drag.type === "video" ? <div className="pointer-events-none absolute inset-y-1 border border-dashed border-cs2-accent bg-cs2-accent-soft" style={{ left: drag.start * pixelsPerSecond, width: Math.max(8, drag.width * pixelsPerSecond) }}><span className="block truncate px-1.5 pt-1 text-[9px] font-semibold text-white">{drag.label}</span></div> : null}
                </div>
              </div> : null}
              </Fragment>;
            })}
            <div className="pointer-events-none absolute left-0 z-30 w-px bg-cs2-accent shadow-[0_0_8px_rgba(255,140,0,0.75)]" style={{ left: TRACK_HEADER_WIDTH + playheadSec * pixelsPerSecond, top: 0, height: laneHeight }} />
            {snapGuide != null ? <div className="pointer-events-none absolute z-40 w-px bg-amber-300 shadow-[0_0_7px_rgba(252,211,77,0.9)]" style={{ left: TRACK_HEADER_WIDTH + snapGuide * pixelsPerSecond, top: 0, height: laneHeight }} /> : null}
          </div>
        </div>
      </div>
      {contextMenu ? (() => {
        const actions = useLiteCutTimelineStore.getState();
        const multiple = selectedIds.size > 1;
        const canDetach = actions.canDetachSelectedAudio();
        const canRipple = actions.canRippleDeleteSelected();
        const canGroup = actions.canGroupSelectedItems();
        const canUngroup = actions.canUngroupSelectedItems();
        const canLink = actions.canLinkSelectedClips();
        const canUnlink = actions.canUnlinkSelectedClips();
        // Linked audio/video clips are intentionally selected as a pair. That
        // is not a bulk-edit request, so keyframes remain available for the
        // specific clip that opened this context menu.
        const keyframeDisabled = multiple && !canUnlink;
        const canTrimStart = actions.canTrimSelectedStartToPlayhead();
        const canTrimEnd = actions.canTrimSelectedEndToPlayhead();
        const canSlipBackward = contextMenu.rowType !== "overlay" && !multiple && actions.canSlipSelectedFrame(-1);
        const canSlipForward = contextMenu.rowType !== "overlay" && !multiple && actions.canSlipSelectedFrame(1);
        const slipUnavailableReason = contextMenu.rowType === "overlay" || multiple
          ? "滑移仅支持单个视频或音频素材"
          : "需要先裁切素材并在这个方向留出源画面；分段变速素材暂不支持滑移";
        const keyframeLabel = contextMenu.rowType === "audio"
          ? "在播放头添加音量关键帧"
          : "在播放头添加画面关键帧（位置/大小等）";
        return createPortal(<div
          ref={contextMenuRef}
          role="menu"
          aria-label="素材操作"
          onPointerDown={(event) => event.stopPropagation()}
          className="fixed z-[100] max-h-[calc(100vh-16px)] w-60 overflow-y-auto rounded-xl border border-cs2-border bg-cs2-bg-elevated p-1.5 shadow-2xl"
          style={{ left: contextMenu.x, top: contextMenu.y }}
        >
          <ContextMenuItem label="在播放头分割" shortcut="S" onClick={() => runContextAction(actions.splitAtPlayhead)} />
          <ContextMenuItem label="在播放头分割全部轨道" shortcut="Shift+S" onClick={() => runContextAction(actions.splitAllAtPlayhead)} />
          <ContextMenuItem label="复制素材" shortcut="Ctrl+D" onClick={() => runContextAction(actions.duplicateSelected)} />
          <ContextMenuItem label="裁切开头到播放头" shortcut="Q" disabled={!canTrimStart} reason="播放头需要位于所选素材内部" onClick={() => runContextAction(actions.trimSelectedStartToPlayhead)} />
          <ContextMenuItem label="裁切结尾到播放头" shortcut="W" disabled={!canTrimEnd} reason="播放头需要位于所选素材内部" onClick={() => runContextAction(actions.trimSelectedEndToPlayhead)} />
          <div className="my-1 border-t border-cs2-border" />
          <ContextMenuItem label="分离视频原声" shortcut="Ctrl+Shift+D" disabled={!canDetach} reason="请选择一个带原声的视频素材" onClick={() => runContextAction(actions.detachSelectedAudio)} />
          <ContextMenuItem label="编组所选素材" disabled={!canGroup} reason="至少选择两个素材" onClick={() => runContextAction(actions.groupSelectedItems)} />
          <ContextMenuItem label="解除素材编组" disabled={!canUngroup} reason="所选素材没有编组" onClick={() => runContextAction(actions.ungroupSelectedItems)} />
          <ContextMenuItem label="链接音视频" disabled={!canLink} reason="请选择可链接的音频和视频素材" onClick={() => runContextAction(actions.linkSelectedClips)} />
          <ContextMenuItem label="取消音视频链接" disabled={!canUnlink} reason="所选素材没有链接关系" onClick={() => runContextAction(actions.unlinkSelectedClips)} />
          <ContextMenuItem label="滑移素材内容向前一帧" shortcut="," disabled={!canSlipBackward} reason={slipUnavailableReason} onClick={() => runContextAction(() => actions.slipSelectedFrame(-1))} />
          <ContextMenuItem label="滑移素材内容向后一帧" shortcut="." disabled={!canSlipForward} reason={slipUnavailableReason} onClick={() => runContextAction(() => actions.slipSelectedFrame(1))} />
          <ContextMenuItem
            label={keyframeLabel}
            shortcut="Alt+K"
            disabled={keyframeDisabled}
            reason="多选素材时不能批量添加关键帧"
            onClick={() => runContextAction(() => {
              const current = useLiteCutTimelineStore.getState();
              if (contextMenu.rowType === "overlay") current.upsertOverlayKeyframe(contextMenu.clipId, current.playheadSec);
              else if (contextMenu.rowType === "audio") current.upsertClipAudioKeyframe(contextMenu.clipId, contextMenu.rowId, current.playheadSec);
              else current.upsertClipKeyframe(contextMenu.clipId, contextMenu.rowId, current.playheadSec);
            })}
          />
          <ContextMenuItem label="在播放头添加标记点" shortcut="M" onClick={() => runContextAction(actions.addMarkerAtPlayhead)} />
          <ContextMenuItem label="选择该素材末尾左侧全部素材" shortcut="Alt+Shift+←" onClick={() => runContextAction(() => actions.selectTimelineItemsRelativeToClip(contextMenu.clipId, "left"))} />
          <ContextMenuItem label="选择该素材末尾右侧全部素材" shortcut="Alt+Shift+→" onClick={() => runContextAction(() => actions.selectTimelineItemsRelativeToClip(contextMenu.clipId, "right"))} />
          <div className="my-1 border-t border-cs2-border" />
          <ContextMenuItem label="波纹删除" shortcut="Ctrl+Delete" disabled={!canRipple} reason="当前选择不能执行波纹删除" danger onClick={() => runContextAction(actions.rippleDeleteSelected)} />
          <ContextMenuItem label="删除素材" shortcut="Delete" danger onClick={() => runContextAction(actions.deleteSelected)} />
        </div>, document.body);
      })() : null}
      {shortcutHelpOpen ? <div role="dialog" aria-modal="true" aria-label="LiteCut 快捷键" className="fixed inset-0 z-[110] flex items-center justify-center bg-black/60 p-4" onPointerDown={() => setShortcutHelpOpen(false)}>
        <div className="max-h-[80vh] w-full max-w-xl overflow-auto rounded-2xl border border-cs2-border bg-cs2-bg-elevated p-4 shadow-2xl" onPointerDown={(event) => event.stopPropagation()}>
          <div className="flex items-center justify-between">
            <div><h3 className="text-sm font-bold text-cs2-text-primary">LiteCut 快捷键</h3><p className="mt-0.5 text-[10px] text-cs2-text-muted">右键素材也可以找到常用编辑操作</p></div>
            <button type="button" onClick={() => setShortcutHelpOpen(false)} className="rounded-md px-2 py-1 text-cs2-text-muted hover:bg-white/5 hover:text-white">关闭</button>
          </div>
          <div className="mt-4 grid grid-cols-2 gap-x-6 gap-y-2 text-[11px]">
            {[
              ["播放/暂停", "空格 / K"], ["分割素材", "S"], ["全轨分割", "Shift+S"], ["删除", "Delete"],
              ["波纹删除", "Ctrl+Delete"], ["裁切开头", "Q"], ["裁切结尾", "W"], ["复制素材", "Ctrl+D"],
              ["分离原声", "Ctrl+Shift+D"], ["添加标记点", "M"], ["删除附近标记", "Shift+M"], ["前/后标记", "Alt+[ / Alt+]"],
              ["添加/删除画面关键帧", "Alt+K / Alt+Shift+K"], ["添加/删除音量关键帧", "Alt+V / Alt+Shift+V"],
              ["滑移素材内容", ", / .（Shift 加速）"], ["选择播放头左/右素材", "Alt+Shift+← / →"],
              ["时间轴缩放", "Ctrl+滚轮"], ["撤销/重做", "Ctrl+Z / Ctrl+Y"],
            ].map(([label, shortcut]) => <Fragment key={label}><span className="text-cs2-text-secondary">{label}</span><kbd className="text-right font-mono text-cs2-accent">{shortcut}</kbd></Fragment>)}
          </div>
          <div className="mt-4 grid gap-2 border-t border-cs2-border pt-3 text-[10px] leading-relaxed text-cs2-text-muted">
            <p><span className="font-semibold text-cs2-text-primary">标记点：</span>用于记录节奏点、定位和吸附；可拖动调整，双击编辑名称和颜色，Alt+[ / Alt+] 在标记间跳转。标记不会出现在导出视频中。</p>
            <p><span className="font-semibold text-cs2-text-primary">关键帧：</span>记录播放头位置的画面变换或音量；至少建立两个关键帧并分别调整参数后，中间过程会自动插值，且会参与预览和导出。</p>
          </div>
        </div>
      </div> : null}
    </section>
  );
}
