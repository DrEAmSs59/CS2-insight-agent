import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { requireFrontendDependencies, satisfiesDeclaredVersion } from "./require-frontend-dependencies.mjs";

test("rejects outdated installed packages and unsupported ranges", () => {
  for (const [actual, wanted, expected] of [
    ["8.4.0", "9.8.0", false], ["9.8.0", "9.8.0", true], ["9.9.0", "9.8.0", false],
    ["8.3.4", "^8.3.5", false], ["8.4.0", "^8.3.5", true], ["9.0.0", "^8.3.5", false],
    ["0.4.5", "^0.4.4", true], ["0.5.0", "^0.4.4", false], ["0.0.5", "^0.0.4", false],
    ["1.2.4", "~1.2.3", true], ["1.3.0", "~1.2.3", false], ["1.2.3-rc.1", "^1.2.3", false],
    ["1.2.3", "*", false],
  ]) assert.equal(satisfiesDeclaredVersion(actual, wanted), expected, `${actual} ${wanted}`);
});

test("reports both stale and missing dependencies with a frozen-install command", (t) => {
  const root = mkdtempSync(join(tmpdir(), "insight-dependency-check-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  writeFileSync(join(root, "package.json"), JSON.stringify({
    packageManager: "pnpm@12.14.0", devDependencies: { "@ianlucas/cs2-lib": "9.8.0", vite: "^8.3.5" },
  }));
  const pkg = join(root, "node_modules", "@ianlucas", "cs2-lib");
  mkdirSync(pkg, { recursive: true });
  writeFileSync(join(pkg, "package.json"), JSON.stringify({ version: "8.4.0" }));
  assert.throws(() => requireFrontendDependencies(root), (error) => {
    assert.match(error.message, /installed 8\.4\.0, required 9\.8\.0/);
    assert.match(error.message, /vite: installed missing/);
    assert.match(error.message, /corepack pnpm install --frozen-lockfile/);
    return true;
  });
  writeFileSync(join(pkg, "package.json"), JSON.stringify({ version: "9.8.0" }));
  mkdirSync(join(root, "node_modules", "vite"));
  writeFileSync(join(root, "node_modules", "vite", "package.json"), JSON.stringify({ version: "8.3.5" }));
  assert.doesNotThrow(() => requireFrontendDependencies(root));
});
