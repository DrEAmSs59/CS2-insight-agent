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

& $UvExe --version
if ($LASTEXITCODE -ne 0) { throw "uv 0.11.x is required. Install uv and retry." }
& $UvExe sync --project $repoRoot --frozen
if ($LASTEXITCODE -ne 0) { throw "Installing the locked backend environment with uv failed." }

$python = (Resolve-Path -LiteralPath (Join-Path $repoRoot ".venv\Scripts\python.exe")).Path
& $python -c "import struct,sys; assert sys.version_info[:2] == (3,12), sys.version; assert struct.calcsize('P') == 8, '64-bit Python required'"
if ($LASTEXITCODE -ne 0) { throw "The backend requires 64-bit CPython 3.12." }

if ($WheelPath.Trim() -or $BuildFromSource) {
    if ($WheelPath.Trim()) {
        $wheel = (Resolve-Path -LiteralPath $WheelPath).Path
    } else {
        $wheelDir = Join-Path $repoRoot "dist\wheels"
        & (Join-Path $PSScriptRoot "build-wheel.ps1") -PythonExe $python -OutputDir $wheelDir -UvExe $UvExe
        if ($LASTEXITCODE -ne 0) { throw "Building the patched demoparser wheel failed." }
        $wheel = (
            Get-ChildItem -LiteralPath $wheelDir -File `
                -Filter "demoparser2-$($metadata.distribution_version)-cp312-cp312-win_amd64.whl" |
                Sort-Object LastWriteTimeUtc -Descending |
                Select-Object -First 1
        ).FullName
    }
    if (-not $wheel -or -not (Test-Path -LiteralPath $wheel -PathType Leaf)) {
        throw "Patched demoparser wheel was not produced."
    }
    & $UvExe pip install --python $python --reinstall --no-deps $wheel
    if ($LASTEXITCODE -ne 0) { throw "Installing the patched demoparser wheel failed." }
}

$backend = Join-Path $repoRoot "backend"
& $python -c "import sys; sys.path.insert(0, sys.argv[1]); from app.demoparser_runtime import main; raise SystemExit(main())" $backend
if ($LASTEXITCODE -ne 0) { throw "Patched demoparser runtime verification failed." }
Write-Host "Backend development environment is ready: $python"
