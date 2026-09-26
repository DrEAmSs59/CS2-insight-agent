// @vitest-environment node
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, test } from "vitest";
import { collectRainRuntimePaths } from "./rain-runtime-paths.mjs";

const profile = (...paths) => ({
  loose_outer_replacements: paths.map((payload_relative_path) => ({ payload_relative_path })),
});
const temporaryRoots = [];
afterEach(() => {
  for (const root of temporaryRoots.splice(0)) rmSync(root, { recursive: true, force: true });
});

test("bundle retains original and versioned payloads, sharing reused resources", () => {
  const root = mkdtempSync(join(tmpdir(), "rain-bundle-"));
  temporaryRoots.push(root);
  mkdirSync(join(root, "new"));
  for (const path of ["old.vents_c", "new/entities.vents_c", "shared.vmdl_c"]) {
    writeFileSync(join(root, path), "payload");
  }
  const maps = { de_test: {
    ...profile("old.vents_c", "shared.vmdl_c"),
    source_variants: [profile("new/entities.vents_c", "shared.vmdl_c")],
  } };
  assert.deepEqual([...collectRainRuntimePaths(maps, root)].sort(),
    ["manifest.json", "new/entities.vents_c", "old.vents_c", "shared.vmdl_c"]);
  maps.de_test.source_variants[0] = profile("missing.vents_c");
  assert.throws(() => collectRainRuntimePaths(maps, root), /Missing final rain payload/);
});

test("variant payloads cannot escape the bundle resource root", () => {
  for (const path of ["../escape", "/absolute", "C:/outside", "folder//file"]) {
    assert.throws(() => collectRainRuntimePaths({ de_test: profile(path) }, "."), /Invalid final rain payload path/);
  }
});

test("production manifest stages old payloads and all September map variants", () => {
  const root = fileURLToPath(new URL("../../pov/weather_effects/rain/", import.meta.url));
  const manifest = JSON.parse(readFileSync(join(root, "manifest.json"), "utf8"));
  const paths = collectRainRuntimePaths(manifest.maps, root);
  for (const name of ["de_ancient", "de_cache", "de_mirage", "de_nuke"]) {
    assert.ok(paths.has(`${name}/default_ents.vents_c`));
    assert.ok(paths.has(`versions/25472966/${name}/default_ents.vents_c`));
  }
});
