# Windows release (maintainer)

正式 Windows 产品是 **Tauri 2 + NSIS**。桌面壳使用系统 WebView2，负责显示 React 前端、启动与回收内嵌 Python 后端，以及提供窗口、目录选择和外链能力。

Python 后端、Pillow、pandas、NumPy 与 demoparser2 等既有运行时依赖保持原样打入 resources。发布链继续使用仓库原有的 lean demoparser wheel，避免重新引入 Polars/PyArrow；本轮不改变 Demo 分析行为。应用内自动更新使用 `tauri-plugin-updater`，更新清单与安装包托管在 Cloudflare R2（见下文「在线更新」）。

如果仓库配置了 `WINDOWS_PFX_BASE64` 与 `WINDOWS_PFX_PASSWORD`，GitHub Actions 会把 PFX 导入临时证书库，并让 Tauri 对主程序和 NSIS 安装包执行 Authenticode 签名；未配置时仍允许产出 unsigned 开发包。

## Cut a release

1. 确保 `frontend/pnpm-lock.yaml` 与 `frontend/src-tauri/Cargo.lock` 已更新。
2. 推送 semver tag：`git tag v1.2.3 && git push origin v1.2.3`（`V1.2.3` 也会触发）。
3. `Release Windows` workflow 构建并上传 Tauri NSIS 安装包、`runtime-size-report.json` 与 `SHA256SUMS`。

## 在线更新（Tauri updater + Cloudflare R2）

应用内更新走 `tauri-plugin-updater`，客户端启动时按配置频率请求
`https://pub-7920152f7eff45c19b5a1750e55acd42.r2.dev/latest.json`（`tauri.conf.json > plugins.updater.endpoints`）。

1. **更新签名密钥（一次性）**：`node node_modules/@tauri-apps/cli/tauri.js signer generate -w %USERPROFILE%\.tauri\cs2-insight-agent.key`。
   公钥写入 `tauri.conf.json > plugins.updater.pubkey`；私钥务必备份，丢失后老客户端将无法再接受任何更新。
2. **构建时签名**：`desktop:build:ver` 会自动使用 `%USERPROFILE%\.tauri\cs2-insight-agent.key`（空密码），并在 NSIS 包旁生成 `.sig` 更新签名：

```powershell
pnpm.cmd run desktop:build:ver -- 2.4.0
```

   CI 或自定义密钥路径时改用环境变量 `TAURI_SIGNING_PRIVATE_KEY`（密钥内容或文件路径均可）与 `TAURI_SIGNING_PRIVATE_KEY_PASSWORD`。注意 PowerShell 无法设置「空字符串」环境变量（`$env:X = ""` 等于删除），空密码密钥请交给 `desktop:build:ver` 处理或在 CI YAML 中设置。

3. **发布**：设置 R2 凭据（`R2_ENDPOINT` / `R2_ACCESS_KEY_ID` / `R2_SECRET_ACCESS_KEY` / `R2_BUCKET`，可选 `R2_PUBLIC_BASE_URL`、`RELEASE_NOTES`、`UPDATE_MODE=force|normal`）后执行 `pnpm run deploy:r2`。脚本会上传：
   - `CS2 Insight Agent_<ver>_x64-setup.exe` — 完整安装包，同时是更新包；
   - `latest.json` — Tauri updater 清单（内嵌 `.sig` 签名，含 `update_mode`）；
   - `latest.yml` — electron-updater 桥接清单：仍在旧 Electron 版上的用户会把 Tauri 安装包当作更新静默安装，完成一次性迁移。

客户端每次启动都会检查更新。`update_mode=normal` 时可「立即更新 / 稍后再说」；`force` 时弹窗说明「本次更新涉及重大内容，必需更新才能使用」，只能立即更新。

Windows 端更新流程：下载校验签名 → 应用自动退出 → NSIS 以 passive 模式安装（安装 hook 会等待后端进程退出）→ 自动重启。Authenticode 证书签名（`WINDOWS_PFX_*`）与更新签名互相独立，两者都建议配置。

## 指定版本本地打包（含 skin-core）

若本机把私有仓库 `CS2-demo-anyskin` 放在与 Insight **同级**目录，可用一键脚本做两轮打包：先产出 Agent PE 供 allowlist，再编译/注入 `skin-core.exe`，最后打出带 sidecar 的 NSIS 安装包（**不**把 anyskin 源码打进本仓库）。

