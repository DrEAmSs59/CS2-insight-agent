# Windows release (maintainer)

正式 Windows 产品是 **Tauri 2 + NSIS**。桌面壳使用系统 WebView2，负责显示 React 前端、启动与回收内嵌 Python 后端，以及提供窗口、目录选择和外链能力。

Python 后端、Pillow、pandas、NumPy 与 demoparser2 等既有运行时依赖保持原样打入 resources。发布链继续使用仓库原有的 lean demoparser wheel，避免重新引入 Polars/PyArrow；本轮不改变 Demo 分析行为。应用内自动更新暂不提供，新版本统一从 GitHub Releases 下载。

如果仓库配置了 `WINDOWS_PFX_BASE64` 与 `WINDOWS_PFX_PASSWORD`，GitHub Actions 会把 PFX 导入临时证书库，并让 Tauri 对主程序和 NSIS 安装包执行 Authenticode 签名；未配置时仍允许产出 unsigned 开发包。

## Cut a release

1. 确保 `frontend/package-lock.json` 与 `frontend/src-tauri/Cargo.lock` 已更新。
2. 推送 semver tag：`git tag v1.2.3 && git push origin v1.2.3`（`V1.2.3` 也会触发）。
3. `Release Windows` workflow 构建并上传 Tauri NSIS 安装包、`runtime-size-report.json` 与 `SHA256SUMS`。

当前发布链不生成 `latest.yml` 或 `blockmap`，也不运行后台更新器。

## 指定版本本地打包

正式包使用版本覆盖入口，不需要手工修改 `package.json`、`Cargo.toml` 和 `tauri.conf.json`：

```powershell
Push-Location frontend
try {
  npm.cmd run desktop:build:ver -- 2.4.0
} finally {
  Pop-Location
}
```

`desktop:build:ver` 会把同一版本传给三个位置：Vite 的 `__APP_VERSION__`、Tauri/NSIS 的文件与产品版本、内置后端的 `app/release_version.txt`。构建日志中的 npm/Cargo manifest 版本仍可能显示仓库默认值，最终版本以安装包文件属性和上述 `release_version.txt` 为准。

发布构建不要使用不带版本的 `npm run desktop:build`；该命令只使用仓库默认版本，适合日常 smoke build。产物固定输出到：

```text
frontend/src-tauri/target/release/bundle/nsis/CS2 Insight Agent_<version>_x64-setup.exe
```

如果需要从锁定依赖重建正式精简 Python runtime，先构建 lean wheel，再强制刷新：

```powershell
$version = "2.4.0"
$meta = Get-Content ./packaging/demoparser-lean/demoparser-runtime.json -Raw | ConvertFrom-Json
$python312 = py -3.12 -c "import sys; print(sys.executable)"
& $python312 -m pip install "maturin==$($meta.maturin_version)"
./packaging/demoparser-lean/build-wheel.ps1 -PythonExe $python312 -OutputDir dist/wheels

$env:CS2_INSIGHT_DEMOPARSER_WHEEL = (Get-ChildItem ./dist/wheels/demoparser2-*-cp312-*.whl | Select-Object -First 1).FullName
$env:CS2_INSIGHT_REFRESH_PYTHON = "1"
Push-Location frontend
try {
  npm ci
  npm.cmd run desktop:build:ver -- $version
} finally {
  Pop-Location
}
```

正式交付前至少确认：安装包版本、内置 `release_version.txt`、lean `demoparser2` 可导入、Polars/PyArrow 未打入，以及 resources / 安装包 / 预计安装占用分别不超过 `150 / 70 / 180 MiB`。本地未配置证书时产物是 unsigned；CI 配置 `WINDOWS_PFX_BASE64` 和 `WINDOWS_PFX_PASSWORD` 后会自动签名。

