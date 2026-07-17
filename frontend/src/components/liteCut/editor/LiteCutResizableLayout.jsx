import { useCallback, useRef } from "react";
import { useLiteCutPanelStore } from "../../../stores/liteCut/panelStore.js";

function ResizeHandle({ orientation, onPointerDrag }) {
  const active = useRef(false);

  return (
    <div
      role="separator"
      aria-orientation={orientation === "v" ? "vertical" : "horizontal"}
      onPointerDown={(e) => {
        e.preventDefault();
        active.current = true;
        e.currentTarget.setPointerCapture(e.pointerId);
      }}
      onPointerMove={(e) => {
        if (!active.current) return;
        onPointerDrag(e.clientX, e.clientY);
      }}
      onPointerUp={() => {
        active.current = false;
      }}
      onPointerCancel={() => {
        active.current = false;
      }}
      className={`group z-30 shrink-0 touch-none ${
        orientation === "v"
          ? "w-1.5 cursor-col-resize hover:bg-cs2-accent/20"
          : "h-1.5 cursor-row-resize hover:bg-cs2-accent/20"
      }`}
    >
      <div
        className={`mx-auto rounded-full bg-cs2-border group-hover:bg-cs2-accent/60 ${
          orientation === "v" ? "my-3 h-10 w-0.5" : "mx-3 h-0.5 w-10"
        }`}
      />
    </div>
  );
}

/** OpenCut 风格可拖拽分栏布局 */
export default function LiteCutResizableLayout({ mediaBin, preview, properties, timeline }) {
  const panels = useLiteCutPanelStore();
  const rootRef = useRef(null);
  const topRef = useRef(null);

  const onTimelineDrag = useCallback((_, clientY) => {
    const root = rootRef.current;
    if (!root) return;
    const rect = root.getBoundingClientRect();
    const main = Math.max(28, Math.min(82, ((clientY - rect.top) / rect.height) * 100));
    const store = useLiteCutPanelStore.getState();
    store.setPanel("mainContent", main);
    store.setPanel("timeline", 100 - main);
  }, []);

  const onToolsDrag = useCallback((clientX) => {
    const top = topRef.current;
    if (!top) return;
    const rect = top.getBoundingClientRect();
    const tools = Math.max(14, Math.min(40, ((clientX - rect.left) / rect.width) * 100));
    useLiteCutPanelStore.getState().setPanel("tools", tools);
  }, []);

  const onPreviewPropsDrag = useCallback((clientX) => {
    const top = topRef.current;
    if (!top) return;
    const rect = top.getBoundingClientRect();
    const store = useLiteCutPanelStore.getState();
    const toolsW = (store.tools / 100) * rect.width;
    const restW = rect.width - toolsW;
    if (restW <= 0) return;
    const relX = clientX - rect.left - toolsW;
    const previewShare = Math.max(35, Math.min(85, (relX / restW) * 100));
    const restPct = 100 - store.tools;
    store.setPanel("preview", (restPct * previewShare) / 100);
    store.setPanel("properties", restPct - (restPct * previewShare) / 100);
  }, []);

  const restPct = Math.max(1, 100 - panels.tools);
  const previewOfRest = (panels.preview / restPct) * 100;

  return (
    <div ref={rootRef} className="flex min-h-0 flex-1 flex-col overflow-hidden bg-cs2-bg-page">
      <div
        ref={topRef}
        className="flex min-h-0 min-w-0 shrink-0 overflow-hidden"
        style={{ height: `${panels.mainContent}%` }}
      >
        <div className="flex h-full min-h-0 min-w-0 overflow-hidden" style={{ width: `${panels.tools}%` }}>
          {mediaBin}
        </div>
        <ResizeHandle orientation="v" onPointerDrag={(x) => onToolsDrag(x)} />
        <div className="flex h-full min-h-0 min-w-0 flex-1 overflow-hidden">
          <div className="flex h-full min-h-0 min-w-0 overflow-hidden" style={{ width: `${previewOfRest}%` }}>
            {preview}
          </div>
          <ResizeHandle orientation="v" onPointerDrag={(x) => onPreviewPropsDrag(x)} />
          <div className="flex h-full min-h-0 min-w-0 flex-1 overflow-hidden">{properties}</div>
        </div>
      </div>
      <ResizeHandle orientation="h" onPointerDrag={(_, y) => onTimelineDrag(_, y)} />
      <div className="min-h-0 flex-1 overflow-hidden">{timeline}</div>
    </div>
  );
}
