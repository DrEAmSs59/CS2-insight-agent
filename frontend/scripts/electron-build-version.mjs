import { spawnSync } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const v = process.argv[2]?.trim();
if (!v) {
  console.error("Usage: npm run electron:build:ver -- <x.y.z>");
  console.error("Example: npm run electron:build:ver -- 2.1.0");
  process.exit(1);
}
if (!/^\d+\.\d+\.\d+(-[0-9A-Za-z.-]+)?$/.test(v)) {
  console.error(`Invalid version format: ${v} (expected e.g. 2.1.0 or 2.1.0-beta.1)`);
  process.exit(1);
}

const frontendRoot = join(dirname(fileURLToPath(import.meta.url)), "..");

function run(args) {
  const r = spawnSync(args[0], args.slice(1), {
    stdio: "inherit",
    shell: true,
    cwd: frontendRoot,
    env: process.env,
  });
  if (r.status !== 0) process.exit(r.status ?? 1);
}

run(["npm", "run", "build"]);
run(["npm", "run", "electron:stage-python"]);
run(["node", "scripts/check-electron-bundle-prereqs.mjs"]);
run(["npm", "run", "electron:icons"]);
run(["npm", "run", "electron:clean"]);
// Prefer local binary — npm@6 has no `npm exec`
const ebCmd = process.platform === "win32" ? "electron-builder.cmd" : "electron-builder";
const ebBin = join(frontendRoot, "node_modules", ".bin", ebCmd);
run([ebBin, `--config.extraMetadata.version=${v}`]);
