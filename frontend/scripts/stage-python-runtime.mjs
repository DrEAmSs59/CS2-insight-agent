import { existsSync, readdirSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const pythonDir = join(repoRoot, "python");
const pythonExe = join(pythonDir, "python.exe");
const portablePs1 = join(repoRoot, "packaging", "windows", "package_portable.ps1");

if (process.env.CS2_INSIGHT_SKIP_PYTHON_STAGE === "1") {
  console.log("[desktop] CS2_INSIGHT_SKIP_PYTHON_STAGE=1 — skip Python staging");
  process.exit(0);
}

if (process.platform !== "win32") {
  if (!existsSync(pythonExe)) {
    console.error("[desktop] Non-Windows builds require a prepared python/python.exe runtime.");
    process.exit(1);
  }
  process.exit(0);
}

if (existsSync(pythonExe) && process.env.CS2_INSIGHT_REFRESH_PYTHON !== "1") {
  console.log("[desktop] using existing python/python.exe");
  process.exit(0);
}

function resolveLeanWheel() {
  const configured = process.env.CS2_INSIGHT_DEMOPARSER_WHEEL?.trim();
  if (configured) {
    const fullPath = resolve(repoRoot, configured);
    if (!existsSync(fullPath)) throw new Error(`Configured lean wheel does not exist: ${fullPath}`);
    return fullPath;
  }
  const wheelDir = join(repoRoot, "dist", "wheels");
  if (!existsSync(wheelDir)) return null;
  const candidates = readdirSync(wheelDir)
    .filter((name) => /^demoparser2-.*-cp312-.*\.whl$/i.test(name))
    .sort();
  return candidates.length ? join(wheelDir, candidates.at(-1)) : null;
}

const customPython = process.env.CS2_INSIGHT_PORTABLE_PYTHON_DIR?.trim();
if (!existsSync(portablePs1)) {
  console.error(`[desktop] missing Python staging script: ${portablePs1}`);
  process.exit(1);
}

const args = [
  "-NoProfile",
  "-ExecutionPolicy",
  "Bypass",
  "-File",
  portablePs1,
  "-ElectronStagePythonOnly",
];
if (customPython) {
  args.push("-PortablePythonDir", customPython);
}
const leanWheel = resolveLeanWheel();
if (leanWheel) {
  args.push("-DemoparserWheel", leanWheel);
}

const result = spawnSync("powershell.exe", args, {
  cwd: repoRoot,
  env: process.env,
  stdio: "inherit",
});
if (result.status !== 0) process.exit(result.status ?? 1);

if (!existsSync(pythonExe)) {
  console.error("[desktop] Python staging completed without python/python.exe");
  process.exit(1);
}
