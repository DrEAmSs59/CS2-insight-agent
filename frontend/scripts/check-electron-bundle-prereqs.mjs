import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const pythonExe = join(repoRoot, "python", "python.exe");
const runServer = join(repoRoot, "backend", "app", "run_server.py");

let ok = true;
if (!existsSync(runServer)) {
  ok = false;
  console.error(`[electron-bundle] Missing: ${runServer}`);
}
if (!existsSync(pythonExe)) {
  ok = false;
  console.error(`[electron-bundle] Missing: ${pythonExe}`);
}

if (!ok) {
  console.error("");
  console.error("electron:build 本应自动生成 python\\；若仍缺文件请检查：");
  console.error("  • Windows：仓库根是否有 package_portable.ps1（与便携包相同）");
  console.error("  • 用本机 Python 准备时：");
  console.error(
    `    set CS2_INSIGHT_PORTABLE_PYTHON_DIR=C:\\\\Path\\\\To\\\\Python312 && npm run electron:build`,
  );
  console.error("  • 强制重装依赖与环境：ELECTRON_REFRESH_PYTHON=1 npm run electron:build");
  console.error("  • 完全跳过自动准备（自备 python\\\\）：ELECTRON_SKIP_PYTHON_STAGE=1");
  console.error("");
  process.exit(1);
}

console.log("[electron-bundle] Found python.exe and backend/run_server.py — OK");
