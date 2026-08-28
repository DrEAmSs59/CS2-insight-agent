#Requires -Version 5.1
<#
.SYNOPSIS
  Build frontend, copy backend + web, bundle Python + uv-locked deps (default), zip.

.PARAMETER PortablePythonDir
  If set: copy this folder to .\python\ (must contain python.exe), then install the uv-locked runtime.

.PARAMETER OutDir
  Output folder, default dist\CS2-Insight-Agent-portable

.PARAMETER SkipPnpm
  Skip pnpm install / build (use existing frontend\dist)

.PARAMETER CleanPnpm
  Kill node.exe, delete frontend\node_modules, then pnpm install/build (fixes EPERM on Windows)

.PARAMETER SkipBundlePython
  Do not embed Python; output has no python\ (end users must install Python + deps themselves).

.PARAMETER EmbeddedPythonVersion
  Python embeddable version to download (default 3.12.7). Must match an existing zip on python.org.

.PARAMETER ElectronStagePythonOnly
  Only populate repo-root .\python\ using the same rules as the portable pack.
  Then exit — use before pnpm run electron:build (electron-builder extraResources reads ..\python).

.PARAMETER DemoparserWheel
  Required patched demoparser wheel. It replaces the published wheel from the lock for packaging.

#>
param(
    [string]$PortablePythonDir = "",
    [string]$OutDir = "",
    [Alias("SkipNpm")][switch]$SkipPnpm,
    [Alias("CleanNpm")][switch]$CleanPnpm,
    [switch]$SkipBundlePython,
    [string]$EmbeddedPythonVersion = "3.12.7",
    [switch]$ElectronStagePythonOnly,
    [string]$DemoparserWheel = $env:CS2_INSIGHT_DEMOPARSER_WHEEL
)

$ErrorActionPreference = "Stop"
if ($PSVersionTable.PSVersion.Major -lt 5) { throw "PowerShell 5.1+ required" }

try {
    $Root = (git -C (Split-Path -Parent $MyInvocation.MyCommand.Path) rev-parse --show-toplevel)
    if ($LASTEXITCODE -ne 0) { throw "git rev-parse failed (exit $LASTEXITCODE)" }
    # git rev-parse --show-toplevel may return forward-slash paths on Windows; normalize.
    $Root = $Root -replace '/', '\'
} catch {
    throw "Cannot locate git repository root. Ensure this script is inside a git working tree. Original error: $_"
}
if (-not $OutDir) {
    $OutDir = Join-Path $Root "dist\CS2-Insight-Agent-portable"
}

$ZipPath = "$OutDir.zip"
$Frontend = Join-Path $Root "frontend"
$Backend = Join-Path $Root "backend"
$CacheDir = Join-Path $Root ".packaging-cache"
$ProjectFile = Join-Path $Root "pyproject.toml"
$LockFile = Join-Path $Root "uv.lock"
$Uv = Get-Command uv -ErrorAction SilentlyContinue
if (-not $Uv) { throw "uv 0.11.x is required to build a portable runtime." }

function Write-Step($msg) { Write-Host "`n==> $msg" -ForegroundColor Cyan }

function Ensure-Directory([string]$Path) {
    if (-not (Test-Path $Path)) {
        New-Item -ItemType Directory -Path $Path -Force | Out-Null
    }
}

