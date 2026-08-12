import effectContract from "../../../../../data/lite_cut_effect_contract.json";
import { normalizeVisualCrop } from "../domain/visualMaterial.js";
import { LITE_CUT_OUTPUT_DEFAULTS } from "./projectContract.js";

const sceneContract = effectContract.scene_transform;
export const SCENE_TRANSFORM_DEFAULTS = Object.freeze({ ...sceneContract.defaults.overlay });
export const VIDEO_SCENE_TRANSFORM_DEFAULTS = Object.freeze({ ...sceneContract.defaults.video });
const limits = sceneContract.limits;
const interpolatedFields = sceneContract.interpolated_fields;
export const SCENE_TRANSFORM_LIMITS = Object.freeze({ ...limits });

function finite(value, fallback) {
  const number = Number(value);
  return Number.isFinite(number) ? number : fallback;
}

function clamp(value, minimum, maximum) {
  return Math.max(minimum, Math.min(maximum, value));
}

export function normalizeSceneTransform(transform, defaults = SCENE_TRANSFORM_DEFAULTS) {
  const source = transform && typeof transform === "object" ? transform : {};
  return {
    x: clamp(finite(source.x, defaults.x), limits.position_min, limits.position_max),
    y: clamp(finite(source.y, defaults.y), limits.position_min, limits.position_max),
    width: clamp(finite(source.width, defaults.width), limits.size_min, limits.size_max),
    height: clamp(finite(source.height, defaults.height), limits.size_min, limits.size_max),
    scale: clamp(finite(source.scale, defaults.scale), limits.scale_min, limits.scale_max),
    rotation: clamp(finite(source.rotation, defaults.rotation), limits.rotation_min, limits.rotation_max),
    opacity: clamp(finite(source.opacity, defaults.opacity), limits.opacity_min, limits.opacity_max),
  };
}

export function normalizeSceneKeyframes(node, defaults = SCENE_TRANSFORM_DEFAULTS) {
  const duration = Math.max(0, finite(node?.duration, 0));
  return (Array.isArray(node?.keyframes) ? node.keyframes : [])
    .map((keyframe) => ({
      time_sec: clamp(finite(keyframe?.time_sec, 0), 0, duration),
      transform: normalizeSceneTransform(keyframe?.transform, defaults),
    }))
    .sort((a, b) => a.time_sec - b.time_sec);
}

export function sceneTransformAt(node, playheadSec, defaults = SCENE_TRANSFORM_DEFAULTS) {
  const base = normalizeSceneTransform(node?.transform, defaults);
  const duration = Math.max(0, finite(node?.duration, 0));
  const localTime = clamp(finite(playheadSec, 0) - finite(node?.timeline_start, 0), 0, duration);
  const keyframes = normalizeSceneKeyframes(node, defaults);
  if (!keyframes.length || localTime <= keyframes[0].time_sec) return keyframes[0]?.transform || base;
  const last = keyframes.at(-1);
  if (localTime >= last.time_sec) return last.transform;
  const nextIndex = keyframes.findIndex((keyframe) => keyframe.time_sec >= localTime);
  const before = keyframes[nextIndex - 1];
  const after = keyframes[nextIndex];
  const amount = (localTime - before.time_sec) / Math.max(0.000001, after.time_sec - before.time_sec);
  const interpolated = {};
  for (const field of interpolatedFields) {
    interpolated[field] = before.transform[field] + (after.transform[field] - before.transform[field]) * amount;
  }
  return normalizeSceneTransform(interpolated, defaults);
}

export function sceneKeyframeNearPlayhead(node, playheadSec, toleranceSec = 0.04, defaults = SCENE_TRANSFORM_DEFAULTS) {
  const localTime = finite(playheadSec, 0) - finite(node?.timeline_start, 0);
  return normalizeSceneKeyframes(node, defaults)
    .find((keyframe) => Math.abs(keyframe.time_sec - localTime) <= toleranceSec) || null;
}

export function sceneTransformPixels(transform, canvasWidth, canvasHeight, defaults = SCENE_TRANSFORM_DEFAULTS) {
  const normalized = normalizeSceneTransform(transform, defaults);
  const width = Math.max(1, finite(canvasWidth, LITE_CUT_OUTPUT_DEFAULTS.width));
  const height = Math.max(1, finite(canvasHeight, LITE_CUT_OUTPUT_DEFAULTS.height));
  return {
    x: normalized.x * width,
    y: normalized.y * height,
    width: normalized.width * width,
    height: normalized.height * height,
    renderedWidth: normalized.width * normalized.scale * width,
    renderedHeight: normalized.height * normalized.scale * height,
  };
}

