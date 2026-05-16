# Windows release (maintainer)

## Secrets (repository)

- `WINDOWS_PFX_BASE64`: Base64 of a `.pfx` code-signing certificate.
- `WINDOWS_PFX_PASSWORD`: Password for that `.pfx`.

Generate Base64 (PowerShell):

```powershell
[Convert]::ToBase64String([IO.File]::ReadAllBytes("codesign.pfx")) | Set-Clipboard
```

## Version file before packaging

From repo root (PowerShell), after choosing semver from git tag:

```powershell
./packaging/windows/write-release-version.ps1 -Version $env:GITHUB_REF_NAME
```

(`GITHUB_REF_NAME` is like `v1.2.3` on tag builds. The GitHub Actions `Release Windows` workflow runs this automatically before staging bootstrap.)

## Cut a release

1. Ensure `frontend` builds (`npm ci && npm run build`).
2. Tag: `git tag v1.2.3 && git push origin v1.2.3`.
3. Workflow `Release Windows` uploads `CS2InsightAgent-1.2.3-Setup.exe` into `dist/` on the runner, `CS2InsightAgent-1.2.3-windows-amd64.zip` at the repo root, and `SHA256SUMS`.

## Local smoke (unsigned)

1. Build frontend (`npm run build` in `frontend/`).
2. Bootstrap staging:

```powershell
./packaging/windows/bootstrap-staging.ps1
```

Bootstrap 会去掉 Python 自带的 `Lib/test`、头文件 `Include`、各 wheel 里的 `tests` 目录、`backend/tests`、前端 `*.map`，并用 `pip install --no-cache-dir`；再配合 Inno 的 **`lzma2/max`** 压缩，安装包通常可比「未裁剪树 + 默认 lzma2」**再小一截**（具体取决于依赖版本，常见为几十 MB 量级；`Lib/test` 等单独就很大）。

3. Compile with **ISCC.exe**. Default install path:

```powershell
& "${env:ProgramFiles(x86)}\Inno Setup 6\ISCC.exe" /DMyAppVersion=0.0.0 ./packaging/windows/CS2InsightAgent.iss
```

If Inno Setup is elsewhere, get the install folder:

```powershell
reg query "HKLM\SOFTWARE\WOW6432Node\Microsoft\Windows\CurrentVersion\Uninstall\Inno Setup 6_is1" /v InstallLocation
```

Then run `& "<InstallLocation>ISCC.exe" /DMyAppVersion=0.0.0 ./packaging/windows/CS2InsightAgent.iss` from the repo root.

Output: `dist\CS2InsightAgent-<version>-Setup.exe` (for example `dist\CS2InsightAgent-0.0.0-Setup.exe`).

## 检查更新与国内镜像（用户侧）

应用默认 **`update_github_mirror: auto`**（可在设置页修改，或写入 `cs2-insight.config.json`）：

| 值 | 行为 |
| --- | --- |
| `auto` | 内置镜像（`ghfast.top` 等）与 GitHub 直连**并发**，约 8 秒内谁先成功用谁；镜像仅走页面跳转，避免镜像 API 挂起 |
| `on` | 仅通过镜像访问（适合 GitHub 完全打不开的网络） |
| `off` | 仅直连 GitHub |
| `https://…` | 自定义镜像前缀（与内置相同规则：`{前缀}/{完整 GitHub URL}`） |

环境变量（优先级高于配置文件）：`CS2_INSIGHT_UPDATE_MIRROR` 或 `CS2_INSIGHT_GITHUB_MIRROR`；多镜像列表：`CS2_INSIGHT_UPDATE_MIRROR_PRESETS`（逗号分隔）。

成功走镜像时，API 返回的下载链接与 Releases 页面链接也会自动包一层镜像，便于浏览器下载。

## GitHub API token (optional, local / dev)

The in-app update check calls `api.github.com`. Without authentication, GitHub applies a low hourly limit and may return `403 rate limit exceeded`.

Create a **fine-grained Personal Access Token** (recommended):

1. Open [https://github.com/settings/personal-access-tokens/new](https://github.com/settings/personal-access-tokens/new).
2. **Resource owner**: your account. **Repository access**: only `DrEAmSs59/CS2-insight-agent` (or “All” if you prefer).
3. **Permissions → Repository**: enable **Metadata** → **Read-only** (enough to read public release metadata).
4. Generate the token and copy it once.

**Classic token** (alternative): [https://github.com/settings/tokens/new](https://github.com/settings/tokens/new) — for a public repo, generating a token with no extra scopes is often enough for authenticated rate limits.

Set before starting the backend (PowerShell):

```powershell
$env:CS2_INSIGHT_GITHUB_TOKEN = "ghp_...."   # or fine-grained token
```

**Or** put the token in a **gitignored** file at the repo root (first non-empty, non-`#` line):

- Path: **`.cs2-insight-github-token`** (same directory as `backend/`).
- Example content: one line `github_pat_...` (no quotes).

Optional: set **`CS2_INSIGHT_GITHUB_TOKEN_FILE`** to any absolute path; that file is read the same way (first usable line).

Priority: `CS2_INSIGHT_GITHUB_TOKEN` → `GITHUB_TOKEN` → `CS2_INSIGHT_GITHUB_TOKEN_FILE` → `.cs2-insight-github-token`.

Do **not** commit tokens. Cursor / cloud agents **cannot** use a file on your PC unless you run commands in your own environment; keep the file local for your machine and CI secrets only.
