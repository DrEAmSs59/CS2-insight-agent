import { spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { delimiter, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const version = process.argv[2]?.trim();
if (!version || !/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(version)) {
  console.error("Usage: npm run desktop:build:ver -- <x.y.z>");
  process.exit(1);
}

const frontendRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
const pathKey = Object.keys(process.env).find((key) => key.toLowerCase() === "path") || "PATH";
const buildEnv = {
  ...process.env,
  CS2_INSIGHT_APP_VERSION: version,
  [pathKey]: [dirname(process.execPath), process.env[pathKey] || ""]
    .filter(Boolean)
    .join(delimiter),
};

function run(command, args, env = process.env, shell = process.platform === "win32") {
  const result = spawnSync(command, args, {
    cwd: frontendRoot,
    env,
    stdio: "inherit",
    shell,
  });
  if (result.status !== 0) process.exit(result.status ?? 1);
}

run(
  process.execPath,
  [join(frontendRoot, "scripts", "stage-python-runtime.mjs")],
  buildEnv,
  false,
);
run(
  process.execPath,
  [join(frontendRoot, "scripts", "stage-tauri-resources.mjs")],
  buildEnv,
  false,
);

const tauri = join(frontendRoot, "node_modules", "@tauri-apps", "cli", "tauri.js");
const buildConfig = { version };
const certificateThumbprint = buildEnv.CS2_INSIGHT_WINDOWS_CERTIFICATE_THUMBPRINT?.replaceAll(/\s/g, "");
if (certificateThumbprint) {
  buildConfig.bundle = {
    windows: {
      certificateThumbprint,
      digestAlgorithm: "sha256",
      timestampUrl: "http://timestamp.comodoca.com",
    },
  };
}
run(
  process.execPath,
  [tauri, "build", "--config", JSON.stringify(buildConfig)],
  buildEnv,
  false,
);

if (process.platform === "win32") {
  const tauriRoot = join(frontendRoot, "src-tauri");
  const releaseRoot = join(tauriRoot, "target", "release");
  const loader = join(releaseRoot, "WebView2Loader.dll");
  const hook = join(tauriRoot, "windows", "upgrade-hooks.nsh");
  const generatedInstaller = join(releaseRoot, "nsis", "x64", "installer.nsi");
  const artifact = join(
    releaseRoot,
    "bundle",
    "nsis",
    `CS2 Insight Agent_${version}_x64-setup.exe`,
  );
  const gnuBuild = /gnu/i.test(
    [
      buildEnv.RUSTUP_TOOLCHAIN,
      buildEnv.CARGO_BUILD_TARGET,
      buildEnv.HOST,
    ].filter(Boolean).join(" "),
  ) || existsSync(loader);

  if (gnuBuild && !existsSync(loader)) {
    throw new Error(`GNU Tauri build is missing required runtime loader: ${loader}`);
  }
  const hookBody = readFileSync(hook, "utf8");
  if (gnuBuild && !hookBody.includes('File /a "/oname=WebView2Loader.dll"')) {
    throw new Error("NSIS hook does not install WebView2Loader.dll beside the Tauri executable");
  }
  const installerBody = readFileSync(generatedInstaller, "utf8");
  if (!installerBody.includes("windows\\upgrade-hooks.nsh")) {
    throw new Error("Generated NSIS script does not include the project installer hook");
  }
  if (!existsSync(artifact)) {
    throw new Error(`Tauri NSIS artifact was not created: ${artifact}`);
  }
  console.log(`[desktop] validated Windows runtime bundle: ${artifact}`);
}