export function sceneTransformStyle(transform, {
  defaults = SCENE_TRANSFORM_DEFAULTS,
  flipHorizontal = false,
  flipVertical = false,
  motionX = 0,
  motionY = 0,
  opacity = 1,
  prefixTransform = "",
} = {}) {
  const normalized = normalizeSceneTransform(transform, defaults);
  const scaleX = normalized.scale * (flipHorizontal ? -1 : 1);
  const scaleY = normalized.scale * (flipVertical ? -1 : 1);
  const transformValue = [
    String(prefixTransform || "").trim(),
    "translate(-50%, -50%)",
    `rotate(${normalized.rotation}deg)`,
    `scale(${scaleX}, ${scaleY})`,
  ].filter(Boolean).join(" ");
  return {
    left: `${(normalized.x + finite(motionX, 0)) * 100}%`,
    top: `${(normalized.y + finite(motionY, 0)) * 100}%`,
    width: `${normalized.width * 100}%`,
    height: `${normalized.height * 100}%`,
    opacity: clamp(finite(opacity, 1), 0, 1) * normalized.opacity,
    transform: transformValue,
  };
}

export function sceneObjectFitClass(contentFit = "fill") {
  if (contentFit === "contain") return "object-contain";
  if (contentFit === "cover") return "object-cover";
  return "object-fill";
}

export function normalizeSceneCrop(crop) {
  return normalizeVisualCrop(crop);
}

/** Project source-crop + content-fit into nested CSS rectangles. */
export function sceneMaterialLayout({
  transform,
  crop,
  contentFit = "fill",
  canvasWidth = 1920,
  canvasHeight = 1080,
  sourceWidth = 1920,
  sourceHeight = 1080,
  defaults = VIDEO_SCENE_TRANSFORM_DEFAULTS,
} = {}) {
  const scene = normalizeSceneTransform(transform, defaults);
  const sourceCrop = normalizeSceneCrop(crop);
  const canvasAspect = Math.max(0.0001, finite(canvasWidth, 1920)) / Math.max(0.0001, finite(canvasHeight, 1080));
  const boxAspect = canvasAspect * scene.width / scene.height;
  const sourceAspect = Math.max(0.0001, finite(sourceWidth, canvasWidth)) / Math.max(0.0001, finite(sourceHeight, canvasHeight));
  const croppedAspect = sourceAspect * sourceCrop.width / sourceCrop.height;
  const fit = ["contain", "cover", "fill"].includes(contentFit) ? contentFit : "fill";
  let viewportWidth = 1;
  let viewportHeight = 1;
  if (fit === "contain") {
    if (croppedAspect >= boxAspect) viewportHeight = boxAspect / croppedAspect;
    else viewportWidth = croppedAspect / boxAspect;
  } else if (fit === "cover") {
    if (croppedAspect >= boxAspect) viewportWidth = croppedAspect / boxAspect;
    else viewportHeight = boxAspect / croppedAspect;
  }
  return {
    viewportStyle: {
      position: "absolute",
      left: "50%",
      top: "50%",
      width: `${viewportWidth * 100}%`,
      height: `${viewportHeight * 100}%`,
      transform: "translate(-50%, -50%)",
      overflow: "hidden",
    },
    mediaStyle: {
      position: "absolute",
      left: `${(-sourceCrop.x / sourceCrop.width) * 100}%`,
      top: `${(-sourceCrop.y / sourceCrop.height) * 100}%`,
      width: `${100 / sourceCrop.width}%`,
      height: `${100 / sourceCrop.height}%`,
      maxWidth: "none",
      objectFit: "fill",
    },
  };
}

export function sceneResolvedContentFit(node, requestedFit = "fill") {
  const fit = ["fill", "contain", "cover", "blur"].includes(requestedFit) ? requestedFit : "fill";
  if (fit === "fill" || fit === "contain") return fit;
  const keyframes = normalizeSceneKeyframes(node);
  if (keyframes.length < 2) return fit;
  const first = keyframes[0].transform;
  const animatedBox = keyframes.slice(1).some((keyframe) => (
    Math.abs(keyframe.transform.width - first.width) > 1e-9
    || Math.abs(keyframe.transform.height - first.height) > 1e-9
    || Math.abs(keyframe.transform.scale - first.scale) > 1e-9
  ));
  return animatedBox ? "fill" : fit;
}
