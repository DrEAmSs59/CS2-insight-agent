/** @vitest-environment jsdom */
import { describe, expect, it } from "vitest";
import { isEditableShortcutTarget, resolveLiteCutShortcut } from "./keyboardShortcuts.js";

function keyEvent(key, extra = {}) {
  return { key, ctrlKey: false, metaKey: false, shiftKey: false, altKey: false, ...extra };
}

describe("liteCut keyboard shortcuts", () => {
  it("maps primary save to project save and prevents the browser save dialog", () => {
    expect(resolveLiteCutShortcut(keyEvent("s", { ctrlKey: true }))).toEqual({
      action: "saveProject",
      preventDefault: "always",
    });
    expect(resolveLiteCutShortcut(keyEvent("s", { metaKey: true }))).toEqual({
      action: "saveProject",
      preventDefault: "always",
    });
  });

  it("keeps conditional clipboard commands from swallowing system shortcuts when unhandled", () => {
    expect(resolveLiteCutShortcut(keyEvent("c", { ctrlKey: true }))).toEqual({
      action: "copySelected",
      preventDefault: "handled",
    });
    expect(resolveLiteCutShortcut(keyEvent("v", { ctrlKey: true, shiftKey: true }))).toEqual({
      action: "insertPasteClipboard",
      preventDefault: "handled",
    });
  });

  it("maps selection shortcuts", () => {
    expect(resolveLiteCutShortcut(keyEvent("a", { ctrlKey: true }))).toEqual({
      action: "selectAllTimelineItems",
      preventDefault: "always",
    });
    expect(resolveLiteCutShortcut(keyEvent("A", { metaKey: true }))).toEqual({
      action: "selectAllTimelineItems",
      preventDefault: "always",
    });
    expect(resolveLiteCutShortcut(keyEvent("Escape"))).toEqual({
      action: "clearSelection",
      preventDefault: "handled",
    });
    expect(resolveLiteCutShortcut(keyEvent("ArrowLeft", { ctrlKey: true, shiftKey: true }))).toEqual({
      action: "selectTimelineItemsFromPlayhead",
      direction: "left",
      preventDefault: "always",
    });
    expect(resolveLiteCutShortcut(keyEvent("ArrowRight", { metaKey: true, shiftKey: true }))).toEqual({
      action: "selectTimelineItemsFromPlayhead",
      direction: "right",
      preventDefault: "always",
    });
    expect(resolveLiteCutShortcut(keyEvent("f"))).toEqual({
      action: "focusTimeline",
      preventDefault: "always",
    });
  });

  it("maps editing and navigation shortcuts", () => {
    expect(resolveLiteCutShortcut(keyEvent("S", { shiftKey: true }))).toEqual({
      action: "splitAllAtPlayhead",
      preventDefault: "always",
    });
    expect(resolveLiteCutShortcut(keyEvent(" "))).toEqual({ action: "togglePlay", preventDefault: "always" });
    expect(resolveLiteCutShortcut(keyEvent("ArrowRight", { altKey: true, shiftKey: true }))).toEqual({
      action: "nudgeSelectedFrame",
      direction: 1,
      large: true,
      preventDefault: "always",
    });
    expect(resolveLiteCutShortcut(keyEvent("ArrowLeft", { ctrlKey: true, altKey: true }))).toEqual({
      action: "slipSelectedFrame",
      direction: -1,
      large: false,
      preventDefault: "always",
    });
    expect(resolveLiteCutShortcut(keyEvent("ArrowLeft"))).toEqual({
      action: "seekFrame",
      direction: -1,
      preventDefault: "always",
    });
    expect(resolveLiteCutShortcut(keyEvent("i"))).toEqual({
      action: "markExportRange",
      edge: "start",
      preventDefault: "always",
    });
    expect(resolveLiteCutShortcut(keyEvent("O"))).toEqual({
      action: "markExportRange",
      edge: "end",
      preventDefault: "always",
    });
  });

  it("maps timeline zoom and marker shortcuts", () => {
    expect(resolveLiteCutShortcut(keyEvent("=", { ctrlKey: true }))).toEqual({
      action: "zoomTimeline",
      delta: 0.25,
      preventDefault: "always",
    });
    expect(resolveLiteCutShortcut(keyEvent("+", { metaKey: true }))).toEqual({
      action: "zoomTimeline",
      delta: 0.25,
      preventDefault: "always",
    });
    expect(resolveLiteCutShortcut(keyEvent("-", { ctrlKey: true }))).toEqual({
      action: "zoomTimeline",
      delta: -0.25,
      preventDefault: "always",
    });
    expect(resolveLiteCutShortcut(keyEvent("0", { ctrlKey: true }))).toEqual({
      action: "resetTimelineZoom",
      preventDefault: "always",
    });
    expect(resolveLiteCutShortcut(keyEvent("m"))).toEqual({
      action: "addMarkerAtPlayhead",
      preventDefault: "always",
    });
    expect(resolveLiteCutShortcut(keyEvent("M", { shiftKey: true }))).toEqual({
      action: "deleteMarkerNearPlayhead",
      preventDefault: "always",
    });
    expect(resolveLiteCutShortcut(keyEvent("[", { altKey: true }))).toEqual({
      action: "jumpToPreviousMarker",
      preventDefault: "always",
    });
    expect(resolveLiteCutShortcut(keyEvent("]", { altKey: true }))).toEqual({
      action: "jumpToNextMarker",
      preventDefault: "always",
    });
    expect(resolveLiteCutShortcut(keyEvent("k", { altKey: true }))).toEqual({
      action: "addKeyframeAtPlayhead",
      preventDefault: "handled",
    });
    expect(resolveLiteCutShortcut(keyEvent("K", { altKey: true, shiftKey: true }))).toEqual({
      action: "removeKeyframeAtPlayhead",
      preventDefault: "handled",
    });
    expect(resolveLiteCutShortcut(keyEvent("v", { altKey: true }))).toEqual({
      action: "addAudioKeyframeAtPlayhead",
      preventDefault: "handled",
    });
    expect(resolveLiteCutShortcut(keyEvent("V", { altKey: true, shiftKey: true }))).toEqual({
      action: "removeAudioKeyframeAtPlayhead",
      preventDefault: "handled",
    });
  });

  it("detects editable targets so typing does not trigger timeline commands", () => {
    const input = document.createElement("input");
    const editable = document.createElement("div");
    editable.setAttribute("contenteditable", "true");
    const child = document.createElement("span");
    editable.appendChild(child);

    expect(isEditableShortcutTarget(input)).toBe(true);
    expect(isEditableShortcutTarget(editable)).toBe(true);
    expect(isEditableShortcutTarget(child)).toBe(true);
    expect(isEditableShortcutTarget(document.createElement("button"))).toBe(false);
  });
});
