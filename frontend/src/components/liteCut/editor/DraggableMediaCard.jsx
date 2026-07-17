import { useEffect, useState } from "react";
import { createPortal } from "react-dom";
import { Plus } from "lucide-react";
import { hideNativeDragImage } from "./timelineInteraction.js";
import { liteCutMediaDragSource } from "../../../stores/liteCut/mediaDragSource.js";

/**
 * OpenCut DraggableItem：右下角 + 加入时间轴，同时支持拖到时间轴/预览区。
 */
export default function DraggableMediaCard({
  name,
  preview,
  mediaPayload,
  onAddToTimeline,
  aspectClass = "aspect-video",
  className = "",
  draggable = true,
  actionTitle = "加入时间轴（播放头位置）",
}) {
  const [isDragging, setIsDragging] = useState(false);
  const [dragPos, setDragPos] = useState({ x: 0, y: 0 });

  useEffect(() => {
    if (!isDragging) return;
    const onMove = (e) => setDragPos({ x: e.clientX, y: e.clientY });
    document.addEventListener("dragover", onMove);
    return () => document.removeEventListener("dragover", onMove);
  }, [isDragging]);

  const handleDragStart = (e) => {
    hideNativeDragImage(e.dataTransfer);
    liteCutMediaDragSource.begin(mediaPayload);
    e.dataTransfer.setData("application/x-litecut-media", JSON.stringify(mediaPayload));
    e.dataTransfer.effectAllowed = "copy";
    setDragPos({ x: e.clientX, y: e.clientY });
    setIsDragging(true);
  };

  const handleDragEnd = () => {
    setIsDragging(false);
    liteCutMediaDragSource.end();
  };

  const handlePlus = (e) => {
    e.preventDefault();
    e.stopPropagation();
    onAddToTimeline?.();
  };

  return (
    <>
      <div
        draggable={draggable}
        onDragStart={draggable ? handleDragStart : undefined}
        onDragEnd={draggable ? handleDragEnd : undefined}
        className={`group relative overflow-hidden rounded-lg border border-cs2-border bg-cs2-bg-card shadow-sm transition-all hover:-translate-y-px hover:border-cs2-accent/40 hover:shadow-md ${className}`}
      >
        <div className={`relative w-full overflow-hidden ${aspectClass}`}>{preview}</div>
        {!isDragging && onAddToTimeline ? (
          <button
            type="button"
            title={actionTitle}
            onClick={handlePlus}
            className="absolute bottom-1.5 right-1.5 z-[2] inline-flex h-6 w-6 items-center justify-center rounded-md bg-cs2-bg-card/90 text-cs2-accent opacity-0 shadow-md ring-1 ring-cs2-border/60 backdrop-blur transition-opacity group-hover:opacity-100 hover:bg-cs2-accent hover:text-cs2-text-on-accent"
          >
            <Plus className="h-3.5 w-3.5" />
          </button>
        ) : null}
        {name ? (
          <p className="truncate px-2 py-1 text-[10px] text-cs2-text-muted" title={name}>
            {name}
          </p>
        ) : null}
      </div>

      {isDragging && typeof document !== "undefined"
        ? createPortal(
            <div
              className="pointer-events-none fixed z-[9999]"
              style={{ left: dragPos.x - 36, top: dragPos.y - 36 }}
            >
              <div className="h-[72px] w-[72px] overflow-hidden rounded-lg border-2 border-cs2-accent shadow-2xl ring-2 ring-cs2-accent/40">
                {preview}
              </div>
            </div>,
            document.body,
          )
        : null}
    </>
  );
}