```powershell
# 仓库根目录
powershell -ExecutionPolicy Bypass -File .\packaging\windows\build_desktop_with_skin_core.ps1 -Version 2.4.0

# 或
.\packaging\windows\build_desktop_with_skin_core.bat 2.4.0
```

常用参数：`-SkipPack`（跳过 UPX）、`-ReuseExistingAgent`（复用已有 `target\release` Agent）、`-AnyskinRoot <path>`、`-UpxPath <upx.exe>`。详见脚本头注释。

## 指定版本本地打包

正式包使用版本覆盖入口，不需要手工修改 `package.json`、`Cargo.toml` 和 `tauri.conf.json`：

```powershell
Push-Location frontend
try {
  pnpm.cmd run desktop:build:ver -- 2.4.0
} finally {
  Pop-Location
}
```

`desktop:build:ver` 会把同一版本传给三个位置：Vite 的 `__APP_VERSION__`、Tauri/NSIS 的文件与产品版本、内置后端的 `app/release_version.txt`。构建日志中的 pnpm/Cargo manifest 版本仍可能显示仓库默认值，最终版本以安装包文件属性和上述 `release_version.txt` 为准。

发布构建不要使用不带版本的 `pnpm run desktop:build`；该命令只使用仓库默认版本，仅适合本地验证完整安装链。日常开发应使用 `desktop:dev`，提交前的无安装包检查使用 `desktop:check`。正式产物固定输出到：

```text
frontend/src-tauri/target/release/bundle/nsis/CS2 Insight Agent_<version>_x64-setup.exe
```

如果需要从锁定依赖重建正式精简 Python runtime，先构建 lean wheel，再强制刷新：

```powershell
$version = "2.4.0"
$python312 = py -3.12 -c "import sys; print(sys.executable)"
uv sync --frozen
./packaging/demoparser-lean/build-wheel.ps1 -PythonExe $python312 -OutputDir dist/wheels

$env:CS2_INSIGHT_DEMOPARSER_WHEEL = (Get-ChildItem ./dist/wheels/demoparser2-*-cp312-*.whl | Select-Object -First 1).FullName
$env:CS2_INSIGHT_REFRESH_PYTHON = "1"
Push-Location frontend
try {
  pnpm install --frozen-lockfile
  pnpm.cmd run desktop:build:ver -- $version
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
$python312 = py -3.12 -c "import sys; print(sys.executable)"
uv sync --frozen
./packaging/demoparser-lean/build-wheel.ps1 -PythonExe $python312 -OutputDir dist/wheels
```

2. 构建 Tauri NSIS 安装包：

