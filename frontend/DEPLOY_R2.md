# Cloudflare R2 Deployment Guide

`npm run deploy:r2` 将 **Tauri NSIS** 构建产物与更新清单上传到 Cloudflare R2，供应用内 `tauri-plugin-updater` 在线更新使用。

## Prerequisites

```bash
export R2_ENDPOINT="https://<your-account-id>.r2.cloudflarestorage.com"
export R2_ACCESS_KEY_ID="<your-access-key-id>"
export R2_SECRET_ACCESS_KEY="<your-secret-access-key>"
export R2_BUCKET="<your-bucket-name>"
# 可选：R2 公共访问域名（默认 pub-89edf85ff1b84f7bac561f78ec51f15b.r2.dev）
export R2_PUBLIC_BASE_URL="https://pub-xxxxxxxx.r2.dev"
# 可选：本次更新说明，会写入 latest.json 的 notes 字段
export RELEASE_NOTES="修复 xxx"
```

## How to Deploy

1. **构建并签名**（`desktop:build:ver` 自动使用 `%USERPROFILE%\.tauri\cs2-insight-agent.key` 生成 `.sig`，详见 `packaging/windows/RELEASE-WINDOWS.md`）：

   ```powershell
   npm.cmd run desktop:build:ver -- <version>
   ```

2. **上传**：

   ```bash
   npm run deploy:r2
   ```

## What gets uploaded?

从 `frontend/src-tauri/target/release/bundle/nsis/` 上传：

- `CS2 Insight Agent_<ver>_x64-setup.exe`：完整安装包，同时是 Tauri updater 的更新包。
- `latest.json`：Tauri updater 版本清单（内嵌同名 `.sig` 文件的更新签名），
  客户端端点为 `<R2_PUBLIC_BASE_URL>/latest.json`。
- `latest.yml`：electron-updater 桥接清单。仍在旧 Electron 版本上的用户会把
  Tauri 安装包当作普通更新下载并以 `/S` 静默执行，NSIS 升级 hook 负责完成
  数据迁移与旧版卸载（用户数据保留在 `%APPDATA%`）。

## Technical Details

- **Script Location:** `frontend/scripts/deploy-r2.mjs`
- **Libraries Used:** `@aws-sdk/client-s3`, `@aws-sdk/lib-storage`（multipart 上传）。
- **Region:** Cloudflare R2 要求 `auto`。
- 安装包按「同名同大小即跳过」增量上传；两个清单文件每次都覆盖上传。
