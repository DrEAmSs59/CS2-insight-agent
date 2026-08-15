#Requires -Version 5.1

[CmdletBinding()]
param(
    [Parameter(Mandatory = $false)]
    [string]$PythonExe = "python",

    [Parameter(Mandatory = $false)]
    [string]$OutputDir = "dist\wheels",

    [Parameter(Mandatory = $false)]
    [string]$UvExe = "uv",

    # Optional local demoparser checkout (must be at metadata.commit). Skips git clone.
    [Parameter(Mandatory = $false)]
    [string]$SourceDir = ""
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

& $UvExe --version
if ($LASTEXITCODE -ne 0) { throw "uv is required to build the patched demoparser wheel." }
# Install maturin without removing the project's other locked dependencies.
& $UvExe sync --project $repoRoot --frozen --group parser-build
if ($LASTEXITCODE -ne 0) { throw "Installing the locked parser-build environment with uv failed." }

New-Item -ItemType Directory -Path $outputPath -Force | Out-Null
$tempRoot = Join-Path ([IO.Path]::GetTempPath()) ("cs2insight-demoparser-" + [Guid]::NewGuid().ToString("n"))
$sourceRoot = Join-Path $tempRoot "demoparser"
New-Item -ItemType Directory -Path $tempRoot -Force | Out-Null

try {
    if ($SourceDir.Trim()) {
        $localSource = (Resolve-Path -LiteralPath $SourceDir).Path
        & git -C $localSource worktree add --detach $sourceRoot $metadata.commit
        if ($LASTEXITCODE -ne 0) { throw "git worktree add from SourceDir failed with exit code $LASTEXITCODE" }
    } else {
        & git clone --quiet --depth 1 --branch $metadata.tag $metadata.upstream_url $sourceRoot
        if ($LASTEXITCODE -ne 0) { throw "git clone demoparser failed with exit code $LASTEXITCODE" }
    }

    $actualCommit = (& git -C $sourceRoot rev-parse HEAD).Trim()
    if ($LASTEXITCODE -ne 0 -or $actualCommit -ne [string]$metadata.commit) {
        throw "demoparser commit mismatch: expected $($metadata.commit), got $actualCommit"
    }

    & git -C $sourceRoot apply --check $patchPath
    if ($LASTEXITCODE -ne 0) { throw "Lean demoparser patch no longer applies cleanly" }
    & git -C $sourceRoot apply $patchPath
    if ($LASTEXITCODE -ne 0) { throw "Applying lean demoparser patch failed" }

    # Overlay: attribute-indexed sticker decode (ported from unicbm/demotracer with permission).
    $overlayRoot = Join-Path $PSScriptRoot "overlays\sticker-attrs"
    if (-not (Test-Path -LiteralPath $overlayRoot -PathType Container)) {
        throw "Sticker attribute overlay missing: $overlayRoot"
    }
    Copy-Item -LiteralPath (Join-Path $overlayRoot "src\parser\src\first_pass\prop_controller.rs") `
        -Destination (Join-Path $sourceRoot "src\parser\src\first_pass\prop_controller.rs") -Force
    Copy-Item -LiteralPath (Join-Path $overlayRoot "src\parser\src\first_pass\sendtables.rs") `
        -Destination (Join-Path $sourceRoot "src\parser\src\first_pass\sendtables.rs") -Force
    Copy-Item -LiteralPath (Join-Path $overlayRoot "src\parser\src\second_pass\collect_data.rs") `
        -Destination (Join-Path $sourceRoot "src\parser\src\second_pass\collect_data.rs") -Force
    $entityVectorPatch = Join-Path $overlayRoot "entity-vector-length.patch"
    if (-not (Test-Path -LiteralPath $entityVectorPatch -PathType Leaf)) {
        throw "Entity vector-length patch missing: $entityVectorPatch"
    }
    & git -C $sourceRoot apply --check $entityVectorPatch
    if ($LASTEXITCODE -ne 0) { throw "Entity vector-length patch no longer applies cleanly" }
    & git -C $sourceRoot apply $entityVectorPatch
    if ($LASTEXITCODE -ne 0) { throw "Applying entity vector-length patch failed" }

    $manifest = Join-Path $sourceRoot "src\python\Cargo.toml"
    $lockPath = Join-Path $sourceRoot "src\python\Cargo.lock"
    $versionQuoted = '"' + [string]$metadata.distribution_version + '"'
    foreach ($path in @($manifest, $lockPath)) {
        if (-not (Test-Path -LiteralPath $path -PathType Leaf)) {
            throw "Missing demoparser version file: $path"
        }
        $text = Get-Content -LiteralPath $path -Raw
        # Keep Cargo.lock --locked compatible when bumping distribution_version.
        $text = $text.Replace('"0.41.4+cs2insight7"', $versionQuoted)
        $text = [regex]::Replace($text, '(?m)^version\s*=\s*"0\.41\.4\+cs2insight\d+"', ('version = ' + $versionQuoted))
        Set-Content -LiteralPath $path -Value $text -NoNewline
    }
    & $UvExe run --project $repoRoot --frozen --group parser-build python -m maturin build --release --locked --manifest-path $manifest --interpreter $PythonExe --out $outputPath
    if ($LASTEXITCODE -ne 0) { throw "maturin build failed with exit code $LASTEXITCODE" }

    $wheel = Get-ChildItem -LiteralPath $outputPath -File -Filter "demoparser2-$($metadata.distribution_version)-*.whl" |
        Sort-Object LastWriteTimeUtc -Descending |
        Select-Object -First 1
    if (-not $wheel) {
        throw "Built wheel for version $($metadata.distribution_version) not found under $outputPath"
    }
    Write-Host ("Lean demoparser wheel: {0}" -f $wheel.FullName)
} finally {
    if ($SourceDir.Trim() -and (Test-Path -LiteralPath $sourceRoot -PathType Container)) {
        & git -C (Resolve-Path -LiteralPath $SourceDir).Path worktree remove --force $sourceRoot 2>$null
    }
    if (Test-Path -LiteralPath $tempRoot) {
        Remove-Item -LiteralPath $tempRoot -Recurse -Force -ErrorAction SilentlyContinue
    }
}
