import { requireSecureNode } from "./require-secure-node.mjs";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import { runtimeManifestStatus } from "./runtime-fingerprint.mjs";

export function stagePythonRuntime({
  repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..", ".."),
  env = process.env,
  platform = process.platform,
  run = spawnSync,
} = {}) {
  requireSecureNode();
  const pythonDir = join(repoRoot, "python");
  const pythonExe = join(pythonDir, "python.exe");
  const portablePs1 = join(repoRoot, "packaging", "windows", "package_portable.ps1");

  if (env.CS2_INSIGHT_SKIP_PYTHON_STAGE === "1") {
    console.log("[desktop] CS2_INSIGHT_SKIP_PYTHON_STAGE=1 — skip Python staging");
    return 0;
  }

  if (platform !== "win32") {
    if (!existsSync(pythonExe)) {
      console.error("[desktop] Non-Windows builds require a prepared python/python.exe runtime.");
      return 1;
    }
    return 0;
  }

  function resolveLeanWheel() {
    const configured = env.CS2_INSIGHT_DEMOPARSER_WHEEL?.trim();
    if (configured) {
      const fullPath = resolve(repoRoot, configured);
      if (!existsSync(fullPath)) throw new Error(`Configured lean wheel does not exist: ${fullPath}`);
      return fullPath;
    }
    const metadata = JSON.parse(readFileSync(join(repoRoot, "packaging", "demoparser-lean", "demoparser-runtime.json"), "utf8").replace(/^\uFEFF/, ""));
    const wheel = join(repoRoot, "dist", "wheels", `demoparser2-${metadata.distribution_version}-cp312-cp312-win_amd64.whl`);
    return existsSync(wheel) ? wheel : null;
  }

  const customPython = env.CS2_INSIGHT_PORTABLE_PYTHON_DIR?.trim();
  if (!existsSync(portablePs1)) {
    console.error(`[desktop] missing Python staging script: ${portablePs1}`);
    return 1;
  }

  function verifyPython() {
    const pythonVersion = run(pythonExe, [
      "-I", "-B", join(repoRoot, "packaging", "windows", "verify_python_version.py"),
    ], { cwd: repoRoot, env, stdio: "inherit", shell: false });
    if (pythonVersion.status !== 0) return pythonVersion.status ?? 1;
    const backendDir = join(repoRoot, "backend");
    // demoparser gate + skin-core IPC deps (cryptography). Stale python/ after
    // pyproject bumps otherwise ships and crashes at backend import.
    const verification = run(
      pythonExe,
      [
        "-c",
        [
          "import sys",
          "sys.path.insert(0, sys.argv[1])",
          // Keep this command comment-free: the statements are joined onto one
          // Python line, so an inline `#` would hide every validation after it.
          "import cryptography",
          "import certifi",
          "assert certifi.__version__ == '2026.10.19', 'Rebuild the Python CA bundle'",
          "from app.demoparser_runtime import main",
          "raise SystemExit(main())",
        ].join("; "),
        backendDir,
      ],
      { cwd: repoRoot, env, stdio: "inherit", shell: false },
    );
    if (verification.status !== 0) {
      console.error(
        "[desktop] existing Python runtime is incompatible; run " +
        "packaging/demoparser-lean/setup-backend-dev.ps1 or rebuild with " +
        "CS2_INSIGHT_REFRESH_PYTHON=1 and CS2_INSIGHT_DEMOPARSER_WHEEL.",
      );
      return verification.status ?? 1;
    }
    return 0;
  }

  if (existsSync(pythonExe) && env.CS2_INSIGHT_REFRESH_PYTHON !== "1") {
    const manifest = runtimeManifestStatus(repoRoot, pythonDir);
    if (manifest.valid) {
      const verification = verifyPython();
      if (verification !== 0) return verification;
      console.log("[desktop] using verified python/python.exe");
      return 0;
    }
    console.log(`[desktop] existing Python runtime is stale (${manifest.reason}); rebuilding from locked inputs.`);
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
  if (!leanWheel) {
    console.error(
      "[desktop] patched demoparser wheel is required. Run " +
      "packaging/demoparser-lean/setup-backend-dev.ps1 -BuildFromSource or set " +
      "CS2_INSIGHT_DEMOPARSER_WHEEL.",
    );
    return 1;
  }
  args.push("-DemoparserWheel", leanWheel);

  const result = run("powershell.exe", args, {
    cwd: repoRoot,
    env,
    stdio: "inherit",
  });
  if (result.status !== 0) return result.status ?? 1;

  if (!existsSync(pythonExe)) {
    console.error("[desktop] Python staging completed without python/python.exe");
    return 1;
  }

  const stagedManifest = runtimeManifestStatus(repoRoot, pythonDir);
  if (!stagedManifest.valid) {
    console.error(`[desktop] Python staging completed with a stale runtime manifest (${stagedManifest.reason})`);
    return 1;
  }
  const verification = verifyPython();
  if (verification !== 0) return verification;
  console.log("[desktop] rebuilt and verified python/python.exe");
  return 0;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  process.exitCode = stagePythonRuntime();
}
