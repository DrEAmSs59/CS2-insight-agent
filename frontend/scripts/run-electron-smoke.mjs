import { spawn } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, rmSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const frontendRoot = resolve(fileURLToPath(new URL("..", import.meta.url)));
const exePath = join(frontendRoot, "dist_electron", "win-unpacked", "CS2 Insight Agent.exe");
const electronRuntimePath = join(frontendRoot, "node_modules", "electron", "dist", "electron.exe");
const packagedAsarPath = join(frontendRoot, "dist_electron", "win-unpacked", "resources", "app.asar");
const outputDir = resolve(frontendRoot, "..", "artifacts", "electron-smoke");
const reportPath = join(outputDir, "report.json");
const profilePath = join(outputDir, "profile");

if (!existsSync(exePath)) {
  console.error(`[electron-smoke] Packaged executable not found: ${exePath}`);
  process.exit(1);
}
rmSync(outputDir, { recursive: true, force: true });
mkdirSync(outputDir, { recursive: true });

const launchOptions = {
  cwd: frontendRoot,
  env: {
    ...process.env,
    CS2_INSIGHT_ELECTRON_SMOKE: "1",
    CS2_INSIGHT_ELECTRON_SMOKE_REPORT: reportPath,
  },
  stdio: "ignore",
  windowsHide: true,
};
let child = null;
let launchError = null;
for (let attempt = 1; attempt <= 6 && !child; attempt += 1) {
  try {
    child = spawn(exePath, [`--user-data-dir=${profilePath}`], launchOptions);
  } catch (error) {
    launchError = error;
    if (attempt < 6) await new Promise((resolve) => setTimeout(resolve, attempt * 500));
  }
}
if (!child) {
  if (!existsSync(electronRuntimePath) || !existsSync(packagedAsarPath)) {
    console.error(`[electron-smoke] Could not launch app after retries: ${launchError?.message || launchError}`);
    process.exit(1);
  }
  console.warn(`[electron-smoke] Packaged EXE was blocked; running the exact packaged app.asar with the trusted Electron runtime: ${launchError?.message || launchError}`);
  child = spawn(electronRuntimePath, [packagedAsarPath, `--user-data-dir=${profilePath}`], {
    ...launchOptions,
    env: {
      ...launchOptions.env,
      NODE_ENV: "production",
      CS2_INSIGHT_ELECTRON_SMOKE_ASAR: "1",
    },
  });
}

const timeout = setTimeout(() => {
  child.kill();
  console.error("[electron-smoke] Timed out waiting for the packaged app");
  process.exit(1);
}, 90000);

child.once("error", (error) => {
  clearTimeout(timeout);
  console.error(`[electron-smoke] Could not launch app: ${error.message}`);
  process.exit(1);
});

child.once("exit", (code) => {
  clearTimeout(timeout);
  if (!existsSync(reportPath)) {
    console.error(`[electron-smoke] App exited with ${code}; no report was produced`);
    process.exit(1);
  }
  const report = JSON.parse(readFileSync(reportPath, "utf8"));
  console.log(JSON.stringify(report, null, 2));
  process.exit(code === 0 && report.ok ? 0 : 1);
});
