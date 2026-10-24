import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { stagePythonRuntime } from "./stage-python-runtime.mjs";
import { RUNTIME_FINGERPRINT_INPUTS, runtimeManifestStatus, writeRuntimeManifest } from "./runtime-fingerprint.mjs";

function fixture(t, { stale = true, wheel = true } = {}) {
  const root = mkdtempSync(join(tmpdir(), "insight-python-staging-"));
  t.after(() => {
    assert.equal(dirname(resolve(root)), resolve(tmpdir()));
    assert.ok(basename(root).startsWith("insight-python-staging-"));
    rmSync(root, { recursive: true, force: true });
  });
  for (const relativePath of RUNTIME_FINGERPRINT_INPUTS) {
    const file = join(root, relativePath);
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, relativePath);
  }
  writeFileSync(join(root, "packaging/demoparser-lean/demoparser-runtime.json"), "\uFEFF" + JSON.stringify({
    distribution_version: "0.41.4+cs2insight10",
  }));
  const runtime = join(root, "python");
  mkdirSync(runtime);
  writeFileSync(join(runtime, "python.exe"), "existing runtime");
  writeRuntimeManifest(root, runtime);
  if (stale) writeFileSync(join(root, "uv.lock"), "updated dependencies");
  const wheels = join(root, "dist/wheels");
  mkdirSync(wheels, { recursive: true });
  const expectedWheel = join(wheels, "demoparser2-0.41.4+cs2insight10-cp312-cp312-win_amd64.whl");
  if (wheel) writeFileSync(expectedWheel, "matching wheel");
  // A lexically later version must not replace the repository-pinned wheel.
  writeFileSync(join(wheels, "demoparser2-9.99.0-cp312-cp312-win_amd64.whl"), "wrong wheel");
  const calls = [];
  const run = (command, args) => {
    calls.push({ command, args });
    if (command === "powershell.exe") writeRuntimeManifest(root, runtime);
    return { status: 0 };
  };
  const stage = (overrides = {}) => stagePythonRuntime({ repoRoot: root, env: {}, platform: "win32", run, ...overrides });
  return { root, runtime, expectedWheel, calls, stage };
}

test("a stale runtime rebuilds automatically with the pinned wheel and passes both Python gates", (t) => {
  const f = fixture(t);
  assert.equal(f.stage(), 0);
  assert.equal(f.calls[0].command, "powershell.exe");
  assert.equal(f.calls[0].args.at(-1), f.expectedWheel);
  assert.equal(f.calls[1].args.at(-1), join(f.root, "packaging/windows/verify_python_version.py"));
  assert.match(f.calls[2].args[1], /certifi.*demoparser_runtime/);
  assert.equal(runtimeManifestStatus(f.root, f.runtime).valid, true);
});

test("the next packaging pass reuses the fresh runtime without rebuilding", (t) => {
  const f = fixture(t);
  assert.equal(f.stage(), 0);
  f.calls.length = 0;
  assert.equal(f.stage(), 0);
  assert.equal(f.calls.length, 2);
  assert.ok(f.calls.every(({ command }) => command.endsWith("python.exe")));
});

test("missing matching wheel stops before replacing the existing runtime", (t) => {
  const f = fixture(t, { wheel: false });
  assert.equal(f.stage(), 1);
  assert.equal(f.calls.length, 0);
  assert.equal(runtimeManifestStatus(f.root, f.runtime).reason, "mismatch");
});

test("a failed rebuild cannot be reported as successful", (t) => {
  const f = fixture(t);
  assert.equal(f.stage({ run: () => ({ status: 7 }) }), 7);
  assert.equal(runtimeManifestStatus(f.root, f.runtime).valid, false);
});

test("a successful subprocess without a fresh manifest is still rejected", (t) => {
  const f = fixture(t);
  assert.equal(f.stage({ run: () => ({ status: 0 }) }), 1);
});

test("a rebuilt runtime must pass Python version and dependency checks", (t) => {
  for (const failedCheck of [1, 2]) {
    const f = fixture(t);
    let check = 0;
    assert.equal(f.stage({ run: (command) => {
      if (command === "powershell.exe") {
        writeRuntimeManifest(f.root, f.runtime);
        return { status: 0 };
      }
      return { status: ++check === failedCheck ? 8 : 0 };
    } }), 8);
    assert.equal(check, failedCheck);
  }
});

test("explicit refresh and custom wheel remain supported", (t) => {
  const f = fixture(t, { stale: false, wheel: false });
  const customWheel = join(f.root, "custom-parser.whl");
  writeFileSync(customWheel, "explicit wheel");
  assert.equal(f.stage({ env: { CS2_INSIGHT_REFRESH_PYTHON: "1", CS2_INSIGHT_DEMOPARSER_WHEEL: customWheel } }), 0);
  assert.equal(f.calls[0].command, "powershell.exe");
  assert.equal(f.calls[0].args.at(-1), customWheel);
});

test("an invalid explicit wheel does not silently select another wheel", (t) => {
  const f = fixture(t);
  assert.throws(() => f.stage({ env: { CS2_INSIGHT_DEMOPARSER_WHEEL: "missing.whl" } }), /Configured lean wheel does not exist/);
  assert.equal(f.calls.length, 0);
});