```powershell
$env:CS2_INSIGHT_DEMOPARSER_WHEEL = (Get-ChildItem ./dist/wheels/demoparser2-*-cp312-*.whl | Select-Object -First 1).FullName
$env:CS2_INSIGHT_REFRESH_PYTHON = "1"
Push-Location frontend
pnpm install --frozen-lockfile
pnpm.cmd run desktop:build:ver -- 0.0.0
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

CI 预算：嵌入 resources 不超过 `120 MiB`，NSIS 安装包不超过 `45 MiB`，预计安装占用不超过 `120 MiB`。超过上限会中止 release。

## skin-core.exe（闭源 sidecar）

`skin-core.exe` **不在本仓库构建**；由闭源 `CS2-demo-anyskin` 产出后在打包时显式注入。只有设置 `CS2_SKIN_CORE_EXE` 时，`desktop:stage-resources` 才会复制它到 `frontend/src-tauri/bundle-resources/tools/skin-core.exe`；普通构建不会再从同级私有仓库静默拾取旧产物，缺失时 OSS CI 仍可正常构建。正式发布前请把本版主程序（及建议包含的 bundled `python.exe`）PE SHA-256 写入 skin-core 的父进程 allowlist，并用 anyskin `release-skin-core.ps1 -ParentPe ... -Pack` 产出 **release-ship + UPX** 的 `dist/skin-core.exe` 再注入（免费加固/加壳；非商业壳替代品）。

Tauri 正式发布复用 `package_portable.ps1` 的 Python staging 能力。

## Free 2.8.3 打包记录 · 2026-11-14

- 应用基线：Free `develop` 的 `47c01f1a682149e539d9caedc0b2f126607dc43a`，加 insight11/fixed8 移植；包含 Python 运行时门禁、锁定依赖、可重建补丁及独立 DEM 工具的字段解码/编码修复。
- AnySkin：远端 `main` 的 `9e38d2ed45b1d1854e39a6e7f27cf7ce1703ddd5`，直接使用上游发布脚本，生成本次最终宿主白名单。
- 解析器：`demoparser2-0.41.4+cs2insight11-cp312-cp312-win_amd64.whl`，CPU revision `demotracer-21f6a9b-insight-cpu1-fixed8`。
- wheel SHA256：`a4b8b584201d9710fe8c2bbeff4144748539bef595c66d75f61cbd8d897ccada`，与 Pro 已发布字节一致。
- 已按所有者指令发布到 [Free 解析器 Release](https://github.com/DrEAmSs59/CS2-insight-agent/releases/tag/demoparser-runtime-v0.41.4-cs2insight11-r1)，保留 prerelease / 非 latest；wheel 与 `demoparser2-SHA256SUMS.txt` 已匿名下载复验。
- 技术维护说明见 [insight11 与配套 DEM 工具](../../docs/dev-setup.zh-CN.md#insight11-与配套-dem-工具)。安装包结果和未测范围另在本节补全；解析器发布不代表安装包已发布。- 最终本地安装包：CS2 Insight Agent_2.8.3_x64-setup.exe，109320715 bytes（104.26 MiB）；SHA256：6a3f32310519525b7fc4745cc3d048ce15eba5c9364837fdcdaa77ed899acbf0。
- 最终 Agent SHA256：dc886f650575c0d49d2fd83308f5e7278f00b137a3623482f3c923270cb381a4；bundled Python SHA256：651e2230e6f02b233b46c0f829f08df95864d8155e41802c4609fc4aab45c843。对应白名单已重新编译进最终 Skin Core，随后仅重打包 NSIS。
- updater 公钥验签通过；安装包和 Agent 的 ProductVersion/FileVersion 均为 2.8.3。未配置 Authenticode 证书签名。
- 最终安装包解包后逐文件核对 3613 个资源；隔离后端健康接口返回 status=ok/version=2.8.3，解包后的 Skin Core schemas 1/2/3 加密 IPC 通过。无 3D 检视器或 HLAE native-runtime。
- 源码验证：51 项后端解析器/饰品/IPC 测试、1 项 fixed8 字段边界测试、8 项 Python staging 测试和 12 项前端边界/打包测试通过。新版 AnySkin 空 loadout 错误文案增加 badge，Free 校验器已与 Pro 对齐，未放宽精确匹配或父进程门禁。
- 体积：resources=196.32 MiB，安装包=104.26 MiB，预计安装文件至少 252.96 MiB，超过本文旧预算 150/70/180 MiB；预算未通过。保留完整既有功能资源，未为缩小体积删减。
- 范围：仅生成本地安装包；未上传安装包或更新客户端 feed，未执行实际安装/升级、GUI、真实 Demo 改写和 OBS 实录验收。解析器 Release 发布与上述本地包验收范围分开记录。
### Free 2.8.3 发布 · 2026-11-15

所有者明确授权发布上述既有安装包，采用 normal 更新模式及四条修复说明，并在上传完成后将 Free develop 合并进 main。本次未重建安装包，原安装/升级、GUI 和游戏实测未执行的范围保持不变。

- R2：仅使用 Free 的 `cs2-insight-agent-updates` 桶；先备份旧 `latest.json` / `latest.yml`，安装包采用不覆盖已有对象的条件上传，公开下载 SHA256 验证后才通过 ETag 条件写入两个更新清单。上传和公开下载均设置两小时超时。
- [Free 普通更新清单](https://pub-7920152f7eff45c19b5a1750e55acd42.r2.dev/latest.json)：version=2.8.3、update_mode=normal，四条修复说明与所有者提供的文本一致；`latest.yml` 的版本、安装包大小和 SHA512 与同一文件匹配。
- [GitHub V2.8.3](https://github.com/DrEAmSs59/CS2-insight-agent/releases/tag/V2.8.3)：正式 latest Release，上传安装包、updater `.sig` 和 `SHA256SUMS`。标签指向实际构建源码提交 `de636e713f5dd7742a8a6e0a8da2320144e91665`，后续发布记录不改变构建来源。
- R2 与 GitHub 的匿名公开下载均为 109320715 bytes，SHA256 均为 `6a3f32310519525b7fc4745cc3d048ce15eba5c9364837fdcdaa77ed899acbf0`，与已验本地最终包一致。
- 发布记录只保留公开包身份、校验结果及清单备份；上传凭据未写入仓库或可分发产物。主程序发布不修改 Pro 或 HLAE 通道。