function Get-EmbeddedPython {
    param(
        [Parameter(Mandatory)][string]$DestDir,
        [Parameter(Mandatory)][string]$Version,
        [Parameter(Mandatory)][string]$CacheDir
    )
    [Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12

    $ZipName = "python-$Version-embed-amd64.zip"
    $Url = "https://www.python.org/ftp/python/$Version/$ZipName"
    $ZipLocal = Join-Path $CacheDir $ZipName

    Ensure-Directory $CacheDir
    if (-not (Test-Path $ZipLocal)) {
        Write-Step "Download embeddable Python $Version (may take a while)"
        Invoke-WebRequest -Uri $Url -OutFile $ZipLocal -UseBasicParsing -TimeoutSec 600
    }

    Write-Step "Extract embeddable Python to python\"
    if (Test-Path $DestDir) { Remove-Item -Recurse -Force $DestDir }
    Ensure-Directory (Split-Path $DestDir -Parent)
    Expand-Archive -Path $ZipLocal -DestinationPath $DestDir -Force

    $pth = Get-ChildItem -Path $DestDir -Filter "*._pth" -File | Select-Object -First 1
    if (-not $pth) { throw "No *._pth file in embeddable Python zip" }

    $lines = Get-Content -Path $pth.FullName
    $zipLine = ($lines | Where-Object { $_ -match '\.zip\s*$' } | Select-Object -First 1)
    if (-not $zipLine) { $zipLine = ($lines | Select-Object -First 1) }
    $pthBody = @(
        $zipLine.Trim()
        '.'
        'Lib\site-packages'
        'import site'
    ) -join [Environment]::NewLine
    [System.IO.File]::WriteAllText($pth.FullName, $pthBody)

    $sitePkgs = Join-Path $DestDir "Lib\site-packages"
    Ensure-Directory $sitePkgs

}

function Install-BackendRequirements {
    param(
        [Parameter(Mandatory)][string]$PythonExe
    )
    $previousNoUserSite = $env:PYTHONNOUSERSITE
    $env:PYTHONNOUSERSITE = "1"
    try {
    if (-not $DemoparserWheel.Trim()) {
        throw "DemoparserWheel is required; refusing to create a runtime with the stock parser."
    }
    $runtimeRequirements = Join-Path ([IO.Path]::GetTempPath()) (
        "cs2-insight-runtime-" + [Guid]::NewGuid().ToString("n") + ".txt"
    )
    Write-Step "Install uv-locked Python runtime (this can take several minutes)"
    & $Uv.Source export --project $Root --frozen --no-dev --no-emit-project `
        --no-emit-package demoparser2 --output-file $runtimeRequirements
    if ($LASTEXITCODE -ne 0) { throw "uv export failed (exit $LASTEXITCODE)" }
    & $Uv.Source pip install --python $PythonExe --requirements $runtimeRequirements --compile-bytecode
    if ($LASTEXITCODE -ne 0) { throw "uv runtime install failed (exit $LASTEXITCODE)" }
    $leanWheel = (Resolve-Path -LiteralPath $DemoparserWheel).Path
    Write-Step "Install patched demoparser wheel"
    # A reused trimmed runtime has no wheel RECORD files, so remove every old
    # parser generation explicitly before installing the required wheel.
    $pythonRoot = Split-Path -Parent $PythonExe
    $sitePackages = Join-Path $pythonRoot "Lib\site-packages"
    Remove-Item -LiteralPath (Join-Path $sitePackages "demoparser2") -Recurse -Force -ErrorAction SilentlyContinue
    Get-ChildItem -LiteralPath $sitePackages -Directory -Filter "demoparser2-*.dist-info" -ErrorAction SilentlyContinue |
        ForEach-Object { Remove-Item -LiteralPath $_.FullName -Recurse -Force }
    & $Uv.Source pip install --python $PythonExe --no-deps $leanWheel --compile-bytecode
    if ($LASTEXITCODE -ne 0) { throw "patched demoparser wheel install failed (exit $LASTEXITCODE)" }
    Remove-Item -LiteralPath $runtimeRequirements -Force -ErrorAction SilentlyContinue
    $leanMeta = Get-Content (Join-Path $Root "packaging\demoparser-lean\demoparser-runtime.json") -Raw | ConvertFrom-Json
    & $PythonExe -c "import importlib.metadata as m, importlib.util as u, sys; from demoparser2 import DemoParser; assert m.version('demoparser2') == sys.argv[1]; assert hasattr(DemoParser, 'decode_smoke_voxel_journal'); assert hasattr(DemoParser, 'write_replay_parquet'); assert hasattr(DemoParser, 'read_replay_parquet_round_binary'); assert u.find_spec('numpy') is None; assert u.find_spec('pandas') is None; assert u.find_spec('polars') is None; assert u.find_spec('pyarrow') is None" $leanMeta.distribution_version
    if ($LASTEXITCODE -ne 0) { throw "patched demoparser runtime verification failed (exit $LASTEXITCODE)" }
    foreach ($rel in @(
        "Scripts",
        "Lib\site-packages\websocket\tests",
        "Lib\site-packages\aiosqlite\tests",
        "Lib\site-packages\colorama\tests",
        "Lib\site-packages\images"
    )) {
        $path = Join-Path $pythonRoot $rel
        if (Test-Path -LiteralPath $path) {
            Remove-Item -LiteralPath $path -Recurse -Force
        }
    }
    & $PythonExe -c "import cryptography, demoparser2, fastapi, openai, PIL, uvicorn"
    if ($LASTEXITCODE -ne 0) { throw "trimmed runtime import verification failed (exit $LASTEXITCODE)" }
    Get-ChildItem -LiteralPath $pythonRoot -Recurse -Directory -Filter "__pycache__" -ErrorAction SilentlyContinue |
        Sort-Object { $_.FullName.Length } -Descending |
        ForEach-Object { Remove-Item -LiteralPath $_.FullName -Recurse -Force -ErrorAction SilentlyContinue }
    Get-ChildItem -LiteralPath $pythonRoot -Recurse -File -Filter "*.pdb" -ErrorAction SilentlyContinue |
        ForEach-Object { Remove-Item -LiteralPath $_.FullName -Force -ErrorAction SilentlyContinue }
    Get-ChildItem -LiteralPath $sitePackages -Recurse -File -Filter "*.pyi" -ErrorAction SilentlyContinue |
        ForEach-Object { Remove-Item -LiteralPath $_.FullName -Force -ErrorAction SilentlyContinue }
    Get-ChildItem -LiteralPath $sitePackages -Recurse -File -Filter "py.typed" -ErrorAction SilentlyContinue |
        ForEach-Object { Remove-Item -LiteralPath $_.FullName -Force -ErrorAction SilentlyContinue }
    Get-ChildItem -LiteralPath $sitePackages -Recurse -File -Filter "RECORD" -ErrorAction SilentlyContinue |
        Where-Object { $_.Directory.Name -like "*.dist-info" } |
        ForEach-Object { Remove-Item -LiteralPath $_.FullName -Force -ErrorAction SilentlyContinue }
    Get-ChildItem -LiteralPath $sitePackages -Recurse -Directory -Filter "sboms" -ErrorAction SilentlyContinue |
        Where-Object { $_.Parent.Name -like "*.dist-info" } |
        Sort-Object { $_.FullName.Length } -Descending |
        ForEach-Object { Remove-Item -LiteralPath $_.FullName -Recurse -Force -ErrorAction SilentlyContinue }
    Get-ChildItem -LiteralPath (Join-Path $sitePackages "PIL") -File -Filter "_avif*.pyd" -ErrorAction SilentlyContinue |
        ForEach-Object { Remove-Item -LiteralPath $_.FullName -Force -ErrorAction SilentlyContinue }
    & $PythonExe -c "from PIL import Image; import cryptography, demoparser2, fastapi, openai, uvicorn; import importlib.util as u; assert u.find_spec('numpy') is None; assert u.find_spec('pandas') is None"
    if ($LASTEXITCODE -ne 0) { throw "final trimmed runtime import verification failed (exit $LASTEXITCODE)" }
    $runtimeFingerprintScript = Join-Path $Root "frontend\scripts\runtime-fingerprint.mjs"
    & node $runtimeFingerprintScript write $pythonRoot
    if ($LASTEXITCODE -ne 0) { throw "runtime fingerprint manifest failed (exit $LASTEXITCODE)" }
    } finally {
        if ($null -eq $previousNoUserSite) {
            Remove-Item Env:PYTHONNOUSERSITE -ErrorAction SilentlyContinue
        } else {
            $env:PYTHONNOUSERSITE = $previousNoUserSite
        }
    }
}

function Bundle-PythonInto {
    param(
        [Parameter(Mandatory)][string]$PythonDestDir
    )
    if ($PortablePythonDir.Trim()) {
        $PySrc = (Resolve-Path $PortablePythonDir).Path
        $PyExeSrc = Join-Path $PySrc "python.exe"
        if (-not (Test-Path $PyExeSrc)) {
            throw "python.exe not found under PortablePythonDir: $PyExeSrc"
        }
        Write-Step "Copy portable Python into: $PythonDestDir"
        if (Test-Path $PythonDestDir) { Remove-Item -Recurse -Force $PythonDestDir }
        Ensure-Directory (Split-Path $PythonDestDir -Parent)
        robocopy $PySrc $PythonDestDir /E /NFL /NDL /NJH /NJS /nc /ns /np `
            /XD __pycache__ .git | Out-Null
        if ($LASTEXITCODE -ge 8) { throw "robocopy python failed (exit $LASTEXITCODE)" }
        Install-BackendRequirements -PythonExe (Join-Path $PythonDestDir "python.exe")
    }
    elseif (-not $SkipBundlePython) {
        Get-EmbeddedPython -DestDir $PythonDestDir -Version $EmbeddedPythonVersion -CacheDir $CacheDir
        Install-BackendRequirements -PythonExe (Join-Path $PythonDestDir "python.exe")
    }
    else {
        throw "Bundle-PythonInto: set PortablePythonDir or clear -SkipBundlePython"
    }
}

if (-not (Test-Path $Backend)) { throw "backend folder not found: $Backend" }
if (-not (Test-Path $ProjectFile)) { throw "pyproject.toml not found: $ProjectFile" }
if (-not (Test-Path $LockFile)) { throw "uv.lock not found: $LockFile" }

if ($ElectronStagePythonOnly) {
    if ($SkipBundlePython -and -not ($PortablePythonDir.Trim())) {
        throw "ElectronStagePythonOnly: use -PortablePythonDir (or omit -SkipBundlePython for embeddable download)."
    }
    $electronPy = Join-Path $Root "python"
    Write-Step "Electron: stage repo-root python\ (same bundle logic as portable package)"
    Bundle-PythonInto -PythonDestDir $electronPy
    Write-Host ""
    Write-Host "Done: $electronPy" -ForegroundColor Green
    Write-Host "Next:  cd frontend" -ForegroundColor Yellow
    Write-Host "       pnpm run electron:build" -ForegroundColor Yellow
    exit 0
}

# --- frontend build ---
if (-not $SkipPnpm) {
    $Pnpm = Get-Command pnpm.cmd -ErrorAction SilentlyContinue
    if (-not $Pnpm) { $Pnpm = Get-Command pnpm -ErrorAction SilentlyContinue }
    if (-not $Pnpm) { throw "pnpm 11.9.0 is required to build the frontend." }
    if ($CleanPnpm) {
        Write-Step "CleanPnpm: stop node.exe, remove frontend\node_modules"
        Get-Process -Name node -ErrorAction SilentlyContinue | Stop-Process -Force -ErrorAction SilentlyContinue
        Start-Sleep -Seconds 1
        $nm = Join-Path $Frontend "node_modules"
        if (Test-Path $nm) {
            Remove-Item -Recurse -Force $nm
        }
    }
    Write-Step "pnpm install --frozen-lockfile / pnpm run build (frontend)"
    Push-Location $Frontend
    try {
        & $Pnpm.Source install --frozen-lockfile
        if ($LASTEXITCODE -ne 0) {
            throw "pnpm install failed (exit $LASTEXITCODE). Try closing editors/antivirus, or run with -CleanPnpm."
        }
        & $Pnpm.Source run build
        if ($LASTEXITCODE -ne 0) {
            throw "pnpm run build failed (exit $LASTEXITCODE)."
        }
    } finally {
        Pop-Location
    }
}

$DistWeb = Join-Path $Frontend "dist"
if (-not (Test-Path (Join-Path $DistWeb "index.html"))) {
    throw "Missing frontend\dist\index.html — run pnpm run build in frontend first."
}

# --- output dir ---
Write-Step "Prepare output: $OutDir"
if (Test-Path $OutDir) {
    Remove-Item -Recurse -Force $OutDir
}
New-Item -ItemType Directory -Path $OutDir -Force | Out-Null

# --- backend ---
Write-Step "Copy backend"
$DestBackend = Join-Path $OutDir "backend"
robocopy $Backend $DestBackend /E /NFL /NDL /NJH /NJS /nc /ns /np `
    /XD __pycache__ .venv venv .git .mypy_cache .pytest_cache `
    | Out-Null
if ($LASTEXITCODE -ge 8) { throw "robocopy backend failed (exit $LASTEXITCODE)" }

Copy-Item -LiteralPath $ProjectFile -Destination (Join-Path $OutDir "pyproject.toml") -Force
Copy-Item -LiteralPath $LockFile -Destination (Join-Path $OutDir "uv.lock") -Force

# --- web static files ---
Write-Step "Copy frontend dist into web/"
$DestWeb = Join-Path $OutDir "web"
robocopy $DistWeb $DestWeb /E /NFL /NDL /NJH /NJS /nc /ns /np | Out-Null
if ($LASTEXITCODE -ge 8) { throw "robocopy web failed (exit $LASTEXITCODE)" }

# --- Recording assets: compiled skybox pairs and experimental POV HUD ---
$PovSrc = Join-Path $Root "pov"
$PovHasAssets = (
    (Test-Path (Join-Path $PovSrc "pov.vpk")) -or
    (Test-Path (Join-Path $PovSrc "pov_default.vpk")) -or
    (Test-Path (Join-Path $PovSrc "skyboxes")) -or
    (Test-Path (Join-Path $PovSrc "map_materials"))
)
$DestPov = Join-Path $OutDir "pov"
if ($PovHasAssets) {
    Write-Step "Copy pov/ (POV HUD assets)"
    robocopy $PovSrc $DestPov /E /NFL /NDL /NJH /NJS /nc /ns /np | Out-Null
    if ($LASTEXITCODE -ge 8) { throw "robocopy pov failed (exit $LASTEXITCODE)" }
}
else {
    Write-Host "跳过 pov/：未找到 POV HUD、地图材质或天空盒资源目录，便携包内将无法安装录制 VPK。" -ForegroundColor Yellow
}

# --- data/（示例配置、OBS basic.ini 等；排除本机 SQLite、用户配置、备份与日志）---
$DataSrc = Join-Path $Root "data"
$DestData = Join-Path $OutDir "data"
if (Test-Path $DataSrc) {
    Write-Step "Copy data/ (templates; excluding db, user config, backups, logs)"
    robocopy $DataSrc $DestData /E /NFL /NDL /NJH /NJS /nc /ns /np `
        /XD .cs2_config_backup .obs_config_backups logs `
        /XF cs2-insight.config.json cs2-insight.db cs2-insight.db-wal cs2-insight.db-shm `
        | Out-Null
    if ($LASTEXITCODE -ge 8) { throw "robocopy data failed (exit $LASTEXITCODE)" }
    if (-not (Test-Path (Join-Path $DestData "cs2-insight.config.example.json"))) {
        Write-Host "警告：打包结果缺少 data/cs2-insight.config.example.json（仓库 data 目录是否齐全？）" -ForegroundColor Yellow
    }
    if (-not (Test-Path (Join-Path $DestData "basic.ini"))) {
        Write-Host "警告：打包结果缺少 data/basic.ini（OBS 内置预设路径依赖该文件）。" -ForegroundColor Yellow
    }
}
else {
    Write-Host "跳过 data/：仓库根目录无 data 文件夹。" -ForegroundColor Yellow
}

# --- Python runtime + deps ---
$DestPy = Join-Path $OutDir "python"
$BundledPython = $false

if ($PortablePythonDir.Trim()) {
    Bundle-PythonInto -PythonDestDir $DestPy
    $BundledPython = $true
}
elseif (-not $SkipBundlePython) {
    Bundle-PythonInto -PythonDestDir $DestPy
    $BundledPython = $true
}

# --- batch files + readme ---
Write-Step "Write batch files and README"

if ($BundledPython) {
    $StartBat = @'
@echo off
setlocal
set "ROOT=%~dp0"

rem ===== 后端 HTTP 端口（浏览器打开地址、uvicorn、CS2 GSI 均读取此变量；只改下一行）=====
set "CS2_INSIGHT_PORT=19871"
rem ================================================================================

if not exist "%ROOT%python\python.exe" (
  echo [错误] 缺少 python\python.exe，请重新解压完整发行包。
  pause
  exit /b 1
)

cd /d "%ROOT%backend" 2>nul
if errorlevel 1 (
  echo [错误] 找不到 backend 目录。
  pause
  exit /b 1
)

echo.
echo CS2 Insight Agent
echo Backend: http://127.0.0.1:%CS2_INSIGHT_PORT%
echo Press Ctrl+C to stop
echo.

set "PYTHONUNBUFFERED=1"
set "PYTHONFAULTHANDLER=1"
set "CS2_INSIGHT_LOG_DIR=%ROOT%logs"

start "" cmd /c "ping -n 3 127.0.0.1 >nul && start http://127.0.0.1:%CS2_INSIGHT_PORT%/"

"%ROOT%python\python.exe" "%ROOT%backend\app\run_server.py"
pause
'@

    $RepairBat = @'
@echo off
setlocal
set "ROOT=%~dp0"
if not exist "%ROOT%python\python.exe" (
  echo [错误] 缺少 python\python.exe
  pause
  exit /b 1
)
where uv >nul 2>&1
if errorlevel 1 (
  echo [错误] 修复依赖需要 uv。请安装 uv 后重试，或重新安装完整发行包。
  pause
  exit /b 1
)
set "REQ=%TEMP%\cs2-insight-runtime-%RANDOM%.txt"
echo 正在按 uv.lock 重新安装/修复 Python 依赖...
uv export --project "%ROOT%" --frozen --no-dev --no-emit-project --output-file "%REQ%"
if errorlevel 1 goto :failed
uv pip install --python "%ROOT%python\python.exe" --requirements "%REQ%" --compile-bytecode
if errorlevel 1 goto :failed
del /q "%REQ%" >nul 2>&1
echo.
echo 完成。可再运行「启动.bat」。
pause
exit /b 0
:failed
del /q "%REQ%" >nul 2>&1
echo [错误] 依赖修复失败。
pause
exit /b 1
'@

    $Readme = @"
CS2 Insight Agent — 便携包使用说明
================================

本包已内置由 uv.lock 精确锁定的 Python 运行环境，无需再运行「安装依赖」。

1. 首次使用（可选）
   - 默认会从 data\cs2-insight.config.example.json 自动生成 data\cs2-insight.config.json；也可手动复制编辑。

2. 启动
   - 双击「启动.bat」
   - 浏览器访问 http://127.0.0.1:（见启动.bat 中 CS2_INSIGHT_PORT）/

3. 若杀毒软件误删 python\ 下文件导致无法启动
   - 推荐重新安装完整发行包；也可在本机安装 uv 后双击「修复依赖.bat」按锁文件重建。

4. 说明
   - 配置与数据库位于程序约定路径（见应用内说明）。
   - 若默认端口被占用，请用记事本打开「启动.bat」，仅修改顶部的 set CS2_INSIGHT_PORT=… 一行。

"@
    Set-Content -Path (Join-Path $OutDir "修复依赖.bat") -Value $RepairBat -Encoding Default
}
else {
    $StartBat = @'
@echo off
setlocal
set "ROOT=%~dp0"

rem ===== 后端 HTTP 端口（浏览器打开地址、uvicorn、CS2 GSI 均读取此变量；只改下一行）=====
set "CS2_INSIGHT_PORT=19871"
rem ================================================================================

cd /d "%ROOT%backend" 2>nul
if errorlevel 1 (
  echo [错误] 找不到 backend 目录。
  pause
  exit /b 1
)

if exist "%ROOT%python\python.exe" (
  set "USEPY=%ROOT%python\python.exe"
  goto :run
)
where python >nul 2>&1
if %errorlevel% equ 0 (
  set "USEPY=python"
  goto :run
)
where py >nul 2>&1
if %errorlevel% equ 0 (
  set "USEPY=py"
  set "USEPYARGS=-3"
  goto :run
)

echo [错误] 未找到 64 位 Python 3.12。请安装后加入 PATH，或使用默认打包方式生成带 python\ 的完整包。
pause
exit /b 1

:run
echo.
echo CS2 Insight Agent
echo Backend: http://127.0.0.1:%CS2_INSIGHT_PORT%
echo Press Ctrl+C to stop
echo.

set "PYTHONUNBUFFERED=1"
set "PYTHONFAULTHANDLER=1"
set "CS2_INSIGHT_LOG_DIR=%ROOT%logs"

start "" cmd /c "ping -n 3 127.0.0.1 >nul && start http://127.0.0.1:%CS2_INSIGHT_PORT%/"

if defined USEPYARGS (
  "%USEPY%" %USEPYARGS% "%ROOT%backend\app\run_server.py"
) else (
  "%USEPY%" "%ROOT%backend\app\run_server.py"
)
pause
'@

    $InstallBat = @'
@echo off
setlocal
set "ROOT=%~dp0"

where uv >nul 2>&1
if errorlevel 1 (
  echo [错误] 安装依赖需要 uv 0.11.x。
  pause
  exit /b 1
)
if exist "%ROOT%python\python.exe" (
  set "USEPY=%ROOT%python\python.exe"
  goto :install
)
where python >nul 2>&1
if %errorlevel% equ 0 (
  for /f "delims=" %%P in ('python -c "import sys; print(sys.executable)"') do set "USEPY=%%P"
  goto :install
)
where py >nul 2>&1
if %errorlevel% equ 0 (
  for /f "delims=" %%P in ('py -3.12 -c "import sys; print(sys.executable)"') do set "USEPY=%%P"
  goto :install
)
echo [错误] 未找到 python / py。
pause
exit /b 1

:install
set "REQ=%TEMP%\cs2-insight-runtime-%RANDOM%.txt"
uv export --project "%ROOT%" --frozen --no-dev --no-emit-project --output-file "%REQ%"
if errorlevel 1 goto :failed
uv pip install --python "%USEPY%" --requirements "%REQ%" --compile-bytecode
if errorlevel 1 goto :failed
del /q "%REQ%" >nul 2>&1
echo.
echo 依赖安装完成。请运行「启动.bat」。
pause
exit /b 0
:failed
del /q "%REQ%" >nul 2>&1
echo [错误] 依赖安装失败。
pause
exit /b 1
'@

    $Readme = @"
CS2 Insight Agent — 便携包（精简：未内置 Python）
================================

1. 请先双击「安装依赖.bat」安装 Python 依赖（需本机已安装 uv 与 64 位 Python 3.12）。
2. 可选：将 data\cs2-insight.config.example.json 复制为 data\cs2-insight.config.json 并填写（多数情况首次启动会自动生成）。
3. 双击「启动.bat」。

"@
    Set-Content -Path (Join-Path $OutDir "安装依赖.bat") -Value $InstallBat -Encoding Default
}

Set-Content -Path (Join-Path $OutDir "启动.bat") -Value $StartBat -Encoding Default
Set-Content -Path (Join-Path $OutDir "README-使用说明.txt") -Value $Readme -Encoding UTF8

# --- zip（不用 Compress-Archive：大量文件时 PS Archive 模块 Write-Progress 会 IndexOutOfRange）---
Write-Step "Compress zip: $ZipPath"
if (Test-Path $ZipPath) { Remove-Item -Force $ZipPath }
Add-Type -AssemblyName System.IO.Compression
Add-Type -AssemblyName System.IO.Compression.FileSystem
$src = [System.IO.Path]::GetFullPath((Resolve-Path -LiteralPath $OutDir).Path)
$dst = [System.IO.Path]::GetFullPath($ZipPath)
$lvl = [System.IO.Compression.CompressionLevel]::Optimal
# $true：zip 根目录包含发行包文件夹名（与原先 Compress-Archive 行为一致）
[System.IO.Compression.ZipFile]::CreateFromDirectory($src, $dst, $lvl, $true)

Write-Host ""
Write-Host "Done." -ForegroundColor Green
Write-Host "  Folder: $OutDir"
Write-Host "  Zip   : $ZipPath"
Write-Host ""
if ($BundledPython) {
    Write-Host "Release zip includes embedded Python + uv-locked deps. End users: unzip and run 启动.bat only." -ForegroundColor Yellow
} else {
    Write-Host "This zip does NOT include Python. End users must run 安装依赖.bat first." -ForegroundColor Yellow
}
