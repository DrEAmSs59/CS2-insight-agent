import { cpSync, existsSync, mkdirSync, rmSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const destDir = join(repoRoot, "python");

const srcRaw =
  process.argv[2]?.trim() ||
  process.env.CS2_INSIGHT_PYTHON_HOME?.trim() ||
  process.env.CS2_INSIGHT_BUNDLE_PYTHON?.trim();

if (!srcRaw) {
  console.error("用法（任选其一）：");
  console.error('  npm run electron:copy-python -- "C:\\\\Path\\\\To\\\\Python311"');
  console.error("  或设置环境变量 CS2_INSIGHT_PYTHON_HOME 后：npm run electron:copy-python");
  console.error("");
  console.error("提示：填包含 python.exe 的那一层目录，例如：");
  console.error('  "C:\\\\Users\\\\你\\\\AppData\\\\Local\\\\Programs\\\\Python\\\\Python311"');
  process.exit(1);
}

const srcResolved = join(srcRaw);
if (!existsSync(join(srcResolved, "python.exe"))) {
  console.error(`在目录下未找到 python.exe：\n  ${srcResolved}`);
  console.error('请指到安装根目录（与 python.exe、Lib 同级），不要用 Scripts\\python.exe。');
  process.exit(1);
}

console.log(`从：${srcResolved}`);
console.log(`到：${destDir}`);

if (existsSync(destDir)) {
  rmSync(destDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
}

mkdirSync(destDir, { recursive: true });

/**
 * 体量优化：跳过常见无关目录（仍可运行后端时再按需收紧）
 */
function shouldSkip(rel) {
  const lower = rel.replace(/\\/g, "/").toLowerCase();
  if (lower.includes("/__pycache__/") || lower.endsWith("/__pycache__")) return true;
  if (lower.includes("/lib/test/") || lower.endsWith("/lib/test")) return true;
  if (lower.includes("/lib/tkinter/test/")) return true;
  // Exclude pip and build tools — not needed at runtime
  if (lower.includes("/lib/site-packages/pip/") || lower.endsWith("/lib/site-packages/pip")) return true;
  if (lower.includes("/lib/site-packages/pip-") && lower.includes(".dist-info")) return true;
  if (lower.includes("/lib/site-packages/setuptools/") || lower.endsWith("/lib/site-packages/setuptools")) return true;
  if (lower.includes("/lib/site-packages/setuptools-") && lower.includes(".dist-info")) return true;
  if (lower.includes("/lib/site-packages/wheel/") || lower.endsWith("/lib/site-packages/wheel")) return true;
  if (lower.includes("/lib/site-packages/wheel-") && lower.includes(".dist-info")) return true;
  if (lower.includes("/lib/site-packages/pkg_resources/") || lower.endsWith("/lib/site-packages/pkg_resources")) return true;
  if (lower.includes("/lib/site-packages/pkg_resources-") && lower.includes(".dist-info")) return true;
  if (lower.startsWith("scripts/pip") || lower.includes("/scripts/pip")) return true;
  return false;
}

cpSync(srcResolved, destDir, {
  recursive: true,
  filter: (src) => {
    const rel = relative(srcResolved, src);
    if (!rel || rel === "") return true;
    return !shouldSkip(rel);
  },
});

if (!existsSync(join(destDir, "python.exe"))) {
  console.error("复制后未找到 python/python.exe，请检查源路径。");
  process.exit(1);
}

console.log("[electron:copy-python] 完成。可执行：npm run electron:build");
