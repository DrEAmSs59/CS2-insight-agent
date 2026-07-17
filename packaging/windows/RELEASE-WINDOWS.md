# Windows release (maintainer)

正式 Windows 产品是 Electron + NSIS。`release-windows.yml` 与本地标准命令现在走同一条
`electron:build:ver` 链路，不再把历史 Inno/browser staging 当成正式 release。

最终用户不需要安装 Python、Rust、Polars 或 PyArrow；Python 与 lean demoparser 都会嵌入安装包。

如果仓库配置了 `WINDOWS_PFX_BASE64` 与 `WINDOWS_PFX_PASSWORD`，workflow 会把它们传给
electron-builder，对 NSIS 安装包签名；未配置时维持当前 unsigned 构建行为。

## Version file before packaging

From repo root (PowerShell), after choosing semver from git tag:

```powershell
./packaging/windows/write-release-version.ps1 -Version $env:GITHUB_REF_NAME
```

(`GITHUB_REF_NAME` is like `v1.2.3` on tag builds. The GitHub Actions `Release Windows` workflow runs this automatically before the Electron build.)

## Cut a release

1. Ensure `frontend` dependencies are locked (`npm ci`).
2. Tag: `git tag v1.2.3 && git push origin v1.2.3`（大小写 `V1.2.3` 也会触发）。
3. Workflow `Release Windows` builds and uploads:
   - `CS2.Insight.Agent.Setup.1.2.3.exe`
   - `CS2.Insight.Agent.Setup.1.2.3.exe.blockmap`
   - `latest.yml`
   - `runtime-size-report.json`
   - `SHA256SUMS`

安装包、blockmap 与 `latest.yml` 必须来自同一次 electron-builder 构建；不要在构建后单独改名或修改安装包，否则自动更新元数据会失效。

## Local smoke (unsigned)

1. Build the lean demoparser wheel with CPython 3.12（与 Electron 内嵌 Python 一致）：

```powershell
$meta = Get-Content ./packaging/demoparser-lean/demoparser-runtime.json -Raw | ConvertFrom-Json
$python312 = py -3.12 -c "import sys; print(sys.executable)"
& $python312 -m pip install "maturin==$($meta.maturin_version)"
./packaging/demoparser-lean/build-wheel.ps1 -PythonExe $python312 -OutputDir dist/wheels
```

2. Build the actual Electron product:

```powershell
$env:CS2_INSIGHT_DEMOPARSER_WHEEL = (Get-ChildItem ./dist/wheels/demoparser2-*-cp312-*.whl | Select-Object -First 1).FullName
$env:ELECTRON_REFRESH_PYTHON = "1"
./packaging/windows/write-release-version.ps1 -Version 0.0.0
Push-Location frontend
npm ci
npm.cmd run electron:build:ver -- 0.0.0
Pop-Location
```

构建会去掉 Polars/PyArrow、Python 调试符号、pip/setuptools/wheel 与测试文件，同时保留 pandas/numpy 等当前业务代码实际使用的依赖。

3. Verify and report the packaged runtime:

```powershell
$py = Resolve-Path ./frontend/dist_electron/win-unpacked/resources/python/python.exe
$backend = Resolve-Path ./frontend/dist_electron/win-unpacked/resources/backend
$env:PYTHONNOUSERSITE = "1"
& $py -c "import sys; sys.path.insert(0, sys.argv[1]); import app.main, demoparser2, importlib.metadata as m, importlib.util as u; assert u.find_spec('polars') is None; assert u.find_spec('pyarrow') is None; print(m.version('demoparser2'))" $backend
./packaging/windows/report-runtime-size.ps1 -Root frontend/dist_electron/win-unpacked/resources -OutputPath dist/runtime-size-report.json
```

CI 根据当前实测结果设置两道回归预算：unpacked `resources` 不超过 `180 MiB`，NSIS 安装包不超过 `175 MiB`。
超过任一上限都会中止 release，而不是悄悄把重量加回来。

`bootstrap-staging.ps1` 与 `CS2InsightAgent.iss` 暂时保留为 legacy/manual 工具，但不属于正式发布真源。

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
