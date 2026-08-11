import projectContract from "../../../../../data/lite_cut_project_contract.json";

export { projectContract };

export const LITE_CUT_PROJECT_SCHEMA_VERSION = projectContract.project_schema_version;
export const LITE_CUT_OUTPUT_DEFAULTS = Object.freeze({ ...projectContract.output.defaults });
export const LITE_CUT_ENCODERS = Object.freeze([...projectContract.output.encoders]);
export const LITE_CUT_RANGE_MODES = Object.freeze([...projectContract.output.range_modes]);
