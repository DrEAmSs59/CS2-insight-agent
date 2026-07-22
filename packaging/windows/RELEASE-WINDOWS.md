# Windows release (maintainer)

正式 Windows 产品是 **Tauri 2 + NSIS**。桌面壳使用系统 WebView2，负责显示 React 前端、启动与回收内嵌 Python 后端，以及提供窗口、目录选择和外链能力。

Python 后端、Pillow、pandas、NumPy 与 demoparser2 等既有运行时依赖保持原样打入 resources。发布链继续使用仓库原有的 lean demoparser wheel，避免重新引入 Polars/PyArrow；本轮不改变 Demo 分析行为。应用内自动更新暂不提供，新版本统一从 GitHub Releases 下载。

如果仓库配置了 `WINDOWS_PFX_BASE64` 与 `WINDOWS_PFX_PASSWORD`，GitHub Actions 会把 PFX 导入临时证书库，并让 Tauri 对主程序和 NSIS 安装包执行 Authenticode 签名；未配置时仍允许产出 unsigned 开发包。

## Cut a release

1. 确保 `frontend/package-lock.json` 与 `frontend/src-tauri/Cargo.lock` 已更新。
2. 推送 semver tag：`git tag v1.2.3 && git push origin v1.2.3`（`V1.2.3` 也会触发）。
3. `Release Windows` workflow 构建并上传 Tauri NSIS 安装包、`runtime-size-report.json` 与 `SHA256SUMS`。

当前发布链不生成 `latest.yml` 或 `blockmap`，也不运行后台更新器。

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
