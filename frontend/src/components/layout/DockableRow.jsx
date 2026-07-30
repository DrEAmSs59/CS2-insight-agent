import { useEffect, useMemo, useRef, useState } from "react";
import {
  ArrowLeft,
  ArrowRight,
  GripVertical,
  Maximize2,
  Minimize2,
} from "lucide-react";
import { useT } from "../../i18n/useT.js";

const STORAGE_PREFIX = "cs2-insight:dock-layout:";
export const DOCK_LAYOUT_VERSION = 1;
export const DOCK_COLLAPSED_SIZE = 38;

export function clearDockLayout(storageKey) {
  try {
    globalThis.localStorage?.removeItem(`${STORAGE_PREFIX}${storageKey}`);
  } catch {
    // Layout persistence is best-effort.
  }
}

function positiveSize(value, fallback = 1) {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

export function createDockLayout(panels) {
  return {
    version: DOCK_LAYOUT_VERSION,
    order: panels.map((panel) => panel.id),
    sizes: Object.fromEntries(panels.map((panel) => [panel.id, positiveSize(panel.defaultSize)])),
    collapsed: Object.fromEntries(panels.map((panel) => [panel.id, false])),
  };
}

export function normalizeDockLayout(candidate, panels) {
  const defaults = createDockLayout(panels);
  if (!candidate || candidate.version !== DOCK_LAYOUT_VERSION) return defaults;
  const validIds = new Set(defaults.order);
  const order = Array.isArray(candidate.order)
    ? candidate.order.filter((id, index, list) => validIds.has(id) && list.indexOf(id) === index)
    : [];
  defaults.order.forEach((id) => {
    if (!order.includes(id)) order.push(id);
  });
  return {
    version: DOCK_LAYOUT_VERSION,
    order,
    sizes: Object.fromEntries(defaults.order.map((id) => [
      id,
      positiveSize(candidate.sizes?.[id], defaults.sizes[id]),
    ])),
    collapsed: Object.fromEntries(defaults.order.map((id) => {
      const panel = panels.find((item) => item.id === id);
      return [id, panel?.collapsible !== false && candidate.collapsed?.[id] === true];
    })),
  };
}

export function swapDockPanels(layout, sourceId, targetId) {
  const sourceIndex = layout.order.indexOf(sourceId);
  const targetIndex = layout.order.indexOf(targetId);
  if (sourceIndex < 0 || targetIndex < 0 || sourceIndex === targetIndex) return layout;
  const order = [...layout.order];
  [order[sourceIndex], order[targetIndex]] = [order[targetIndex], order[sourceIndex]];
  return { ...layout, order };
}

export function resizeDockPair(layout, {
  leftId,
  rightId,
  deltaPx,
  leftPx,
  rightPx,
  leftMinPx,
  rightMinPx,
}) {
  const totalPx = Math.max(1, leftPx + rightPx);
  const totalSize = positiveSize(layout.sizes[leftId]) + positiveSize(layout.sizes[rightId]);
  const nextLeftPx = Math.min(
    totalPx - rightMinPx,
    Math.max(leftMinPx, leftPx + deltaPx),
  );
  const leftSize = totalSize * (nextLeftPx / totalPx);
  return {
    ...layout,
    sizes: {
      ...layout.sizes,
      [leftId]: leftSize,
      [rightId]: Math.max(0.01, totalSize - leftSize),
    },
  };
}

function readStoredLayout(storageKey, panels) {
  try {
    const raw = globalThis.localStorage?.getItem(`${STORAGE_PREFIX}${storageKey}`);
    return normalizeDockLayout(raw ? JSON.parse(raw) : null, panels);
  } catch {
    return createDockLayout(panels);
  }
}

export default function DockableRow({
  storageKey,
  panels,
  editMode = false,
  resetSignal = 0,
  className = "",
  ariaLabel,
  collapsedSize = DOCK_COLLAPSED_SIZE,
}) {
  const t = useT();
  const panelSignature = panels.map((panel) => `${panel.id}:${panel.defaultSize}:${panel.minSize}:${panel.collapsible !== false}`).join("|");
  const panelMap = useMemo(() => new Map(panels.map((panel) => [panel.id, panel])), [panels]);
  const [layout, setLayout] = useState(() => readStoredLayout(storageKey, panels));
  const [resizing, setResizing] = useState(false);
  const [dragOverId, setDragOverId] = useState("");
  const layoutRef = useRef(layout);
  const panelRefs = useRef({});
  const dragIdRef = useRef("");
  const resizeCleanupRef = useRef(null);
  const previousResetSignalRef = useRef(resetSignal);

  layoutRef.current = layout;

  useEffect(() => {
    setLayout((current) => normalizeDockLayout(current, panels));
  // Panel content changes on every render; only the layout contract matters.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [panelSignature]);

  useEffect(() => {
    try {
      globalThis.localStorage?.setItem(`${STORAGE_PREFIX}${storageKey}`, JSON.stringify(layout));
    } catch {
      // Layout persistence is best-effort.
    }
  }, [layout, storageKey]);

  useEffect(() => {
    if (previousResetSignalRef.current === resetSignal) return;
    previousResetSignalRef.current = resetSignal;
    setLayout(createDockLayout(panels));
  // resetSignal is the explicit reset boundary.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [resetSignal]);

  useEffect(() => () => resizeCleanupRef.current?.(), []);

  const orderedPanels = layout.order.map((id) => panelMap.get(id)).filter(Boolean);

  const toggleCollapsed = (id) => {
    if (panelMap.get(id)?.collapsible === false) return;
    setLayout((current) => ({
      ...current,
      collapsed: { ...current.collapsed, [id]: !current.collapsed[id] },
    }));
  };

  const movePanel = (id, direction) => {
    setLayout((current) => {
      const index = current.order.indexOf(id);
      const targetIndex = index + direction;
      if (index < 0 || targetIndex < 0 || targetIndex >= current.order.length) return current;
      return swapDockPanels(current, id, current.order[targetIndex]);
    });
  };

  const beginResize = (event, leftPanel, rightPanel) => {
    if (event.button !== 0 || layout.collapsed[leftPanel.id] || layout.collapsed[rightPanel.id]) return;
    event.preventDefault();
    resizeCleanupRef.current?.();
    const leftNode = panelRefs.current[leftPanel.id];
    const rightNode = panelRefs.current[rightPanel.id];
    if (!leftNode || !rightNode) return;
    const leftPx = leftNode.getBoundingClientRect().width;
    const rightPx = rightNode.getBoundingClientRect().width;
    if (leftPx <= 0 || rightPx <= 0) return;
    const startX = event.clientX;
    let latestX = startX;
    let nextLayout = layoutRef.current;
    let animationFrame = 0;

    const applyResize = (clientX) => {
      nextLayout = resizeDockPair(layoutRef.current, {
        leftId: leftPanel.id,
        rightId: rightPanel.id,
        deltaPx: clientX - startX,
        leftPx,
        rightPx,
        leftMinPx: positiveSize(leftPanel.minSize, 120),
        rightMinPx: positiveSize(rightPanel.minSize, 120),
      });
      leftNode.style.flexGrow = String(nextLayout.sizes[leftPanel.id]);
      rightNode.style.flexGrow = String(nextLayout.sizes[rightPanel.id]);
    };

    const onPointerMove = (moveEvent) => {
      latestX = moveEvent.clientX;
      if (animationFrame) return;
      animationFrame = globalThis.requestAnimationFrame(() => {
        animationFrame = 0;
        applyResize(latestX);
      });
    };
    const cleanup = () => {
      globalThis.removeEventListener("pointermove", onPointerMove);
      globalThis.removeEventListener("pointerup", onPointerUp);
      globalThis.removeEventListener("pointercancel", onPointerCancel);
      if (animationFrame) globalThis.cancelAnimationFrame(animationFrame);
      resizeCleanupRef.current = null;
      setResizing(false);
    };
    const finish = (clientX) => {
      applyResize(Number.isFinite(clientX) ? clientX : latestX);
      cleanup();
      setLayout(nextLayout);
    };
    const onPointerUp = (upEvent) => finish(upEvent.clientX);
    const onPointerCancel = () => finish(latestX);

    resizeCleanupRef.current = cleanup;
    setResizing(true);
    globalThis.addEventListener("pointermove", onPointerMove);
    globalThis.addEventListener("pointerup", onPointerUp);
    globalThis.addEventListener("pointercancel", onPointerCancel);
  };

  const resizeWithKeyboard = (event, leftPanel, rightPanel) => {
    if (!["ArrowLeft", "ArrowRight", "Home", "End"].includes(event.key)) return;
    event.preventDefault();
    const leftNode = panelRefs.current[leftPanel.id];
    const rightNode = panelRefs.current[rightPanel.id];
    const leftPx = leftNode?.getBoundingClientRect().width || positiveSize(layout.sizes[leftPanel.id], 1) * 100;
    const rightPx = rightNode?.getBoundingClientRect().width || positiveSize(layout.sizes[rightPanel.id], 1) * 100;
    let deltaPx = event.key === "ArrowLeft" ? -24 : 24;
    if (event.key === "Home") deltaPx = -leftPx;
    if (event.key === "End") deltaPx = rightPx;
    setLayout((current) => resizeDockPair(current, {
      leftId: leftPanel.id,
      rightId: rightPanel.id,
      deltaPx,
      leftPx,
      rightPx,
      leftMinPx: positiveSize(leftPanel.minSize, 120),
      rightMinPx: positiveSize(rightPanel.minSize, 120),
    }));
  };

  return (
    <div
      className={`dockable-row flex min-h-0 min-w-0 ${className}`}
      data-resizing={resizing ? "true" : "false"}
      data-editing={editMode ? "true" : "false"}
      data-testid={`dock-row-${storageKey}`}
      aria-label={ariaLabel}
    >
      {orderedPanels.map((panel, index) => {
        const collapsed = panel.collapsible !== false && layout.collapsed[panel.id];
        const previousPanel = orderedPanels[index - 1];
        const showDivider = index > 0
          && !collapsed
          && !layout.collapsed[previousPanel.id];
        return (
          <div key={panel.id} className="contents">
            {showDivider ? (
              <div
                role="separator"
                aria-orientation="vertical"
                aria-label={t("dock.resizeBetween", { left: previousPanel.label, right: panel.label })}
                tabIndex={0}
                className="dock-divider group relative z-20 w-3 shrink-0 cursor-col-resize touch-none outline-none"
                onPointerDown={(event) => beginResize(event, previousPanel, panel)}
                onKeyDown={(event) => resizeWithKeyboard(event, previousPanel, panel)}
                onDoubleClick={() => setLayout((current) => ({
                  ...current,
                  sizes: {
                    ...current.sizes,
                    [previousPanel.id]: positiveSize(previousPanel.defaultSize),
                    [panel.id]: positiveSize(panel.defaultSize),
                  },
                }))}
              >
                <span className="dock-divider__line" />
              </div>
            ) : null}
            <section
              ref={(node) => { panelRefs.current[panel.id] = node; }}
              data-dock-panel={panel.id}
              data-collapsed={collapsed ? "true" : "false"}
              data-drop-target={dragOverId === panel.id ? "true" : "false"}
              aria-label={panel.label}
              className={`dock-panel group/dock relative min-h-0 min-w-0 overflow-hidden ${panel.className || ""}`}
              style={collapsed
                ? { flex: `0 0 ${collapsedSize}px` }
                : {
                    flexBasis: 0,
                    flexGrow: positiveSize(layout.sizes[panel.id]),
                    flexShrink: 1,
                    minWidth: `${positiveSize(panel.minSize, 120)}px`,
                  }}
              onDragOver={(event) => {
                if (!editMode || !dragIdRef.current || dragIdRef.current === panel.id) return;
                event.preventDefault();
                setDragOverId(panel.id);
              }}
              onDragLeave={() => setDragOverId((current) => (current === panel.id ? "" : current))}
              onDrop={(event) => {
                if (!editMode) return;
                event.preventDefault();
                const sourceId = dragIdRef.current || event.dataTransfer.getData("text/plain");
                setLayout((current) => swapDockPanels(current, sourceId, panel.id));
                setDragOverId("");
                dragIdRef.current = "";
              }}
            >
              {collapsed ? (
                <button
                  type="button"
                  aria-label={t("dock.expand", { panel: panel.label })}
                  title={t("dock.expand", { panel: panel.label })}
                  onClick={() => toggleCollapsed(panel.id)}
                  className="dock-panel__collapsed flex h-full w-full flex-col items-center gap-2 py-2 text-cs2-text-muted hover:text-cs2-accent"
                >
                  <Maximize2 className="h-3.5 w-3.5 shrink-0" />
                  <span className="dock-panel__vertical-label text-[9px] font-bold tracking-[0.12em]">{panel.label}</span>
                </button>
              ) : (
                <>
                  <div className={`dock-panel__chrome ${editMode ? "dock-panel__chrome--editing" : ""}`}>
                    {editMode ? (
                      <>
                        <button
                          type="button"
                          draggable
                          aria-label={t("dock.drag", { panel: panel.label })}
                          title={t("dock.drag", { panel: panel.label })}
                          className="dock-panel__chrome-button cursor-grab active:cursor-grabbing"
                          onDragStart={(event) => {
                            dragIdRef.current = panel.id;
                            event.dataTransfer.effectAllowed = "move";
                            event.dataTransfer.setData("text/plain", panel.id);
                          }}
                          onDragEnd={() => {
                            dragIdRef.current = "";
                            setDragOverId("");
                          }}
                        >
                          <GripVertical className="h-3.5 w-3.5" />
                        </button>
                        <span className="max-w-28 truncate px-1 text-[9px] font-bold text-cs2-text-secondary">{panel.label}</span>
                        <button type="button" disabled={index === 0} aria-label={t("dock.moveLeft", { panel: panel.label })} onClick={() => movePanel(panel.id, -1)} className="dock-panel__chrome-button disabled:opacity-30"><ArrowLeft className="h-3 w-3" /></button>
                        <button type="button" disabled={index === orderedPanels.length - 1} aria-label={t("dock.moveRight", { panel: panel.label })} onClick={() => movePanel(panel.id, 1)} className="dock-panel__chrome-button disabled:opacity-30"><ArrowRight className="h-3 w-3" /></button>
                      </>
                    ) : null}
                    {panel.collapsible !== false ? (
                      <button type="button" aria-label={t("dock.collapse", { panel: panel.label })} title={t("dock.collapse", { panel: panel.label })} onClick={() => toggleCollapsed(panel.id)} className="dock-panel__chrome-button"><Minimize2 className="h-3 w-3" /></button>
                    ) : null}
                  </div>
                  <div className="dock-panel__content h-full min-h-0 min-w-0">{panel.content}</div>
                </>
              )}
            </section>
          </div>
        );
      })}
    </div>
  );
}
