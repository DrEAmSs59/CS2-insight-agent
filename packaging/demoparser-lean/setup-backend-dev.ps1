#Requires -Version 5.1

[CmdletBinding()]
param(
    [string]$UvExe = "uv",
    [string]$WheelPath = "",
    [switch]$BuildFromSource
)

$ErrorActionPreference = "Stop"
$ProgressPreference = "SilentlyContinue"
$repoRoot = (Resolve-Path (Join-Path $PSScriptRoot "..\..")).Path
$metadata = Get-Content -LiteralPath (Join-Path $PSScriptRoot "demoparser-runtime.json") -Raw |
    ConvertFrom-Json

function Remove-BundledDemoparser {
    param([Parameter(Mandatory)][string]$PythonExe)

    $sitePackages = Join-Path (Split-Path -Parent $PythonExe) "Lib\site-packages"
    Remove-Item -LiteralPath (Join-Path $sitePackages "demoparser2") -Recurse -Force -ErrorAction SilentlyContinue
    Get-ChildItem -LiteralPath $sitePackages -Directory -Filter "demoparser2-*.dist-info" -ErrorAction SilentlyContinue |
        ForEach-Object { Remove-Item -LiteralPath $_.FullName -Recurse -Force }
}

& $UvExe --version
if ($LASTEXITCODE -ne 0) { throw "uv 0.11.x is required. Install uv and retry." }
& $UvExe sync --project $repoRoot --frozen
if ($LASTEXITCODE -ne 0) { throw "Installing the locked backend environment with uv failed." }

$python = (Resolve-Path -LiteralPath (Join-Path $repoRoot ".venv\Scripts\python.exe")).Path
& $python -c "import struct,sys; assert sys.version_info[:2] == (3,12), sys.version; assert struct.calcsize('P') == 8, '64-bit Python required'"
if ($LASTEXITCODE -ne 0) { throw "The backend requires 64-bit CPython 3.12." }

$runtimeWheel = ""
if ($WheelPath.Trim() -or $BuildFromSource) {
    if ($WheelPath.Trim()) {
        $runtimeWheel = (Resolve-Path -LiteralPath $WheelPath).Path
    } else {
        $wheelDir = Join-Path $repoRoot "dist\wheels"
        & (Join-Path $PSScriptRoot "build-wheel.ps1") -PythonExe $python -OutputDir $wheelDir -UvExe $UvExe
        if ($LASTEXITCODE -ne 0) { throw "Building the patched demoparser wheel failed." }
        $runtimeWheel = (
            Get-ChildItem -LiteralPath $wheelDir -File `
                -Filter "demoparser2-$($metadata.distribution_version)-cp312-cp312-win_amd64.whl" |
                Sort-Object LastWriteTimeUtc -Descending |
                Select-Object -First 1
        ).FullName
    }
    if (-not $runtimeWheel -or -not (Test-Path -LiteralPath $runtimeWheel -PathType Leaf)) {
        throw "Patched demoparser wheel was not produced."
    }
    & $UvExe pip install --python $python --reinstall --no-deps $runtimeWheel
    if ($LASTEXITCODE -ne 0) { throw "Installing the patched demoparser wheel failed." }
} else {
    $wheelName = "demoparser2-$($metadata.distribution_version)-cp312-cp312-win_amd64.whl"
    $escapedWheelName = [Uri]::EscapeDataString($wheelName)
    $runtimeWheel = "https://github.com/$($metadata.release_repo)/releases/download/$($metadata.release_tag)/$escapedWheelName"
}

$backend = Join-Path $repoRoot "backend"
& $python -c "import sys; sys.path.insert(0, sys.argv[1]); from app.demoparser_runtime import main; raise SystemExit(main())" $backend
if ($LASTEXITCODE -ne 0) { throw "Patched demoparser runtime verification failed." }

# Desktop release builds use the separate repo-root python\ runtime. Keep the
# documented setup command useful after a demoparser runtime upgrade by repairing
# that staged runtime when it already exists; do not create the large bundle for
# developers who only use the browser or Tauri development workflow.
$desktopPython = Join-Path $repoRoot "python\python.exe"
if (Test-Path -LiteralPath $desktopPython -PathType Leaf) {
    & $desktopPython -c "import json,sys; sys.path.insert(0, sys.argv[1]); from app.demoparser_runtime import inspect_demoparser_runtime; report = inspect_demoparser_runtime(); print(json.dumps(report, ensure_ascii=False, sort_keys=True)); raise SystemExit(0 if report['ready'] else 1)" $backend
    if ($LASTEXITCODE -ne 0) {
        Write-Host "Repairing the existing desktop Python runtime..."
        # Release trimming removes wheel RECORD files, so package managers
        # cannot reliably uninstall an older parser from this runtime.
        Remove-BundledDemoparser -PythonExe $desktopPython
        & $UvExe pip install --python $desktopPython --reinstall --no-deps --compile-bytecode $runtimeWheel
        if ($LASTEXITCODE -ne 0) { throw "Repairing the desktop demoparser runtime failed." }
        & $desktopPython -c "import sys; sys.path.insert(0, sys.argv[1]); from app.demoparser_runtime import main; raise SystemExit(main())" $backend
        if ($LASTEXITCODE -ne 0) { throw "Desktop demoparser runtime verification failed after repair." }
    }
    Write-Host "Desktop packaging runtime is ready: $desktopPython"
}
Write-Host "Backend development environment is ready: $python"
