import { cpSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { gzipSync } from "node:zlib";
import { spawnSync } from "node:child_process";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const frontendRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
const repoRoot = join(frontendRoot, "..");
const destination = join(frontendRoot, "src-tauri", "bundle-resources");
const packageVersion = JSON.parse(readFileSync(join(frontendRoot, "package.json"), "utf8")).version;
const appVersion = process.env.CS2_INSIGHT_APP_VERSION?.trim() || packageVersion;

if (!/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(appVersion)) {
  throw new Error(`Invalid desktop resource version: ${appVersion}`);
}

function normalizedRelative(root, path) {
  return relative(root, path).replaceAll("\\", "/");
}

function commonSkip(rel) {
  const path = `/${rel.toLowerCase()}/`;
  return path.includes("/__pycache__/") || path.includes("/.pytest_cache/") || rel.toLowerCase().endsWith(".pyc");
}

function copyFiltered(name, filter) {
  const source = join(repoRoot, name);
  if (!existsSync(source)) throw new Error(`Missing bundle resource: ${source}`);
  const target = join(destination, name);
  cpSync(source, target, {
    recursive: true,
    filter(path) {
      const rel = normalizedRelative(source, path);
      return !rel || (!commonSkip(rel) && filter(rel));
    },
  });
}

rmSync(destination, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
mkdirSync(destination, { recursive: true });
writeFileSync(join(destination, ".gitkeep"), "");

copyFiltered("python", () => true);
copyFiltered("backend", (rel) => {
  const path = rel.toLowerCase();
  const first = path.split("/")[0];
  if (["dist", "logs", "scripts", "tests"].includes(first)) return false;
  if (path === "app/release_version.txt") return false;
  if (/\.db(?:-wal|-shm)?$/i.test(path) || path.endsWith(".exe")) return false;
  return !/^debug_.*\.py$/i.test(path);
});
const requiredBackendResources = [
  "app/features/lite_cut/contracts/lite_cut_effect_contract.json",
  "app/features/lite_cut/contracts/lite_cut_project_contract.json",
];
for (const rel of requiredBackendResources) {
  const resource = join(destination, "backend", ...rel.split("/"));
  if (!existsSync(resource)) throw new Error(`Missing staged backend resource: ${resource}`);
}
const catalogJson = join(
  destination,
  "backend",
  "app",
  "features",
  "demo_analysis",
  "cs2_item_catalog.generated.json",
);
if (!existsSync(catalogJson)) throw new Error(`Missing generated CS2 catalog: ${catalogJson}`);
const catalogGzip = `${catalogJson}.gz`;
writeFileSync(catalogGzip, gzipSync(readFileSync(catalogJson), { level: 9 }));
rmSync(catalogJson);
console.log(`[desktop] compressed generated catalog: ${normalizedRelative(destination, catalogGzip)}`);
writeFileSync(join(destination, "backend", "app", "release_version.txt"), `${appVersion}\n`);
copyFiltered("pov", () => true);
const requiredPovResources = [
  "chroma_demo_references/manifest.json",
  "chroma_main_maps/manifest.json",
  "chroma_skybox_children/manifest.json",
  "chroma_skybox_children/payloads.zip",
  "skyboxes/chroma_blue/chroma_blue.vmat_c",
  "skyboxes/chroma_blue/chroma_blue.vtex_c",
  "skyboxes/chroma_green/chroma_green.vmat_c",
  "skyboxes/chroma_green/chroma_green.vtex_c",
];
for (const rel of requiredPovResources) {
  const resource = join(destination, "pov", ...rel.split("/"));
  if (!existsSync(resource)) throw new Error(`Missing staged POV resource: ${resource}`);
}
const bundledDataFiles = new Set([
  "basic.ini",
  "cs2-insight.config.example.json",
]);
copyFiltered("data", (rel) => bundledDataFiles.has(rel.toLowerCase()));

/** Open-source DEM truth-source and names-only rewrite sidecars. */
function buildAndStageDemoTools() {
  const manifest = join(repoRoot, "tools", "demo-cosmetic-rewriter", "Cargo.toml");
  const binaries = ["demo-input-hud-track", "demo-player-aliases", "demo-sky-handle-rewriter"];
  const result = spawnSync(
    "cargo",
    [
      "build", "--release", "--locked", "--manifest-path", manifest,
      ...binaries.flatMap((name) => ["--bin", name]),
    ],
    { cwd: repoRoot, env: process.env, stdio: "inherit", shell: false },
  );
  if (result.status !== 0) {
    console.error("[desktop] failed to build authoritative DEM tools");
    process.exit(result.status ?? 1);
  }
  const toolsDir = join(destination, "tools");
  mkdirSync(toolsDir, { recursive: true });
  for (const binary of binaries) {
    const filename = process.platform === "win32" ? `${binary}.exe` : binary;
    const source = join(
      repoRoot,
      "tools",
      "demo-cosmetic-rewriter",
      "target",
      "release",
      filename,
    );
    if (!existsSync(source)) throw new Error(`DEM tool build produced no binary: ${source}`);
    cpSync(source, join(toolsDir, filename));
    console.log(`[desktop] staged authoritative DEM tool from ${source}`);
  }
}

buildAndStageDemoTools();

/** Optional proprietary sidecar — never fail OSS CI when absent. */
function maybeStageSkinCore() {
  const toolsDir = join(destination, "tools");
  const target = join(toolsDir, "skin-core.exe");
  const envPath = process.env.CS2_SKIN_CORE_EXE?.trim();
  if (!envPath) {
    console.log("[desktop] CS2_SKIN_CORE_EXE not provided; skipping proprietary sidecar");
    return;
  }
  const source = resolve(repoRoot, envPath);
  if (!existsSync(source)) throw new Error(`Configured skin-core.exe does not exist: ${source}`);
  mkdirSync(toolsDir, { recursive: true });
  cpSync(source, target);
  console.log(`[desktop] staged explicitly configured skin-core.exe from ${source}`);
}

maybeStageSkinCore();

// Run the exact parser command used by the NSIS postinstall hook against the
// copied bundle, not merely against the repo-root staging source. This keeps a
// stale or incomplete resource directory from becoming an uninstallable setup.
const bundledPython = join(destination, "python", "python.exe");
const bundledParserGate = join(destination, "backend", "app", "demoparser_runtime.py");
const parserVerification = spawnSync(
  bundledPython,
  ["-I", bundledParserGate],
  { cwd: destination, env: process.env, stdio: "inherit", shell: false },
);
if (parserVerification.status !== 0) {
  console.error("[desktop] staged Tauri resources failed the NSIS demoparser validation");
  process.exit(parserVerification.status ?? 1);
}

console.log(`[desktop] staged Tauri resources at ${destination}`);
