import { LITE_CUT_OUTPUT_DEFAULTS } from "./projectContract.js";

export function isEvenExportDimension(value) {
  const dimension = Number(value);
  return Number.isInteger(dimension) && dimension > 0 && dimension % 2 === 0;
}

export function getLiteCutResolutionError(output = {}) {
  const width = output?.width ?? LITE_CUT_OUTPUT_DEFAULTS.width;
  const height = output?.height ?? LITE_CUT_OUTPUT_DEFAULTS.height;
  if (isEvenExportDimension(width) && isEvenExportDimension(height)) return null;
  return { code: "LITECUT_EXPORT_RESOLUTION_INVALID", params: { width, height } };
}
