param(
    [string]$OutputPath = ""
)

$ErrorActionPreference = "Stop"

$RepoRoot = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot "..\.."))
$PackRoot = [IO.Path]::GetFullPath((Join-Path $RepoRoot "optional-resources\skybox-pack"))
$SkyboxRoot = Join-Path $PackRoot "skyboxes"

if (-not (Test-Path -LiteralPath $PackRoot -PathType Container)) {
    throw "Optional skybox pack root not found: $PackRoot"
}
if (-not (Test-Path -LiteralPath (Join-Path $PackRoot "README.md") -PathType Leaf)) {
    throw "Optional skybox pack README is missing."
}
if (-not (Test-Path -LiteralPath $SkyboxRoot -PathType Container)) {
    throw "Optional skybox assets not found: $SkyboxRoot"
}

$Skyboxes = @(Get-ChildItem -LiteralPath $SkyboxRoot -Directory | Sort-Object Name)
if ($Skyboxes.Count -ne 27) {
    throw "Expected 27 optional skyboxes, found $($Skyboxes.Count)."
}

foreach ($Skybox in $Skyboxes) {
    if ($Skybox.Name -match '^cartoon(?:\d+)?$') {
        throw "Cartoon skybox must stay in the main application bundle: $($Skybox.Name)"
    }
    $MaterialFiles = @(Get-ChildItem -LiteralPath $Skybox.FullName -File -Filter "*.vmat_c")
    $TextureFiles = @(Get-ChildItem -LiteralPath $Skybox.FullName -File -Filter "*.vtex_c")
    $AllFiles = @(Get-ChildItem -LiteralPath $Skybox.FullName -File)
    if ($MaterialFiles.Count -ne 1 -or $TextureFiles.Count -ne 1 -or $AllFiles.Count -ne 2) {
        throw "Skybox $($Skybox.Name) must contain exactly one .vmat_c and one .vtex_c file."
    }
}

if (-not $OutputPath.Trim()) {
    $OutputPath = Join-Path $RepoRoot "dist\CS2-Insight-Agent-Optional-Skyboxes.zip"
}
$ResolvedOutput = [IO.Path]::GetFullPath($OutputPath)
$RepoPrefix = $RepoRoot.TrimEnd([IO.Path]::DirectorySeparatorChar, [IO.Path]::AltDirectorySeparatorChar) + [IO.Path]::DirectorySeparatorChar
if (-not $ResolvedOutput.StartsWith($RepoPrefix, [StringComparison]::OrdinalIgnoreCase)) {
    throw "Output path must stay inside the repository: $ResolvedOutput"
}

$OutputDirectory = [IO.Path]::GetDirectoryName($ResolvedOutput)
New-Item -ItemType Directory -Path $OutputDirectory -Force | Out-Null
if (Test-Path -LiteralPath $ResolvedOutput) {
    Remove-Item -LiteralPath $ResolvedOutput -Force
}

Add-Type -AssemblyName System.IO.Compression
Add-Type -AssemblyName System.IO.Compression.FileSystem
[System.IO.Compression.ZipFile]::CreateFromDirectory(
    $PackRoot,
    $ResolvedOutput,
    [System.IO.Compression.CompressionLevel]::Optimal,
    $true
)

$Archive = Get-Item -LiteralPath $ResolvedOutput
$Hash = (Get-FileHash -LiteralPath $ResolvedOutput -Algorithm SHA256).Hash.ToLowerInvariant()
Write-Host ("Optional skybox pack: {0} ({1:N2} MiB)" -f $Archive.FullName, ($Archive.Length / 1MB))
Write-Host "SHA256: $Hash"
