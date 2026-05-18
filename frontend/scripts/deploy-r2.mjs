import { S3Client, PutObjectCommand, HeadObjectCommand } from "@aws-sdk/client-s3";
import { Upload } from "@aws-sdk/lib-storage";
import fs from "fs";
import path from "path";
import mime from "mime-types";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DIST_DIR = path.join(__dirname, "../dist_electron");

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

async function checkFileExists(key, localSize) {
  try {
    const command = new HeadObjectCommand({
      Bucket: config.bucket,
      Key: key,
    });
    const response = await s3Client.send(command);
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

async function uploadFile(filePath, key) {
  const stats = fs.statSync(filePath);
  const localSize = stats.size;

  // 始终上传清单文件 (.yml)，确保版本信息是最新的
  const isManifest = key.endsWith(".yml");
  
  if (!isManifest) {
    const exists = await checkFileExists(key, localSize);
    if (exists) {
      console.log(`Skipping ${key} (already exists and matches size)`);
      return;
    }
  }

  const fileStream = fs.createReadStream(filePath);
  const contentType = mime.lookup(filePath) || "application/octet-stream";

  console.log(`Uploading ${key}... (${(localSize / 1024 / 1024).toFixed(2)} MB)`);

  try {
    const parallelUploads3 = new Upload({
      client: s3Client,
      params: {
        Bucket: config.bucket,
        Key: key,
        Body: fileStream,
        ContentType: contentType,
      },
      queueSize: 4,
      partSize: 1024 * 1024 * 5, // 5MB
      leavePartsOnError: false,
    });

    parallelUploads3.on("httpUploadProgress", (progress) => {
      const percentage = Math.round((progress.loaded / progress.total) * 100);
      process.stdout.write(`\rProgress: ${percentage}%`);
    });

    await parallelUploads3.done();
    console.log(`\nSuccessfully uploaded ${key}`);
  } catch (e) {
    console.error(`\nError uploading ${key}:`, e);
    throw e;
  }
}

async function main() {
  if (!fs.existsSync(DIST_DIR)) {
    console.error("Dist directory not found. Please run 'npm run electron:build' first.");
    process.exit(1);
  }

  if (!config.endpoint || !config.credentials.accessKeyId || !config.credentials.secretAccessKey) {
    console.error("Missing R2 credentials. Please set R2_ENDPOINT, R2_ACCESS_KEY_ID, and R2_SECRET_ACCESS_KEY.");
    process.exit(1);
  }

  const files = fs.readdirSync(DIST_DIR);
  
  // 我们需要上传所有发布所需的文件 (exe, AppImage, dmg, yml, blockmap 等)
  const targets = files.filter(f => 
    f.endsWith(".exe") || 
    f.endsWith(".AppImage") ||
    f.endsWith(".dmg") ||
    f.endsWith(".yml") || 
    f.endsWith(".blockmap")
  );

  console.log(`Found ${targets.length} files to upload to R2.`);

  for (const file of targets) {
    await uploadFile(path.join(DIST_DIR, file), file);
  }

  console.log("\nAll deployment tasks completed!");
}

main().catch(console.error);