Windows GNU 构建的主程序会动态加载同目录的 `WebView2Loader.dll`。`tauri-build` 只会把它放到 `target/release`，项目 NSIS hook 负责把它写入 `$INSTDIR`；`desktop:build:ver` 会在构建结束后同时检查 DLL、hook、生成的 NSIS 脚本和安装包，缺失时直接让构建失败。验收安装目录时必须确认 `cs2-insight-agent-desktop.exe` 与 `WebView2Loader.dll` 同级。

## Electron → Tauri 原位升级

旧 Electron 可以安装在 `C:\Program Files\CS2 Insight Agent`，Tauri 的 `currentUser` 安装默认位于 `%LOCALAPPDATA%\CS2 Insight Agent`。程序目录不同是预期行为；持久化数据统一落在 `%APPDATA%\CS2 Insight Agent\data`，不依赖程序安装目录。

NSIS 升级桥按以下顺序执行，任何迁移或校验失败都会中止，且不会先卸载旧程序：

1. 要求 Electron、Tauri 和内置后端均已正常退出。
2. 通过仍在的 Electron 渲染器导出主题、LiteCut 面板布局、最近项目和未保存恢复草稿；原始 Local/Session Storage 同时归档，并等待旧后端完全退出。
3. 把 Electron 的配置、SQLite（含已提交 WAL）、日志、备份、LiteCut 素材与项目数据复制到暂存目录并校验。
4. 原子切换为 Tauri 数据目录，合并界面状态并写入幂等迁移标记。
5. 新安装及数据校验全部成功后，才静默卸载 Electron；旧 `%APPDATA%\cs2-insight-agent` 数据源仍保留作人工恢复兜底。

测试升级包时应使用真实的上一版 Electron 安装，而不是只做 Tauri 覆盖安装。至少核对 Demo 历史、配置、LiteCut 项目/素材、备份、主题和恢复草稿，并确认桌面快捷方式最终只指向 `cs2-insight-agent-desktop.exe`。

## Local smoke (unsigned)

1. 用 CPython 3.12 构建仓库原有的 lean demoparser wheel：

```powershell
$meta = Get-Content ./packaging/demoparser-lean/demoparser-runtime.json -Raw | ConvertFrom-Json
$python312 = py -3.12 -c "import sys; print(sys.executable)"
& $python312 -m pip install "maturin==$($meta.maturin_version)"
./packaging/demoparser-lean/build-wheel.ps1 -PythonExe $python312 -OutputDir dist/wheels
```

2. 构建 Tauri NSIS 安装包：

```powershell
$env:CS2_INSIGHT_DEMOPARSER_WHEEL = (Get-ChildItem ./dist/wheels/demoparser2-*-cp312-*.whl | Select-Object -First 1).FullName
$env:CS2_INSIGHT_REFRESH_PYTHON = "1"
Push-Location frontend
npm ci
npm.cmd run desktop:build:ver -- 0.0.0
Pop-Location
```

输出位于 `frontend/src-tauri/target/release/bundle/nsis/`。

3. 验证嵌入运行时：

```powershell
$resources = Resolve-Path ./frontend/src-tauri/bundle-resources
$py = Join-Path $resources "python/python.exe"
$backend = Join-Path $resources "backend"
$env:PYTHONNOUSERSITE = "1"
$env:PYTHONDONTWRITEBYTECODE = "1"
& $py -c "import sys; sys.path.insert(0, sys.argv[1]); import app.main, demoparser2, importlib.metadata as m, importlib.util as u, PIL; assert u.find_spec('polars') is None; assert u.find_spec('pyarrow') is None; print(m.version('demoparser2'))" $backend
./packaging/windows/report-runtime-size.ps1 -Root $resources -OutputPath dist/runtime-size-report.json
```

CI 预算：嵌入 resources 不超过 `150 MiB`，NSIS 安装包不超过 `70 MiB`，预计安装占用不超过 `180 MiB`。超过上限会中止 release。

`bootstrap-staging.ps1`、`package_portable.ps1` 与 `CS2InsightAgent.iss` 仍保留为 legacy/manual 工具；Tauri 正式发布仅复用 `package_portable.ps1` 的 Python staging 能力。
