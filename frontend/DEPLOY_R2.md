# Cloudflare R2 Deployment Guide

The project now includes an automated deployment script to upload Electron build artifacts to Cloudflare R2.

## Prerequisites

Ensure you have the following environment variables set in your terminal session. You can find these values in the private memory file: `/home/cyc/.gemini/tmp/cs2-insight-agent/memory/CLOUDFLARE_R2.md`.

```bash
export R2_ENDPOINT="https://<your-account-id>.r2.cloudflarestorage.com"
export R2_ACCESS_KEY_ID="<your-access-key-id>"
export R2_SECRET_ACCESS_KEY="<your-secret-access-key>"
export R2_BUCKET="<your-bucket-name>"
```

## How to Deploy

1. **Build the Application:**
   Run the standard build command to generate the `.exe`, `latest.yml`, and `.blockmap` files.
   ```bash
   npm run electron:build
   ```

2. **Run the Deployment Script:**
   This will scan the `dist_electron` directory and upload only the necessary update files to R2.
   ```bash
   npm run deploy:r2
   ```

## What gets uploaded?

The script specifically targets:
- `*.exe`: The full installer.
- `latest.yml`: The version manifest used by `electron-updater`.
- `*.exe.blockmap`: The binary index that enables delta updates.

## Technical Details

- **Script Location:** `frontend/scripts/deploy-r2.mjs`
- **Libraries Used:** `@aws-sdk/client-s3`, `@aws-sdk/lib-storage` (for multipart uploads).
- **Region:** Set to `auto` as required by Cloudflare R2.
