import { readFile, readdir } from "node:fs/promises";
import { dirname, extname, join, relative } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const frontendRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
const sourceRoot = join(frontendRoot, "src");
const dictRoot = join(sourceRoot, "i18n", "dict");
const failures = [];
const migratedUiFiles = [
  "App.jsx",
  "components/CustomTitleBar.jsx",
  "pages/DemoAnalysisPreviewPage.jsx",
  "pages/SettingsPage.jsx",
  "components/analysis/DemoHeatmapView.jsx",
];

function fail(message) {
  failures.push(message);
}

function parameters(value) {
  const names = new Set();
  for (const match of value.matchAll(/\{(\w+)\}/g)) names.add(match[1]);
  for (const match of value.matchAll(/\{(\w+),\s*plural,/g)) names.add(match[1]);
  return [...names].sort();
}

async function catalogSourceFiles(locale) {
  const root = join(dictRoot, "locales", locale);
  return (await readdir(root))
    .filter((name) => name.endsWith(".js"))
    .sort()
    .map((name) => join(root, name));
}

async function checkSourceDuplicates(locale) {
  const owners = new Map();
  for (const file of await catalogSourceFiles(locale)) {
    const body = await readFile(file, "utf8");
    const local = new Set();
    for (const match of body.matchAll(/^\s*"([^"]+)"\s*:/gm)) {
      const key = match[1];
      if (local.has(key)) fail(`${relative(frontendRoot, file)} defines ${key} more than once`);
      local.add(key);
      const previous = owners.get(key);
      if (previous) fail(`${key} exists in both ${previous} and ${relative(frontendRoot, file)}`);
      owners.set(key, relative(frontendRoot, file));
    }
  }
}

async function walk(directory) {
  const files = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const fullPath = join(directory, entry.name);
    if (entry.isDirectory()) files.push(...await walk(fullPath));
    else if ([".js", ".jsx", ".ts", ".tsx"].includes(extname(entry.name))) files.push(fullPath);
  }
  return files;
}

await checkSourceDuplicates("zh");
await checkSourceDuplicates("en");

const zh = (await import(`${pathToFileURL(join(dictRoot, "zh.js")).href}?check=${Date.now()}`)).default;
const en = (await import(`${pathToFileURL(join(dictRoot, "en.js")).href}?check=${Date.now()}`)).default;
const zhKeys = Object.keys(zh).filter((key) => !key.startsWith("__test_only_")).sort();
const enKeys = Object.keys(en).filter((key) => !key.startsWith("__test_only_")).sort();

for (const key of zhKeys) {
  if (!(key in en)) fail(`English catalog is missing ${key}`);
}
for (const key of enKeys) {
  if (!(key in zh)) fail(`English catalog has extra key ${key}`);
}
for (const key of zhKeys) {
  const zhParams = parameters(zh[key]);
  const enParams = parameters(en[key]);
  if (zhParams.join("\0") !== enParams.join("\0")) {
    fail(`${key} uses different parameters: zh=[${zhParams}] en=[${enParams}]`);
  }
}

const sourceFiles = (await walk(sourceRoot)).filter((file) => {
  const normalized = file.replaceAll("\\", "/");
  return !normalized.includes("/i18n/dict/") && !normalized.includes("/__tests__/") && !/\.test\.[jt]sx?$/.test(normalized);
});
const staticKeys = new Set();
for (const file of sourceFiles) {
  const body = await readFile(file, "utf8");
  for (const match of body.matchAll(/\bt\(\s*["']([^"']+)["']/g)) staticKeys.add(match[1]);
}
for (const key of staticKeys) {
  if (!(key in zh)) fail(`${key} is referenced by t() but missing from the catalogs`);
}

for (const relativePath of migratedUiFiles) {
  const file = join(sourceRoot, relativePath);
  let body = await readFile(file, "utf8");
  body = body
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/^\s*\/\/.*$/gm, "");
  if (relativePath === "pages/DemoAnalysisPreviewPage.jsx") {
    // One release of sessionStorage used this localized value as an ID.
    body = body.replace('storedSelectedTag === "全部"', "storedSelectedTag === LEGACY_ALL_TAG");
  }
  const han = body.match(/[\p{Script=Han}]/u);
  if (han) fail(`${relativePath} contains hard-coded Han UI text near index ${han.index}`);
}

if (failures.length) {
  console.error(`[i18n] ${failures.length} validation failure(s):`);
  for (const message of failures) console.error(`- ${message}`);
  process.exit(1);
}

console.log(`[i18n] ${zhKeys.length} shared keys across 24 feature catalogs; ${staticKeys.size} static t() references and ${migratedUiFiles.length} migrated UI files verified.`);
