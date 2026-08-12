import projectContract from "../../../../../backend/app/features/lite_cut/contracts/lite_cut_project_contract.json";
import effectContract from "../../../../../backend/app/features/lite_cut/contracts/lite_cut_effect_contract.json";

export { projectContract };

export const LITE_CUT_PROJECT_SCHEMA_VERSION = projectContract.project_schema_version;
export const LITE_CUT_TRACK_TYPE_ORDER = Object.freeze([
  ...(projectContract.timeline?.track_layout?.ordered_types || ["video", "audio"]),
]);
const timelineLimits = projectContract.timeline?.limits || {};
export const LITE_CUT_TIMELINE_LIMITS = Object.freeze({
  time: Object.freeze({
    min: Number(timelineLimits.time_sec?.min),
    max: Number(timelineLimits.time_sec?.max),
    uiMax: Number(timelineLimits.time_sec?.ui_max),
    default: Number(timelineLimits.time_sec?.default),
  }),
  duration: Object.freeze({
    minExclusive: Number(timelineLimits.duration_sec?.exclusive_min),
    uiMin: Number(timelineLimits.duration_sec?.ui_min),
    max: Number(timelineLimits.duration_sec?.max),
    default: Number(timelineLimits.duration_sec?.default),
  }),
});
export const LITE_CUT_OUTPUT_DEFAULTS = Object.freeze({ ...projectContract.output.defaults });
const outputLimits = projectContract.output.limits || {};
const blurLimits = effectContract.canvas_rendering?.blur_amount || {};
export const LITE_CUT_OUTPUT_LIMITS = Object.freeze({
  width: Object.freeze({
    min: Number(outputLimits.width?.integer_min),
    max: Number(outputLimits.width?.integer_max),
  }),
  height: Object.freeze({
    min: Number(outputLimits.height?.integer_min),
    max: Number(outputLimits.height?.integer_max),
  }),
  fps: Object.freeze({
    min: Number(outputLimits.fps?.min),
    max: Number(outputLimits.fps?.max),
  }),
  blurAmount: Object.freeze({
    min: Number(blurLimits.min),
    max: Number(blurLimits.max),
    default: Number(blurLimits.default),
  }),
});
export const LITE_CUT_CANVAS_FIT_VALUES = Object.freeze([...(effectContract.canvas_rendering?.fit_values || [])]);
export const LITE_CUT_ENCODERS = Object.freeze([...projectContract.output.encoders]);
export const LITE_CUT_ENCODER_TIERS = Object.freeze([...projectContract.output.encoder_tiers]);
export const LITE_CUT_RANGE_MODES = Object.freeze([...projectContract.output.range_modes]);
export const LITE_CUT_RESOLUTION_PRESETS = Object.freeze(
  (projectContract.output.resolution_presets || []).map((preset) => Object.freeze({ ...preset })),
);
