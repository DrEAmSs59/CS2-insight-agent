# 开发环境配置

[English](dev-setup.md) | 简体中文

## 环境要求

- Windows 10 或 Windows 11
- Node.js 22
- pnpm 11.9.0
- uv 0.11.x
- Rust stable（MSVC 工具链）以及 Visual Studio C++ 生成工具
- Microsoft Edge WebView2 Runtime

## 首次配置

在仓库根目录执行：

```powershell
.\packaging\demoparser-lean\setup-backend-dev.ps1

Set-Location frontend
pnpm install --frozen-lockfile
Set-Location ..
```

后端配置脚本会根据 `uv.lock` 创建 `.venv`，并验证项目定制的 Rust
`demoparser2` runtime。如果仓库根目录已经存在用于桌面打包的
`python\python.exe`，该脚本也会检查并修复其中的 `demoparser2`。如果桌面
runtime 尚不存在，配置脚本不会主动创建它。

## 浏览器开发

分别启动后端和前端两个终端。

终端 1，在仓库根目录执行：

```powershell
.\.venv\Scripts\python.exe -m uvicorn app.main:app --app-dir backend --port 8000
```

终端 2：

```powershell
Set-Location frontend
pnpm run dev
```

打开 `http://localhost:5173`。Vite 会把 `/api/*` 请求代理到后端的 `8000`
端口。

## Tauri 桌面端开发

不需要单独启动后端。Tauri 会自动使用仓库中的 `.venv` 启动后端。
这是日常桌面调试的默认入口：React/CSS 修改由 Vite 热更新，不会暂存发布
runtime，也不会生成 NSIS 安装包。

```powershell
Set-Location frontend
pnpm run desktop:dev
```

也可以从仓库根目录直接运行：

```powershell
.\packaging\windows\dev_desktop.bat
```

提交前若只想检查生产前端与 Tauri Rust 壳能否通过编译，同样无需打安装包：

```powershell
pnpm --dir frontend run desktop:check
```

只有需要验证安装、升级、卸载、资源嵌入或正式发布时，才进入下面的 NSIS
打包流程。

## Windows 手动打包

请在仓库根目录打开一个干净的 PowerShell 终端执行发布构建。应使用
`desktop:build:ver`，不要使用 `desktop:build`；前者会把指定版本统一应用到
前端、Tauri/NSIS 元数据和内置后端。

### 完整可复现构建

首次打包、Python 依赖发生变化或所需的 `demoparser2` runtime 版本发生变化
时，请使用以下完整流程。将 `2.4.0` 替换为本次要构建的版本号。

```powershell
$version = "2.4.0"

# 同步 .venv、构建精确版本的定制 Rust wheel，并进行验证。
.\packaging\demoparser-lean\setup-backend-dev.ps1 -BuildFromSource

# 根据共享 runtime 元数据选择所需 wheel。不要随意选择
# demoparser2-*.whl，因为 dist/wheels 中可能还保留着旧版本。
$runtime = Get-Content .\packaging\demoparser-lean\demoparser-runtime.json -Raw |
    ConvertFrom-Json
$wheel = Get-ChildItem -LiteralPath .\dist\wheels -File `
    -Filter "demoparser2-$($runtime.distribution_version)-cp312-cp312-win_amd64.whl" |
    Sort-Object LastWriteTimeUtc -Descending |
    Select-Object -First 1
if (-not $wheel) {
    throw "没有生成所需的定制 demoparser2 wheel。"
}

# 为安装包强制重建仓库根目录下精简的 python\ runtime。
$env:CS2_INSIGHT_DEMOPARSER_WHEEL = $wheel.FullName
$env:CS2_INSIGHT_REFRESH_PYTHON = "1"

Push-Location frontend
try {
    pnpm.cmd install --frozen-lockfile
    if ($LASTEXITCODE -ne 0) { throw "pnpm install 失败。" }

    pnpm.cmd run desktop:build:ver -- $version
    if ($LASTEXITCODE -ne 0) { throw "桌面端构建失败。" }
} finally {
    Pop-Location
    Remove-Item Env:CS2_INSIGHT_DEMOPARSER_WHEEL -ErrorAction SilentlyContinue
    Remove-Item Env:CS2_INSIGHT_REFRESH_PYTHON -ErrorAction SilentlyContinue
}
```

构建流程会依次完成前端生产构建、后端与精简 Python runtime 暂存、Tauri
可执行文件编译、NSIS 安装包生成以及最终 Windows bundle 验证。产物位于：

```text
frontend/src-tauri/target/release/bundle/nsis/CS2 Insight Agent_<version>_x64-setup.exe
frontend/src-tauri/target/release/bundle/nsis/CS2 Insight Agent_<version>_x64-setup.exe.sig
```

只有存在 updater 私钥时才会生成 `.sig` 更新签名。没有私钥时仍然可以在
本地构建安装包。

### 快速重复构建

如果完整构建已经生成了 `python\python.exe`，并且 Python 锁文件及定制解析器
版本均未变化，可以先验证现有 runtime，然后直接重新打包：

```powershell
$version = "2.4.0"
.\packaging\demoparser-lean\setup-backend-dev.ps1

Push-Location frontend
try {
    pnpm.cmd run desktop:build:ver -- $version
    if ($LASTEXITCODE -ne 0) { throw "桌面端构建失败。" }
} finally {
    Pop-Location
}
```

如果该流程提示仓库根目录的 Python runtime 不兼容，请改用上面的“完整可复现
构建”。配置脚本可以修复现有桌面 runtime 中的解析器，而完整流程会重建所有
锁定的 runtime 依赖。

### 可选：Updater 更新签名

在 `frontend` 目录中生成一次 updater 密钥，并妥善备份私钥：

```powershell
Push-Location frontend
try {
    node .\node_modules\@tauri-apps\cli\tauri.js signer generate `
        -w "$env:USERPROFILE\.tauri\cs2-insight-agent.key"
} finally {
    Pop-Location
}
```

`desktop:build:ver` 会自动使用该默认密钥。如果密钥密码非空，请在构建终端中
设置 `TAURI_SIGNING_PRIVATE_KEY_PASSWORD`。Updater 更新签名与 Windows
Authenticode 代码签名相互独立；生产证书配置以及正式发布、上传检查清单请参阅
`packaging/windows/RELEASE-WINDOWS.md`。

## 测试

在仓库根目录执行：

```powershell
uv run --frozen python -m pytest backend/tests -q
pnpm --dir frontend test
cargo test --manifest-path frontend/src-tauri/Cargo.toml --locked
```
