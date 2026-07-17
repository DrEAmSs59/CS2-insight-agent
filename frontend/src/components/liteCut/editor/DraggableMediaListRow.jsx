import { useEffect, useState } from "react";
import { createPortal } from "react-dom";
import { Plus } from "lucide-react";
import { hideNativeDragImage } from "./timelineInteraction.js";
import { liteCutMediaDragSource } from "../../../stores/liteCut/mediaDragSource.js";
import { useT } from "../../../i18n/useT.js";

/** 列表行素材：左侧封面 + 信息，支持拖拽与 + 加入时间轴 */
export default function DraggableMediaListRow({
  mediaPayload,
  onAddToTimeline,
  active = false,
  children,
  dragPreview,
}) {
  const t = useT();
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

  return (
    <>
      <div
        draggable
        onDragStart={handleDragStart}
        onDragEnd={handleDragEnd}
        className={`group relative overflow-hidden rounded-lg border bg-cs2-bg-card shadow-sm transition-all hover:-translate-y-px hover:border-cs2-accent/35 hover:shadow-md ${
          active ? "border-cs2-accent/50 ring-1 ring-cs2-accent/25" : "border-cs2-border-subtle"
        } ${isDragging ? "opacity-40" : ""}`}
      >
        {children}
        {!isDragging ? (
          <button
            type="button"
            title={t("liteCut.media.addAtPlayhead")}
            onClick={(e) => {
              e.preventDefault();
              e.stopPropagation();
              onAddToTimeline?.();
            }}
            className="absolute bottom-2 right-2 z-[2] inline-flex h-6 w-6 items-center justify-center rounded-md bg-cs2-bg-card/90 text-cs2-accent opacity-0 shadow-md ring-1 ring-cs2-border/60 backdrop-blur transition-opacity group-hover:opacity-100 hover:bg-cs2-accent hover:text-cs2-text-on-accent"
          >
            <Plus className="h-3.5 w-3.5" />
          </button>
        ) : null}
      </div>

      {isDragging && dragPreview && typeof document !== "undefined"
        ? createPortal(
            <div
              className="pointer-events-none fixed z-[9999]"
              style={{ left: dragPos.x - 48, top: dragPos.y - 32 }}
            >
              <div className="h-16 w-28 overflow-hidden rounded-lg border-2 border-cs2-accent shadow-2xl ring-2 ring-cs2-accent/40">
                {dragPreview}
              </div>
            </div>,
            document.body,
          )
        : null}
    </>
  );
}
