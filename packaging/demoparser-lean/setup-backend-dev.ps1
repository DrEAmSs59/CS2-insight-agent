#Requires -Version 5.1

[CmdletBinding()]
param(
    [string]$PythonExe = "",
    [string]$WheelPath = "",
    [switch]$BuildFromSource
)

$ErrorActionPreference = "Stop"
$ProgressPreference = "SilentlyContinue"
$repoRoot = (Resolve-Path (Join-Path $PSScriptRoot "..\..")).Path
$metadata = Get-Content -LiteralPath (Join-Path $PSScriptRoot "demoparser-runtime.json") -Raw |
    ConvertFrom-Json

if (-not $PythonExe.Trim()) {
    $venvPython = Join-Path $repoRoot ".venv\Scripts\python.exe"
    if (-not (Test-Path -LiteralPath $venvPython -PathType Leaf)) {
        $pyLauncher = Get-Command py -ErrorAction SilentlyContinue
        if (-not $pyLauncher) {
            throw "Python 3.12 is required. Install it or pass -PythonExe explicitly."
        }
        & $pyLauncher.Source -3.12 -m venv (Join-Path $repoRoot ".venv")
        if ($LASTEXITCODE -ne 0) { throw "Creating the Python 3.12 virtual environment failed." }
    }
    $PythonExe = $venvPython
}
$python = (Resolve-Path -LiteralPath $PythonExe).Path
& $python -c "import struct,sys; assert sys.version_info[:2] == (3,12), sys.version; assert struct.calcsize('P') == 8, '64-bit Python required'"
if ($LASTEXITCODE -ne 0) { throw "The backend requires 64-bit CPython 3.12." }

$requirements = Join-Path $repoRoot "backend\requirements.txt"
$constraints = Join-Path $repoRoot "backend\constraints.txt"
& $python -m pip install -c $constraints -r $requirements
if ($LASTEXITCODE -ne 0) { throw "Installing backend requirements failed." }

$temporaryRoot = $null
try {
    if ($WheelPath.Trim()) {
        $wheel = (Resolve-Path -LiteralPath $WheelPath).Path
    } elseif ($BuildFromSource) {
        & $python -m pip install "maturin==$($metadata.maturin_version)"
        if ($LASTEXITCODE -ne 0) { throw "Installing maturin failed." }
        $wheelDir = Join-Path $repoRoot "dist\wheels"
        & (Join-Path $PSScriptRoot "build-wheel.ps1") -PythonExe $python -OutputDir $wheelDir
        if ($LASTEXITCODE -ne 0) { throw "Building the patched demoparser wheel failed." }
        $wheel = (
            Get-ChildItem -LiteralPath $wheelDir -File `
                -Filter "demoparser2-$($metadata.distribution_version)-cp312-cp312-win_amd64.whl" |
                Sort-Object LastWriteTimeUtc -Descending |
                Select-Object -First 1
        ).FullName
    } else {
        $assetName = "demoparser2-$($metadata.distribution_version)-cp312-cp312-win_amd64.whl"
        $temporaryRoot = Join-Path ([IO.Path]::GetTempPath()) (
            "cs2insight-demoparser-install-" + [Guid]::NewGuid().ToString("n")
        )
        New-Item -ItemType Directory -Path $temporaryRoot -Force | Out-Null
        $wheel = Join-Path $temporaryRoot $assetName
        $checksumPath = Join-Path $temporaryRoot ([string]$metadata.checksum_asset)
        $releaseBase = "https://github.com/$($metadata.release_repo)/releases/download/$($metadata.release_tag)"
        try {
            Invoke-WebRequest -UseBasicParsing `
                -Uri "$releaseBase/$([Uri]::EscapeDataString($assetName))" `
                -OutFile $wheel
            Invoke-WebRequest -UseBasicParsing `
                -Uri "$releaseBase/$([Uri]::EscapeDataString([string]$metadata.checksum_asset))" `
                -OutFile $checksumPath
        } catch {
            throw (
                "Downloading the pinned demoparser wheel failed. " +
                "Retry after the demoparser release workflow completes, or run this script with " +
                "-BuildFromSource. Original error: $($_.Exception.Message)"
            )
        }

        $checksumLine = Get-Content -LiteralPath $checksumPath |
            Where-Object { $_ -match ("[ ]" + [regex]::Escape($assetName) + "$") } |
            Select-Object -First 1
        if (-not $checksumLine -or $checksumLine -notmatch "^([0-9a-fA-F]{64})\s+\*?(.+)$") {
            throw "The published checksum file does not contain $assetName."
        }
        $expectedHash = $Matches[1].ToLowerInvariant()
        $actualHash = (Get-FileHash -LiteralPath $wheel -Algorithm SHA256).Hash.ToLowerInvariant()
        if ($actualHash -ne $expectedHash) {
            throw "Downloaded demoparser wheel SHA256 mismatch: expected $expectedHash, got $actualHash."
        }
        Write-Host "Verified demoparser wheel SHA256: $actualHash"
    }

    if (-not $wheel -or -not (Test-Path -LiteralPath $wheel -PathType Leaf)) {
        throw "Patched demoparser wheel was not produced."
    }
    & $python -m pip install --force-reinstall --no-deps $wheel
    if ($LASTEXITCODE -ne 0) { throw "Installing the patched demoparser wheel failed." }

    $backend = Join-Path $repoRoot "backend"
    & $python -c "import sys; sys.path.insert(0, sys.argv[1]); from app.demoparser_runtime import main; raise SystemExit(main())" $backend
    if ($LASTEXITCODE -ne 0) { throw "Patched demoparser runtime verification failed." }
    Write-Host "Backend development environment is ready: $python"
} finally {
    if ($temporaryRoot -and (Test-Path -LiteralPath $temporaryRoot)) {
        Remove-Item -LiteralPath $temporaryRoot -Recurse -Force -ErrorAction SilentlyContinue
    }
}
