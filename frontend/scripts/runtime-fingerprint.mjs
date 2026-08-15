import { createHash } from "node:crypto";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export const RUNTIME_MANIFEST_NAME = ".cs2-insight-runtime.json";
export const RUNTIME_FINGERPRINT_INPUTS = Object.freeze([
  "pyproject.toml",
  "uv.lock",
  "packaging/demoparser-lean/demoparser-runtime.json",
  "packaging/windows/package_portable.ps1",
  "frontend/scripts/runtime-fingerprint.mjs",
]);

export function computeRuntimeFingerprint(repoRoot) {
  const hash = createHash("sha256");
  for (const relativePath of RUNTIME_FINGERPRINT_INPUTS) {
    const fullPath = join(repoRoot, ...relativePath.split("/"));
    if (!existsSync(fullPath)) throw new Error(`Runtime fingerprint input is missing: ${fullPath}`);
    hash.update(relativePath);
    hash.update("\0");
    hash.update(readFileSync(fullPath));
    hash.update("\0");
  }
  return hash.digest("hex");
}

export function runtimeManifestStatus(repoRoot, runtimeDir) {
  const manifestPath = join(runtimeDir, RUNTIME_MANIFEST_NAME);
  const expectedFingerprint = computeRuntimeFingerprint(repoRoot);
  if (!existsSync(manifestPath)) {
    return { valid: false, reason: "missing", manifestPath, expectedFingerprint };
  }
  try {
    const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
    const actualFingerprint = String(manifest?.fingerprint || "").trim().toLowerCase();
    const schemaValid = manifest?.schemaVersion === 1;
    return {
      valid: schemaValid && actualFingerprint === expectedFingerprint,
      reason: !schemaValid ? "schema" : actualFingerprint === expectedFingerprint ? "ok" : "mismatch",
      manifestPath,
      expectedFingerprint,
      actualFingerprint,
    };
  } catch {
    return { valid: false, reason: "invalid", manifestPath, expectedFingerprint };
  }
}

export function writeRuntimeManifest(repoRoot, runtimeDir) {
  const manifestPath = join(runtimeDir, RUNTIME_MANIFEST_NAME);
  const manifest = {
    schemaVersion: 1,
    fingerprint: computeRuntimeFingerprint(repoRoot),
    inputs: [...RUNTIME_FINGERPRINT_INPUTS],
  };
  writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, "utf8");
  return manifestPath;
}

const invokedPath = process.argv[1] ? resolve(process.argv[1]) : "";
if (invokedPath === fileURLToPath(import.meta.url)) {
  const command = String(process.argv[2] || "").trim().toLowerCase();
  const runtimeDir = process.argv[3] ? resolve(process.argv[3]) : "";
  const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
  if (!runtimeDir || (command !== "write" && command !== "check")) {
    console.error("Usage: node runtime-fingerprint.mjs <write|check> <runtime-dir>");
    process.exit(2);
  }
  if (command === "write") {
    console.log(`[desktop] wrote runtime manifest: ${writeRuntimeManifest(repoRoot, runtimeDir)}`);
  } else {
    const status = runtimeManifestStatus(repoRoot, runtimeDir);
    if (!status.valid) {
      console.error(`[desktop] stale Python runtime manifest (${status.reason}): ${status.manifestPath}`);
      process.exit(1);
    }
    console.log(`[desktop] runtime manifest verified: ${status.manifestPath}`);
  }
}
