#Requires -Version 5.1
<#
.SYNOPSIS
  Build frontend, copy backend + web, bundle Python + pip deps (default), zip.

.PARAMETER PortablePythonDir
  If set: copy this folder to .\python\ (must contain python.exe), then pip install -r requirements.

.PARAMETER OutDir
  Output folder, default dist\CS2-Insight-Agent-portable

.PARAMETER SkipNpm
  Skip npm install / build (use existing frontend\dist)

.PARAMETER CleanNpm
  Kill node.exe, delete frontend\node_modules, then npm install/build (fixes EPERM on Windows)

.PARAMETER SkipBundlePython
  Do not embed Python; output has no python\ (end users must install Python + deps themselves).

.PARAMETER EmbeddedPythonVersion
  Python embeddable version to download (default 3.12.7). Must match an existing zip on python.org.

.PARAMETER ElectronStagePythonOnly
  Only populate repo-root .\python\ using the same rules as the portable pack (embeddable or -PortablePythonDir + pip install).
  Then exit — use before npm run electron:build (electron-builder extraResources reads ..\python).

#>
param(
    [string]$PortablePythonDir = "",
    [string]$OutDir = "",
    [switch]$SkipNpm,
    [switch]$CleanNpm,
    [switch]$SkipBundlePython,
    [string]$EmbeddedPythonVersion = "3.12.7",
    [switch]$ElectronStagePythonOnly
)

$ErrorActionPreference = "Stop"
if ($PSVersionTable.PSVersion.Major -lt 5) { throw "PowerShell 5.1+ required" }

$Root = Split-Path -Parent $MyInvocation.MyCommand.Path
if (-not $OutDir) {
    $OutDir = Join-Path $Root "dist\CS2-Insight-Agent-portable"
}

$ZipPath = "$OutDir.zip"
$Frontend = Join-Path $Root "frontend"
$Backend = Join-Path $Root "backend"
$CacheDir = Join-Path $Root ".packaging-cache"
$ReqFile = Join-Path $Backend "requirements.txt"

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

    $getPip = Join-Path $CacheDir "get-pip.py"
    if (-not (Test-Path $getPip)) {
        Write-Step "Download get-pip.py"
        Invoke-WebRequest -Uri "https://bootstrap.pypa.io/get-pip.py" -OutFile $getPip -UseBasicParsing -TimeoutSec 120
    }

    $pyExe = Join-Path $DestDir "python.exe"
    Write-Step "Install pip into embedded Python"
    Push-Location $DestDir
    try {
        & $pyExe $getPip
        if ($LASTEXITCODE -ne 0) { throw "get-pip.py failed (exit $LASTEXITCODE)" }
    } finally {
        Pop-Location
    }
}

function Install-BackendRequirements {
    param(
        [Parameter(Mandatory)][string]$PythonExe,
        [Parameter(Mandatory)][string]$RequirementsPath
    )
    Write-Step "pip install -r requirements.txt (this can take several minutes)"
    & $PythonExe -m pip install -U pip
    if ($LASTEXITCODE -ne 0) { throw "pip upgrade failed (exit $LASTEXITCODE)" }
    & $PythonExe -m pip install -r $RequirementsPath
    if ($LASTEXITCODE -ne 0) { throw "pip install -r requirements.txt failed (exit $LASTEXITCODE)" }
    Write-Step "Remove pip / setuptools / wheel (not needed at runtime)"
    & $PythonExe -m pip uninstall -y pip setuptools wheel
}

function Bundle-PythonInto {
    param(
        [Parameter(Mandatory)][string]$PythonDestDir,
        [Parameter(Mandatory)][string]$RequirementsPath
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
        Install-BackendRequirements -PythonExe (Join-Path $PythonDestDir "python.exe") -RequirementsPath $RequirementsPath
    }
    elseif (-not $SkipBundlePython) {
        Get-EmbeddedPython -DestDir $PythonDestDir -Version $EmbeddedPythonVersion -CacheDir $CacheDir
        Install-BackendRequirements -PythonExe (Join-Path $PythonDestDir "python.exe") -RequirementsPath $RequirementsPath
    }
    else {
        throw "Bundle-PythonInto: set PortablePythonDir or clear -SkipBundlePython"
    }
}

if (-not (Test-Path $Backend)) { throw "backend folder not found: $Backend" }
if (-not (Test-Path $ReqFile)) { throw "requirements.txt not found: $ReqFile" }

if ($ElectronStagePythonOnly) {
    if ($SkipBundlePython -and -not ($PortablePythonDir.Trim())) {
        throw "ElectronStagePythonOnly: use -PortablePythonDir (or omit -SkipBundlePython for embeddable download)."
    }
    $electronPy = Join-Path $Root "python"
    Write-Step "Electron: stage repo-root python\ (same bundle logic as portable package)"
    Bundle-PythonInto -PythonDestDir $electronPy -RequirementsPath $ReqFile
    Write-Host ""
    Write-Host "Done: $electronPy" -ForegroundColor Green
    Write-Host "Next:  cd frontend" -ForegroundColor Yellow
    Write-Host "       npm run electron:build" -ForegroundColor Yellow
    exit 0
}

