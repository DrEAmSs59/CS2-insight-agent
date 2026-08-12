import { describe, expect, it } from "vitest";
import {
  normalizeSceneTransform,
  normalizeSceneCrop,
  sceneKeyframeNearPlayhead,
  sceneMaterialLayout,
  sceneResolvedContentFit,
  sceneTransformAt,
  sceneTransformPixels,
  sceneTransformStyle,
} from "./sceneTransform.js";
import transformCases from "../../../../../data/lite_cut_scene_transform_cases.json";

describe("canonical scene transform", () => {
  const node = {
    timeline_start: 10,
    duration: 4,
    transform: { x: 0.1, y: 0.2, scale: 1, rotation: 0, width: 0.3, height: 0.2, opacity: 1 },
    keyframes: [
      { time_sec: 0, transform: { x: 0.1, y: 0.2, scale: 1, rotation: 0, width: 0.3, height: 0.2, opacity: 1 } },
      { time_sec: 4, transform: { x: 0.9, y: 0.6, scale: 2, rotation: 90, width: 0.5, height: 0.4, opacity: 0.4 } },
    ],
  };

  it("uses the same interpolation for every visual node", () => {
    const transform = sceneTransformAt(node, 12);
    expect(transform).toMatchObject({ x: 0.5, y: 0.4, width: 0.4, scale: 1.5, rotation: 45, opacity: 0.7 });
    expect(transform.height).toBeCloseTo(0.3);
    expect(sceneKeyframeNearPlayhead(node, 14)?.time_sec).toBe(4);
  });

  it("keeps high precision until output-pixel projection", () => {
    const transform = normalizeSceneTransform({ x: 1 / 3, y: 2 / 3, width: 0.25, height: 0.5, scale: 1.25 });
    expect(sceneTransformPixels(transform, 1920, 1080)).toMatchObject({ x: 640, y: 720, width: 480, height: 540, renderedWidth: 600, renderedHeight: 675 });
  });

  it("uses center anchor and mirror-scale-rotate order in CSS", () => {
    const style = sceneTransformStyle({ x: 0.5, y: 0.5, width: 1, height: 1, scale: 2, rotation: 30, opacity: 0.5 }, { flipHorizontal: true });
    expect(style).toMatchObject({ left: "50%", top: "50%", width: "100%", height: "100%", opacity: 0.5 });
    expect(style.transform).toBe("translate(-50%, -50%) rotate(30deg) scale(-2, 2)");
  });

  it("uses executable fill semantics for animated cover boxes", () => {
    const animated = {
      duration: 1,
      keyframes: [
        { time_sec: 0, transform: { ...node.keyframes[0].transform, width: 0.4, height: 0.4 } },
        { time_sec: 1, transform: { ...node.keyframes[1].transform, width: 0.8, height: 0.6 } },
      ],
    };
    expect(sceneResolvedContentFit(animated, "cover")).toBe("fill");
    expect(sceneResolvedContentFit(animated, "contain")).toBe("contain");
  });

  it("projects crop before contain, cover and fill", () => {
    const input = {
      transform: { x: 0.5, y: 0.5, width: 0.5, height: 0.5, scale: 1 },
      crop: { x: 0.25, y: 0, width: 0.5, height: 1 },
      canvasWidth: 1920,
      canvasHeight: 1080,
      sourceWidth: 1920,
      sourceHeight: 1080,
    };
    const contain = sceneMaterialLayout({ ...input, contentFit: "contain" });
    const cover = sceneMaterialLayout({ ...input, contentFit: "cover" });
    const fill = sceneMaterialLayout({ ...input, contentFit: "fill" });
    expect(contain.viewportStyle).toMatchObject({ width: "50%", height: "100%" });
    expect(cover.viewportStyle).toMatchObject({ width: "100%", height: "200%" });
    expect(fill.viewportStyle).toMatchObject({ width: "100%", height: "100%" });
    expect(contain.mediaStyle).toMatchObject({ left: "-50%", width: "200%", height: "100%" });
  });

  it("uses the shared crop contract for zero-size and out-of-bounds crops", () => {
    expect(normalizeSceneCrop({ x: 1, y: -1, width: 0, height: 0 })).toEqual({
      x: 0.95,
      y: 0,
      width: 0.05,
      height: 0.05,
    });
  });
});

describe("cross-runtime transform fixtures", () => {
  it.each(transformCases.cases)("projects $id to the same output pixels", ({ canvas, transform, pixels }) => {
    const actual = sceneTransformPixels(transform, canvas[0], canvas[1]);
    expect(actual.x).toBeCloseTo(pixels.x, 9);
    expect(actual.y).toBeCloseTo(pixels.y, 9);
    expect(actual.width).toBeCloseTo(pixels.width, 9);
    expect(actual.height).toBeCloseTo(pixels.height, 9);
    expect(actual.renderedWidth).toBeCloseTo(pixels.rendered_width, 9);
    expect(actual.renderedHeight).toBeCloseTo(pixels.rendered_height, 9);
  });
});
