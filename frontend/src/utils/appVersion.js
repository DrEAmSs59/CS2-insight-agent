const PRODUCT_VERSION = /^(?:v)?(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:\.(0|[1-9]\d*))?(?:-([0-9A-Za-z.-]+))?$/i;
const UPDATER_VERSION = /^(?:v)?(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-([0-9A-Za-z.-]+))?$/i;

/** Fourth segment of a Pro release. Keeps the encoded Windows version within 65535. */
export const MAX_REVISION = 99;
export const MAX_PRODUCT_PATCH = 655;

function versionParts(match, explicitRevision) {
  const patch = Number(match[3]);
  const revision = explicitRevision ? Number(match[4]) : 0;
  if (patch > MAX_PRODUCT_PATCH || revision > MAX_REVISION) return null;
  if (patch * 100 + revision > 65535) return null;
  return {
    major: Number(match[1]),
    minor: Number(match[2]),
    patch,
    revision,
    prerelease: match[explicitRevision ? 5 : 4] || "",
    explicitRevision,
  };
}

/** Accepts `2.7.5`, `2.7.5.1`, and an optional prerelease suffix. */
export function parseProductVersion(input) {
  const match = PRODUCT_VERSION.exec(String(input || "").trim());
  if (!match) return null;
  return versionParts(match, match[4] != null);
}

export function formatProductVersion(version) {
  const core = version.explicitRevision || version.revision > 0
    ? `${version.major}.${version.minor}.${version.patch}.${version.revision}`
    : `${version.major}.${version.minor}.${version.patch}`;
  return version.prerelease ? `${core}-${version.prerelease}` : core;
}

/**
 * Tauri compares semver, so `2.7.5.1` cannot be the package version.
 * `2.7.5` becomes `2.7.500` and `2.7.5.1` becomes `2.7.501`.
 * An already installed `2.7.5` is older than `2.7.501`, and `2.7.501` is older than `2.7.600` (`2.7.6`).
 */
export function formatUpdaterVersion(version) {
  const core = `${version.major}.${version.minor}.${version.patch * 100 + version.revision}`;
  return version.prerelease ? `${core}-${version.prerelease}` : core;
}

/** Shows the product version for either a typed release or the encoded updater version. */
export function displayVersion(input) {
  const raw = String(input ?? "").trim();
  const product = parseProductVersion(raw);
  if (product?.explicitRevision) return formatProductVersion(product);

  const encoded = UPDATER_VERSION.exec(raw);
  if (!encoded) return raw;
  const patch = Number(encoded[3]);
  if (patch < 100) return product ? formatProductVersion(product) : raw.replace(/^v/i, "");

  const revision = patch % 100;
  const decoded = {
    major: Number(encoded[1]),
    minor: Number(encoded[2]),
    patch: Math.floor(patch / 100),
    revision,
    prerelease: encoded[4] || "",
    explicitRevision: revision > 0,
  };
  if (decoded.patch > MAX_PRODUCT_PATCH || decoded.patch * 100 + revision !== patch) return raw;
  return formatProductVersion(decoded);
}
