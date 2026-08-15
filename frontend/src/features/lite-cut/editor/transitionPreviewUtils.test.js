/** @vitest-environment node */
import { describe, expect, it } from "vitest";
import { boundaryTransitionPreviewVisual, transitionPreviewVisual } from "./transitionPreviewUtils.js";

describe("transitionPreviewVisual", () => {
  it("reveals directional wipes over the frozen outgoing frame", () => {
    expect(transitionPreviewVisual("wipe_l", 0.25)).toMatchObject({
      mainOpacity: 1,
      mainClipPath: "inset(0 0 0 75.00%)",
    });
    expect(transitionPreviewVisual("wipe_r", 0.25).mainClipPath).toBe("inset(0 75.00% 0 0)");
  });

  it("moves slide transitions in from their named edge", () => {
    expect(transitionPreviewVisual("slide_up", 0.4).mainTransform).toBe("translateY(60.00%)");
    expect(transitionPreviewVisual("slide_down", 0.4).mainTransform).toBe("translateY(-60.00%)");
  });

  it("puts flash and dip overlays at the middle of the transition", () => {
    expect(transitionPreviewVisual("flash", 0.25)).toMatchObject({ mainOpacity: 0.25, materialFilter: "brightness(1.4250)", flashOpacity: 0 });
    expect(transitionPreviewVisual("flash", 0.5)).toMatchObject({ mainOpacity: 0.5, materialFilter: "brightness(1.8500)", flashOpacity: 0 });
    expect(transitionPreviewVisual("dip", 0.25)).toMatchObject({ mainOpacity: 0.25, materialFilter: "brightness(0.5250)", blackOpacity: 0 });
    expect(transitionPreviewVisual("dip", 0.5)).toMatchObject({ mainOpacity: 0.5, materialFilter: "brightness(0.0500)", blackOpacity: 0 });
    expect(boundaryTransitionPreviewVisual("flash", 0.5)).toMatchObject({ mainOpacity: 1, flashOpacity: 1, materialFilter: "" });
    expect(boundaryTransitionPreviewVisual("dip", 0.5)).toMatchObject({ mainOpacity: 1, blackOpacity: 1, materialFilter: "" });
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
    expect(boundaryTransitionPreviewVisual("slide_down", 0.25)).toMatchObject({
      mainTransform: "translateY(-75.00%)",
      outgoingTransform: "translateY(25.00%)",
    });
  });

  it("can keep the outgoing endpoint as the stable primary layer", () => {
    expect(boundaryTransitionPreviewVisual("fade", 0, { mainRole: "from" })).toMatchObject({
      mainOpacity: 1,
      companionOpacity: 1,
    });
    expect(boundaryTransitionPreviewVisual("fade", 0.75, { mainRole: "from" }).mainOpacity).toBe(0.25);
    expect(boundaryTransitionPreviewVisual("wipe_l", 0.25, { mainRole: "from" }).mainClipPath).toBe("inset(0 25.00% 0 0)");
    expect(boundaryTransitionPreviewVisual("slide_up", 0.25, { mainRole: "from" })).toMatchObject({
      mainTransform: "translateY(-25.00%)",
      companionTransform: "translateY(75.00%)",
    });
    expect(boundaryTransitionPreviewVisual("flash", 0.25, { mainRole: "from" })).toMatchObject({ mainOpacity: 1, flashOpacity: 0.5 });
    expect(boundaryTransitionPreviewVisual("flash", 0.75, { mainRole: "from" })).toMatchObject({ mainOpacity: 0, flashOpacity: 0.5 });
    expect(boundaryTransitionPreviewVisual("zoom", 0.25, { mainRole: "from" })).toMatchObject({
      mainOpacity: 1,
      mainTransform: "scale(2.0000)",
      mainTransformOrigin: "calc(50% + 0.5px) calc(50% + 0.5px)",
    });
  });

});
