import { existsSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const pythonExe = join(repoRoot, "python", "python.exe");
const portablePs1 = join(repoRoot, "packaging", "windows", "package_portable.ps1");

if (process.env.ELECTRON_SKIP_PYTHON_STAGE === "1") {
  console.log("[electron] ELECTRON_SKIP_PYTHON_STAGE=1 — skip python staging");
  process.exit(0);
}

if (process.platform !== "win32") {
  if (!existsSync(pythonExe)) {
    console.error(
      "[electron] Non-Windows: 请自备仓库根目录 python/python.exe，或在本机构建后再 electron:build",
    );
    process.exit(1);
  }
  console.log("[electron] Non-Windows — 使用现有 python\\");
  process.exit(0);
}

if (
  existsSync(pythonExe) &&
  process.env.ELECTRON_REFRESH_PYTHON !== "1"
) {
  console.log(
    "[electron] 已存在 python\\python.exe — 跳过准备（改依赖后设 ELECTRON_REFRESH_PYTHON=1 或删掉 python\\ 会重新 pip）",
  );
  process.exit(0);
}

if (!existsSync(portablePs1)) {
  console.error(
    `[electron] 未找到 ${portablePs1}`,
  );
  console.error(
    "请将 package_portable.ps1 放在仓库根目录（与便携包脚本相同），或手动运行便携包流程生成 python\\ 后再打包。",
  );
  process.exit(1);
}

const psArgs = [
  "-NoProfile",
  "-ExecutionPolicy",
  "Bypass",
  "-File",
  portablePs1,
  "-ElectronStagePythonOnly",
];

const customPy = process.env.CS2_INSIGHT_PORTABLE_PYTHON_DIR?.trim();
if (customPy) {
  psArgs.push("-PortablePythonDir", customPy);
}

console.log("[electron] 准备 python\\（与 package_portable.ps1 便携逻辑一致）…");
const r = spawnSync("powershell.exe", psArgs, {
  stdio: "inherit",
  cwd: repoRoot,
  env: process.env,
});

if (r.status !== 0) {
  process.exit(r.status ?? 1);
}

if (!existsSync(pythonExe)) {
  console.error("[electron] 准备完成后仍未找到 python/python.exe");
  process.exit(1);
}

console.log("[electron] python\\ 已就绪");
