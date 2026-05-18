import { existsSync, rmSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const frontendRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
const dir = join(frontendRoot, "dist_electron");
if (!existsSync(dir)) process.exit(0);

try {
  rmSync(dir, {
    recursive: true,
    force: true,
    maxRetries: 12,
    retryDelay: 250,
  });
} catch (err) {
  console.error(
    "[clean-dist-electron] Could not remove dist_electron. Common causes:",
  );
  console.error(
    "  • Task Manager: end node.exe / app-builder.exe / packaged Electron still running",
  );
  console.error(
    "  • Windows Security: real-time scan locking .asar — retry later or exclude this repo",
  );
  console.error(
    "  • Sysinternals Handle: https://learn.microsoft.com/sysinternals/downloads/handle",
  );
  console.error("");
  console.error(err?.message || err);
  process.exit(1);
}
