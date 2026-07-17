#Requires -Version 5.1

[CmdletBinding()]
param(
    [Parameter(Mandatory = $false)]
    [string]$PythonExe = "python",

    [Parameter(Mandatory = $false)]
    [string]$OutputDir = "dist\wheels"
)

$ErrorActionPreference = "Stop"
$repoRoot = (Resolve-Path (Join-Path $PSScriptRoot "..\..")).Path
$metadataPath = Join-Path $PSScriptRoot "demoparser-runtime.json"
$patchPath = Join-Path $PSScriptRoot "demoparser2-v0.41.4.patch"
$metadata = Get-Content -LiteralPath $metadataPath -Raw | ConvertFrom-Json
$outputPath = if ([IO.Path]::IsPathRooted($OutputDir)) {
    [IO.Path]::GetFullPath($OutputDir)
} else {
    [IO.Path]::GetFullPath((Join-Path $repoRoot $OutputDir))
}

if (-not (Test-Path -LiteralPath $patchPath -PathType Leaf)) {
    throw "Lean demoparser patch not found: $patchPath"
}
$patchHash = (Get-FileHash -LiteralPath $patchPath -Algorithm SHA256).Hash.ToLowerInvariant()
if ($patchHash -ne ([string]$metadata.patch_sha256).ToLowerInvariant()) {
    throw "Lean demoparser patch SHA256 mismatch: expected $($metadata.patch_sha256), got $patchHash"
}

& $PythonExe -c "import maturin" 2>$null
if ($LASTEXITCODE -ne 0) {
    throw "maturin $($metadata.maturin_version) is required for $PythonExe"
}
$maturinVersion = (& $PythonExe -m maturin --version) -replace '^maturin\s+', ''
if ($LASTEXITCODE -ne 0 -or $maturinVersion.Trim() -ne [string]$metadata.maturin_version) {
    throw "Expected maturin $($metadata.maturin_version), got '$maturinVersion'"
}

New-Item -ItemType Directory -Path $outputPath -Force | Out-Null
$tempRoot = Join-Path ([IO.Path]::GetTempPath()) ("cs2insight-demoparser-" + [Guid]::NewGuid().ToString("n"))
$sourceRoot = Join-Path $tempRoot "demoparser"
New-Item -ItemType Directory -Path $tempRoot -Force | Out-Null

try {
    & git clone --quiet --depth 1 --branch $metadata.tag $metadata.upstream_url $sourceRoot
    if ($LASTEXITCODE -ne 0) { throw "git clone demoparser failed with exit code $LASTEXITCODE" }

    $actualCommit = (& git -C $sourceRoot rev-parse HEAD).Trim()
    if ($LASTEXITCODE -ne 0 -or $actualCommit -ne [string]$metadata.commit) {
        throw "demoparser commit mismatch: expected $($metadata.commit), got $actualCommit"
    }

    & git -C $sourceRoot apply --check $patchPath
    if ($LASTEXITCODE -ne 0) { throw "Lean demoparser patch no longer applies cleanly" }
    & git -C $sourceRoot apply $patchPath
    if ($LASTEXITCODE -ne 0) { throw "Applying lean demoparser patch failed" }

    $manifest = Join-Path $sourceRoot "src\python\Cargo.toml"
    & $PythonExe -m maturin build --release --locked --manifest-path $manifest --interpreter $PythonExe --out $outputPath
    if ($LASTEXITCODE -ne 0) { throw "maturin build failed with exit code $LASTEXITCODE" }

    $wheel = Get-ChildItem -LiteralPath $outputPath -File -Filter "demoparser2-$($metadata.distribution_version)-*.whl" |
        Sort-Object LastWriteTimeUtc -Descending |
        Select-Object -First 1
    if (-not $wheel) {
        throw "Built wheel for version $($metadata.distribution_version) not found under $outputPath"
    }
    Write-Host ("Lean demoparser wheel: {0}" -f $wheel.FullName)
} finally {
    if (Test-Path -LiteralPath $tempRoot) {
        Remove-Item -LiteralPath $tempRoot -Recurse -Force -ErrorAction SilentlyContinue
    }
}
