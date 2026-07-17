import effectContract from "../../../../../data/lite_cut_effect_contract.json";

export { effectContract };

export function normalizeVideoLayerTransform(transform = {}, defaults = {}) {
  const source = transform && typeof transform === "object" ? transform : {};
  const limits = effectContract.transform_limits;
  const finite = (value, fallback) => {
    const number = Number(value);
    return Number.isFinite(number) ? number : fallback;
  };
  const clamp = (value, minimum, maximum) => Math.max(limits[minimum], Math.min(limits[maximum], value));
  return {
    x: clamp(finite(source.x ?? defaults.x, 0.5), "position_min", "position_max"),
    y: clamp(finite(source.y ?? defaults.y, 0.5), "position_min", "position_max"),
    width: clamp(finite(source.width ?? defaults.width, 1), "size_min", "size_max"),
    height: clamp(finite(source.height ?? defaults.height, 1), "size_min", "size_max"),
    scale: clamp(finite(source.scale ?? defaults.scale, 1), "scale_min", "scale_max"),
    rotation: clamp(finite(source.rotation ?? defaults.rotation, 0), "rotation_min", "rotation_max"),
    opacity: clamp(finite(source.opacity ?? defaults.opacity, 1), "opacity_min", "opacity_max"),
  };
}
