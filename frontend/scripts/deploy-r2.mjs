import { S3Client, HeadObjectCommand } from "@aws-sdk/client-s3";
import { Upload } from "@aws-sdk/lib-storage";
import crypto from "crypto";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

/**
 * 发布 Tauri NSIS 构建产物到 Cloudflare R2：
 *   - `CS2 Insight Agent_<ver>_x64-setup.exe` — 完整安装包（同时是更新包）
 *   - `latest.json` — Tauri updater 清单（签名来自同名 .sig 文件）
 *   - `latest.yml`  — electron-updater 桥接清单：旧 Electron 客户端会把
 *     Tauri 安装包当作更新下载并以 /S 静默执行，从而完成一次性迁移
 *
 * 需要先用 `pnpm run desktop:build:ver -- <ver>` 构建，并在构建时设置
 * TAURI_SIGNING_PRIVATE_KEY(_PATH)，否则不会生成 .sig 更新签名。
 */

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const NSIS_DIR = path.join(__dirname, "../src-tauri/target/release/bundle/nsis");

const PUBLIC_BASE_URL = (
  process.env.R2_PUBLIC_BASE_URL || "https://pub-7920152f7eff45c19b5a1750e55acd42.r2.dev"
).replace(/\/+$/, "");

const config = {
  region: "auto",
  endpoint: process.env.R2_ENDPOINT,
  credentials: {
    accessKeyId: process.env.R2_ACCESS_KEY_ID,
    secretAccessKey: process.env.R2_SECRET_ACCESS_KEY,
  },
  bucket: process.env.R2_BUCKET || "cs-demo-agent",
};

const s3Client = new S3Client({
  region: config.region,
  endpoint: config.endpoint,
  credentials: config.credentials,
});

const CONTENT_TYPES = {
  ".exe": "application/octet-stream",
  ".json": "application/json",
  ".yml": "text/yaml",
};

async function checkFileExists(key, localSize) {
  try {
    const response = await s3Client.send(
      new HeadObjectCommand({ Bucket: config.bucket, Key: key }),
    );
    // 如果大小一致，我们认为文件没有变化（简单但有效的热上传策略）
    return response.ContentLength === localSize;
  } catch (e) {
    if (e.name === "NotFound" || e.$metadata?.httpStatusCode === 404) {
      return false;
    }
    console.warn(`Warning: Could not check status for ${key}:`, e.message);
    return false;
  }
}

async function uploadFile(filePath, key, { alwaysUpload = false } = {}) {
  const stats = fs.statSync(filePath);
  const localSize = stats.size;

  if (!alwaysUpload) {
    const exists = await checkFileExists(key, localSize);
    if (exists) {
      console.log(`Skipping ${key} (already exists and matches size)`);
      return;
    }
  }

  const contentType = CONTENT_TYPES[path.extname(filePath).toLowerCase()] || "application/octet-stream";
  console.log(`Uploading ${key}... (${(localSize / 1024 / 1024).toFixed(2)} MB)`);

  const upload = new Upload({
    client: s3Client,
    params: {
      Bucket: config.bucket,
      Key: key,
      Body: fs.createReadStream(filePath),
      ContentType: contentType,
    },
    queueSize: 4,
    partSize: 1024 * 1024 * 5,
    leavePartsOnError: false,
  });
  upload.on("httpUploadProgress", (progress) => {
    const percentage = Math.round((progress.loaded / progress.total) * 100);
    process.stdout.write(`\rProgress: ${percentage}%`);
  });
  await upload.done();
  console.log(`\nSuccessfully uploaded ${key}`);
}

function sha512Base64(filePath) {
  const hash = crypto.createHash("sha512");
  hash.update(fs.readFileSync(filePath));
  return hash.digest("base64");
}

async function main() {
  if (!fs.existsSync(NSIS_DIR)) {
    console.error(
      `NSIS bundle directory not found: ${NSIS_DIR}\n` +
        "Please run 'pnpm run desktop:build:ver -- <version>' first.",
    );
    process.exit(1);
  }
  if (!config.endpoint || !config.credentials.accessKeyId || !config.credentials.secretAccessKey) {
    console.error("Missing R2 credentials. Please set R2_ENDPOINT, R2_ACCESS_KEY_ID, and R2_SECRET_ACCESS_KEY.");
    process.exit(1);
  }

  const setupName = fs
    .readdirSync(NSIS_DIR)
    .filter((f) => f.endsWith("-setup.exe"))
    .sort()
    .pop();
  if (!setupName) {
    console.error(`No '*-setup.exe' found in ${NSIS_DIR}.`);
    process.exit(1);
  }
  const setupPath = path.join(NSIS_DIR, setupName);

  const versionMatch = setupName.match(/_(\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?)_/);
  if (!versionMatch) {
    console.error(`Cannot parse version from installer name: ${setupName}`);
    process.exit(1);
  }
  const version = versionMatch[1];

  const sigPath = `${setupPath}.sig`;
  if (!fs.existsSync(sigPath)) {
    console.error(
      `Updater signature not found: ${sigPath}\n` +
        "Build with TAURI_SIGNING_PRIVATE_KEY / TAURI_SIGNING_PRIVATE_KEY_PATH set so Tauri emits the .sig file.",
    );
    process.exit(1);
  }

  const releaseNotes = process.env.RELEASE_NOTES || "";
  const updateModeRaw = String(process.env.UPDATE_MODE || "normal").trim().toLowerCase();
  const updateMode = updateModeRaw === "force" ? "force" : "normal";
  const pubDate = new Date().toISOString();
  const setupUrl = `${PUBLIC_BASE_URL}/${encodeURIComponent(setupName)}`;

  // Tauri updater manifest
  const latestJson = {
    version,
    notes: releaseNotes,
    pub_date: pubDate,
    update_mode: updateMode,
    platforms: {
      "windows-x86_64": {
        signature: fs.readFileSync(sigPath, "utf8").trim(),
        url: setupUrl,
      },
    },
  };
  const latestJsonPath = path.join(NSIS_DIR, "latest.json");
  fs.writeFileSync(latestJsonPath, `${JSON.stringify(latestJson, null, 2)}\n`);

  // electron-updater bridge manifest: legacy Electron clients download the
  // Tauri installer as a regular update and run it silently (/S), which the
  // NSIS upgrade hooks turn into an in-place migration.
  const sha512 = sha512Base64(setupPath);
  const size = fs.statSync(setupPath).size;
  const latestYml = [
    `version: ${version}`,
    "files:",
    `  - url: ${setupName}`,
    `    sha512: ${sha512}`,
    `    size: ${size}`,
    `path: ${setupName}`,
    `sha512: ${sha512}`,
    `releaseDate: '${pubDate}'`,
    "",
  ].join("\n");
  const latestYmlPath = path.join(NSIS_DIR, "latest.yml");
  fs.writeFileSync(latestYmlPath, latestYml);

  console.log(`Deploying version ${version} (${setupName}), update_mode=${updateMode}`);
  await uploadFile(setupPath, setupName);
  await uploadFile(latestJsonPath, "latest.json", { alwaysUpload: true });
  await uploadFile(latestYmlPath, "latest.yml", { alwaysUpload: true });

  console.log("\nAll deployment tasks completed!");
  console.log(`Updater endpoint: ${PUBLIC_BASE_URL}/latest.json`);
  console.log(`Update mode: ${updateMode} (set UPDATE_MODE=force|normal when deploying)`);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