# --- frontend build ---
if (-not $SkipNpm) {
    if ($CleanNpm) {
        Write-Step "CleanNpm: stop node.exe, remove frontend\node_modules"
        Get-Process -Name node -ErrorAction SilentlyContinue | Stop-Process -Force -ErrorAction SilentlyContinue
        Start-Sleep -Seconds 1
        $nm = Join-Path $Frontend "node_modules"
        if (Test-Path $nm) {
            Remove-Item -Recurse -Force $nm
        }
    }
    Write-Step "npm install / npm run build (frontend)"
    Push-Location $Frontend
    try {
        if (Test-Path (Join-Path $Frontend "package-lock.json")) {
            npm ci
        } else {
            npm install
        }
        if ($LASTEXITCODE -ne 0) {
            throw "npm install/ci failed (exit $LASTEXITCODE). Try closing editors/antivirus, or run with -CleanNpm."
        }
        npm run build
        if ($LASTEXITCODE -ne 0) {
            throw "npm run build failed (exit $LASTEXITCODE)."
        }
    } finally {
        Pop-Location
    }
}

$DistWeb = Join-Path $Frontend "dist"
if (-not (Test-Path (Join-Path $DistWeb "index.html"))) {
    throw "Missing frontend\dist\index.html — run npm run build in frontend first."
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

$ReqInPackage = Join-Path $DestBackend "requirements.txt"

# --- web static files ---
Write-Step "Copy frontend dist into web/"
$DestWeb = Join-Path $OutDir "web"
robocopy $DistWeb $DestWeb /E /NFL /NDL /NJH /NJS /nc /ns /np | Out-Null
if ($LASTEXITCODE -ge 8) { throw "robocopy web failed (exit $LASTEXITCODE)" }

# --- POV HUD（experimental）：发行包根目录 pov/，后端识别 pov_default.vpk + pov_de_dust2.vpk 或旧版 pov.vpk（见 pov_hud_manager.find_project_root）---
$PovSrc = Join-Path $Root "pov"
$PovHasAssets = (
    (Test-Path (Join-Path $PovSrc "pov.vpk")) -or
    (Test-Path (Join-Path $PovSrc "pov_default.vpk")) -or
    (Test-Path (Join-Path $PovSrc "pov_de_dust2.vpk"))
)
$DestPov = Join-Path $OutDir "pov"
if ($PovHasAssets) {
    Write-Step "Copy pov/ (POV HUD assets)"
    robocopy $PovSrc $DestPov /E /NFL /NDL /NJH /NJS /nc /ns /np | Out-Null
    if ($LASTEXITCODE -ge 8) { throw "robocopy pov failed (exit $LASTEXITCODE)" }
}
else {
    Write-Host "跳过 pov/：仓库根目录 pov/ 下未找到 pov.vpk、pov_default.vpk 或 pov_de_dust2.vpk，便携包内将无法安装 POV HUD。" -ForegroundColor Yellow
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
    Bundle-PythonInto -PythonDestDir $DestPy -RequirementsPath $ReqInPackage
    $BundledPython = $true
}
elseif (-not $SkipBundlePython) {
    Bundle-PythonInto -PythonDestDir $DestPy -RequirementsPath $ReqInPackage
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
echo 正在重新安装/修复 Python 依赖（与发行包一致）...
"%ROOT%python\python.exe" -m pip install -U pip
"%ROOT%python\python.exe" -m pip install -r "%ROOT%backend\requirements.txt"
echo.
echo 完成。可再运行「启动.bat」。
pause
'@

    $Readme = @"
CS2 Insight Agent — 便携包使用说明
================================

本包已内置 Python 运行环境与 pip 依赖，无需再运行「安装依赖」。

1. 首次使用（可选）
   - 默认会从 data\cs2-insight.config.example.json 自动生成 data\cs2-insight.config.json；也可手动复制编辑。

2. 启动
   - 双击「启动.bat」
   - 浏览器访问 http://127.0.0.1:（见启动.bat 中 CS2_INSIGHT_PORT）/

3. 若杀毒软件误删 python\ 下文件导致无法启动
   - 可双击「修复依赖.bat」尝试重新拉取依赖；仍失败请关闭杀毒对本文件夹的拦截或重新解压。

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

echo [错误] 未找到 Python。请安装 Python 3.10+ 并加入 PATH，或使用默认打包方式生成带 python\ 的完整包。
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

if exist "%ROOT%python\python.exe" (
  "%ROOT%python\python.exe" -m pip install -U pip
  "%ROOT%python\python.exe" -m pip install -r "%ROOT%backend\requirements.txt"
  goto :done
)
where python >nul 2>&1
if %errorlevel% equ 0 (
  python -m pip install -U pip
  python -m pip install -r "%ROOT%backend\requirements.txt"
  goto :done
)
where py >nul 2>&1
if %errorlevel% equ 0 (
  py -3 -m pip install -U pip
  py -3 -m pip install -r "%ROOT%backend\requirements.txt"
  goto :done
)
echo [错误] 未找到 python / py。
pause
exit /b 1

:done
echo.
echo 依赖安装完成。请运行「启动.bat」。
pause
'@

    $Readme = @"
CS2 Insight Agent — 便携包（精简：未内置 Python）
================================

1. 请先双击「安装依赖.bat」安装 Python 依赖（需本机已安装 Python 3.10+ 并在 PATH 中）。
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
    Write-Host "Release zip includes embedded Python + pip deps. End users: unzip and run 启动.bat only." -ForegroundColor Yellow
} else {
    Write-Host "This zip does NOT include Python. End users must run 安装依赖.bat first." -ForegroundColor Yellow
}
