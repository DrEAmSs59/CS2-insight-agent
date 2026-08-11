/** @vitest-environment node */
import { describe, expect, it } from "vitest";
import { boundaryTransitionPreviewVisual, textTransitionPreviewVisual, transitionPreviewVisual } from "./transitionPreviewUtils.js";

describe("transitionPreviewVisual", () => {
  it("reveals directional wipes over the frozen outgoing frame", () => {
    expect(transitionPreviewVisual("wipe_l", 0.25)).toMatchObject({
      mainOpacity: 1,
      mainClipPath: "inset(0 0 0 75.00%)",
    });
    expect(transitionPreviewVisual("wipe_r", 0.25).mainClipPath).toBe("inset(0 75.00% 0 0)");
  });

  it("moves slide transitions in from their named edge", () => {
    expect(transitionPreviewVisual("slide_left", 0.4).mainTransform).toBe("translateX(60.00%)");
    expect(transitionPreviewVisual("slide_down", 0.4).mainTransform).toBe("translateY(-60.00%)");
  });

  it("puts flash and dip overlays at the middle of the transition", () => {
    expect(transitionPreviewVisual("flash", 0.25)).toMatchObject({ mainOpacity: 0, flashOpacity: 0.5 });
    expect(transitionPreviewVisual("flash", 0.5)).toMatchObject({ mainOpacity: 1, flashOpacity: 1 });
    expect(transitionPreviewVisual("flash", 0.75)).toMatchObject({ mainOpacity: 1, flashOpacity: 0.5 });
    expect(transitionPreviewVisual("dip", 0.25)).toMatchObject({ mainOpacity: 0, blackOpacity: 0.5 });
    expect(transitionPreviewVisual("dip", 0.5)).toMatchObject({ mainOpacity: 1, blackOpacity: 1 });
    expect(transitionPreviewVisual("dip", 0.75)).toMatchObject({ mainOpacity: 1, blackOpacity: 0.5 });
    expect(transitionPreviewVisual("dip", 0)).toMatchObject({ mainOpacity: 0, blackOpacity: 0 });
  });

  it("matches FFmpeg zoomin's outgoing sample and second-half blend", () => {
    expect(boundaryTransitionPreviewVisual("zoom", 0.25)).toMatchObject({
      mainOpacity: 0,
      outgoingTransform: "scale(2.0000)",
    });
    expect(boundaryTransitionPreviewVisual("zoom", 0.5)).toMatchObject({
      mainOpacity: 0,
      outgoingTransform: "scale(10000.0000)",
      outgoingTransformOrigin: "calc(50% + 0.5px) calc(50% + 0.5px)",
    });
    expect(boundaryTransitionPreviewVisual("zoom", 0.75)).toMatchObject({
      mainOpacity: 0.5,
      outgoingTransform: "scale(10000.0000)",
    });
  });

  it("moves both boundary layers for FFmpeg slide transitions", () => {
    expect(boundaryTransitionPreviewVisual("slide_up", 0.25)).toMatchObject({
      mainTransform: "translateY(75.00%)",
      outgoingTransform: "translateY(-25.00%)",
    });
    expect(boundaryTransitionPreviewVisual("slide_right", 0.25)).toMatchObject({
      mainTransform: "translateX(-75.00%)",
      outgoingTransform: "translateX(25.00%)",
    });
  });

  it("uses export-compatible text motion and fades", () => {
    expect(textTransitionPreviewVisual("slide_left", 0.25, "in")).toEqual({ opacity: 1, offsetX: 0.09, offsetY: 0 });
    expect(textTransitionPreviewVisual("slide_left", 0.25, "out")).toEqual({ opacity: 1, offsetX: -0.09, offsetY: 0 });
    expect(textTransitionPreviewVisual("wipe_l", 0.25, "in")).toEqual({ opacity: 0.25, offsetX: 0, offsetY: 0 });
  });
});
