// @vitest-environment node

import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  RUNTIME_FINGERPRINT_INPUTS,
  runtimeManifestStatus,
  writeRuntimeManifest,
} from "./runtime-fingerprint.mjs";

const temporaryRoots = [];

afterEach(() => {
  for (const root of temporaryRoots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function fixture() {
  const root = mkdtempSync(join(tmpdir(), "cs2-runtime-fingerprint-"));
  temporaryRoots.push(root);
  for (const relativePath of RUNTIME_FINGERPRINT_INPUTS) {
    const fullPath = join(root, ...relativePath.split("/"));
    mkdirSync(dirname(fullPath), { recursive: true });
    writeFileSync(fullPath, `${relativePath}\n`, "utf8");
  }
  const runtimeDir = join(root, "python");
  mkdirSync(runtimeDir);
  return { root, runtimeDir };
}

describe("runtime fingerprint", () => {
  it("rejects a missing manifest and accepts a freshly written one", () => {
    const { root, runtimeDir } = fixture();
    expect(runtimeManifestStatus(root, runtimeDir).reason).toBe("missing");

    writeRuntimeManifest(root, runtimeDir);

    expect(runtimeManifestStatus(root, runtimeDir).valid).toBe(true);
  });

  it("invalidates a reused runtime when a packaging input changes", () => {
    const { root, runtimeDir } = fixture();
    writeRuntimeManifest(root, runtimeDir);
    writeFileSync(join(root, "uv.lock"), "changed\n", "utf8");

    const status = runtimeManifestStatus(root, runtimeDir);
    expect(status.valid).toBe(false);
    expect(status.reason).toBe("mismatch");
  });

  it("rejects a manifest written with an unsupported schema", () => {
    const { root, runtimeDir } = fixture();
    writeRuntimeManifest(root, runtimeDir);
    const manifestPath = join(runtimeDir, ".cs2-insight-runtime.json");
    const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
    writeFileSync(manifestPath, `${JSON.stringify({ ...manifest, schemaVersion: 2 })}\n`, "utf8");

    const status = runtimeManifestStatus(root, runtimeDir);
    expect(status.valid).toBe(false);
    expect(status.reason).toBe("schema");
  });
});
