export function isEditableShortcutTarget(target) {
  if (!target?.matches) return false;
  return Boolean(
    target.matches("input, textarea, select") ||
      target.matches("[contenteditable='true']") ||
      target.closest?.("[contenteditable='true']"),
  );
}

export function resolveLiteCutShortcut(event) {
  const key = String(event?.key || "");
  const lower = key.toLowerCase();
  const primary = Boolean(event?.ctrlKey || event?.metaKey);
  const shift = Boolean(event?.shiftKey);
  const alt = Boolean(event?.altKey);

  if (primary && lower === "z" && !shift) return { action: "undo", preventDefault: "always" };
  if (primary && (lower === "y" || (shift && lower === "z"))) {
    return { action: "redo", preventDefault: "always" };
  }
  if (primary && lower === "s") return { action: "saveProject", preventDefault: "always" };
  if (primary && lower === "a") return { action: "selectAllTimelineItems", preventDefault: "always" };
  if (primary && shift && key === "ArrowLeft") {
    return { action: "selectTimelineItemsFromPlayhead", direction: "left", preventDefault: "always" };
  }
  if (primary && shift && key === "ArrowRight") {
    return { action: "selectTimelineItemsFromPlayhead", direction: "right", preventDefault: "always" };
  }
  if (primary && lower === "c") return { action: "copySelected", preventDefault: "handled" };
  if (primary && shift && lower === "v") {
    return { action: "insertPasteClipboard", preventDefault: "handled" };
  }
  if (primary && lower === "v") return { action: "pasteClipboard", preventDefault: "handled" };
  if (primary && shift && lower === "d") {
    return { action: "detachSelectedAudio", preventDefault: "always" };
  }
  if (primary && lower === "d") return { action: "duplicateSelected", preventDefault: "always" };
  if (primary && lower === "g") return { action: "compactSelectedTrackGaps", preventDefault: "handled" };
  if (primary && (key === "+" || key === "=")) {
    return { action: "zoomTimeline", delta: 0.25, preventDefault: "always" };
  }
  if (primary && key === "-") return { action: "zoomTimeline", delta: -0.25, preventDefault: "always" };
  if (primary && key === "0") return { action: "resetTimelineZoom", preventDefault: "always" };
  if (primary && key === "Delete") return { action: "rippleDeleteSelected", preventDefault: "always" };
  if (key === "Delete" || key === "Backspace") return { action: "deleteSelected", preventDefault: "always" };
  if (key === "Escape") return { action: "clearSelection", preventDefault: "handled" };

  if (!primary && lower === "s") {
    return { action: shift ? "splitAllAtPlayhead" : "splitAtPlayhead", preventDefault: "always" };
  }
  if (!primary && lower === "q") return { action: "trimSelectedStartToPlayhead", preventDefault: "always" };
  if (!primary && lower === "w") return { action: "trimSelectedEndToPlayhead", preventDefault: "always" };
  if (!primary && lower === "f") return { action: "focusTimeline", preventDefault: "always" };
  if (!primary && lower === "n") return { action: "toggleSnap", preventDefault: "always" };
  if (!primary && !alt && lower === "m") {
    return { action: shift ? "deleteMarkerNearPlayhead" : "addMarkerAtPlayhead", preventDefault: "always" };
  }

  if (alt && key === "[") return { action: "jumpToPreviousMarker", preventDefault: "always" };
  if (alt && key === "]") return { action: "jumpToNextMarker", preventDefault: "always" };
  if (alt && lower === "k") return { action: shift ? "removeKeyframeAtPlayhead" : "addKeyframeAtPlayhead", preventDefault: "handled" };
  if (alt && lower === "v") return { action: shift ? "removeAudioKeyframeAtPlayhead" : "addAudioKeyframeAtPlayhead", preventDefault: "handled" };
  if (key === "[") return { action: "jumpToPreviousEditPoint", preventDefault: "always" };
  if (key === "]") return { action: "jumpToNextEditPoint", preventDefault: "always" };
  if (key === " " || lower === "k") return { action: "togglePlay", preventDefault: "always" };
  if (key === "Home" || key === "Enter") return { action: "setPlayheadStart", preventDefault: "always" };
  if (key === "End") return { action: "setPlayheadEnd", preventDefault: "always" };
  if (!primary && lower === "i") return { action: "markExportRange", edge: "start", preventDefault: "always" };
  if (!primary && lower === "o") return { action: "markExportRange", edge: "end", preventDefault: "always" };
  if (lower === "j") return { action: "seekRelative", deltaSec: -1, preventDefault: "always" };
  if (lower === "l") return { action: "seekRelative", deltaSec: 1, preventDefault: "always" };
  if (primary && alt && key === "ArrowLeft") {
    return { action: "slipSelectedFrame", direction: -1, large: shift, preventDefault: "always" };
  }
  if (primary && alt && key === "ArrowRight") {
    return { action: "slipSelectedFrame", direction: 1, large: shift, preventDefault: "always" };
  }
  if (alt && key === "ArrowLeft") {
    return { action: "nudgeSelectedFrame", direction: -1, large: shift, preventDefault: "always" };
  }
  if (alt && key === "ArrowRight") {
    return { action: "nudgeSelectedFrame", direction: 1, large: shift, preventDefault: "always" };
  }
  if (key === "ArrowLeft") {
    return shift
      ? { action: "seekRelative", deltaSec: -5, preventDefault: "always" }
      : { action: "seekFrame", direction: -1, preventDefault: "always" };
  }
  if (key === "ArrowRight") {
    return shift
      ? { action: "seekRelative", deltaSec: 5, preventDefault: "always" }
      : { action: "seekFrame", direction: 1, preventDefault: "always" };
  }

  return null;
}
