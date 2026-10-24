import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const frontendRoot = join(dirname(fileURLToPath(import.meta.url)), "..");

// This repository uses exact or simple caret/tilde versions for direct deps.
// Refuse an unknown range rather than silently accepting a stale installation.
export function satisfiesDeclaredVersion(actual, declared) {
  const spec = /^(\^|~)?(\d+)\.(\d+)\.(\d+)$/.exec(declared);
  const installed = /^(\d+)\.(\d+)\.(\d+)$/.exec(actual);
  if (!spec || !installed) return false;
  const wanted = spec.slice(2).map(Number);
  const current = installed.slice(1).map(Number);
  const difference = current.map((v, i) => v - wanted[i]).find((v) => v !== 0) ?? 0;
  if (!spec[1]) return difference === 0;
  if (difference < 0 || current[0] !== wanted[0]) return false;
  if (spec[1] === "~" || wanted[0] === 0) {
    if (current[1] !== wanted[1]) return false;
    if (spec[1] === "^" && wanted[1] === 0) return difference === 0;
  }
  return true;
}

export function requireFrontendDependencies(root = frontendRoot) {
  const manifest = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
  const mismatches = [];
  for (const [name, wanted] of Object.entries({ ...manifest.dependencies, ...manifest.devDependencies })) {
    let actual = "missing";
    try {
      actual = JSON.parse(readFileSync(join(root, "node_modules", name, "package.json"), "utf8")).version;
    } catch { /* Report missing and incomplete installs together. */ }
    if (!satisfiesDeclaredVersion(actual, wanted)) mismatches.push(`${name}: installed ${actual}, required ${wanted}`);
  }
  if (mismatches.length) {
    throw new Error(`Frontend dependencies are stale or missing:\n${mismatches.join("\n")}\n` +
      `Run in ${root}: corepack pnpm install --frozen-lockfile (${manifest.packageManager}).`);
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  requireFrontendDependencies();
  console.log("[desktop] Frontend dependency versions verified");
}
