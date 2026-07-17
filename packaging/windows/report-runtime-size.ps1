#Requires -Version 5.1

[CmdletBinding()]
param(
    [Parameter(Mandatory = $false)]
    [string]$Root = "dist\staging",

    [Parameter(Mandatory = $false)]
    [string]$OutputPath = "dist\runtime-size-report.json",

    [Parameter(Mandatory = $false)]
    [ValidateRange(1, 1000)]
    [int]$Top = 30,

    [Parameter(Mandatory = $false)]
    [ValidateRange(0, [double]::MaxValue)]
    [double]$BudgetMiB = 0
)

$ErrorActionPreference = "Stop"
$repoRoot = (Resolve-Path (Join-Path $PSScriptRoot "..\..")).Path

function Resolve-FromRepo([string]$PathValue, [bool]$MustExist) {
    $candidate = if ([IO.Path]::IsPathRooted($PathValue)) {
        $PathValue
    } else {
        Join-Path $repoRoot $PathValue
    }

    if ($MustExist) {
        return (Resolve-Path -LiteralPath $candidate).Path
    }
    return [IO.Path]::GetFullPath($candidate)
}

function Get-TreeBytes([string]$PathValue) {
    if (Test-Path -LiteralPath $PathValue -PathType Leaf) {
        return [int64](Get-Item -LiteralPath $PathValue -Force).Length
    }

    [int64]$sum = 0
    Get-ChildItem -LiteralPath $PathValue -Recurse -File -Force -ErrorAction SilentlyContinue |
        ForEach-Object { $sum += [int64]$_.Length }
    return $sum
}

function Convert-ToMiB([int64]$Bytes) {
    return [Math]::Round($Bytes / 1MB, 2)
}

function Get-EntryReport([System.IO.FileSystemInfo]$Entry, [int64]$TotalBytes) {
    [int64]$bytes = Get-TreeBytes $Entry.FullName
    $percent = if ($TotalBytes -gt 0) {
        [Math]::Round(($bytes * 100.0) / $TotalBytes, 2)
    } else {
        0.0
    }

    return [pscustomobject][ordered]@{
        name = $Entry.Name
        kind = if ($Entry.PSIsContainer) { "directory" } else { "file" }
        bytes = $bytes
        mib = Convert-ToMiB $bytes
        percent = $percent
    }
}

function Get-ChildReports([string]$PathValue, [int64]$TotalBytes, [int]$Limit) {
    if (-not (Test-Path -LiteralPath $PathValue -PathType Container)) {
        return @()
    }

    $items = @(
        Get-ChildItem -LiteralPath $PathValue -Force |
            ForEach-Object { Get-EntryReport $_ $TotalBytes } |
            Sort-Object @{ Expression = "bytes"; Descending = $true }, @{ Expression = "name"; Descending = $false } |
            Select-Object -First $Limit
    )
    return $items
}

$rootPath = Resolve-FromRepo $Root $true
$outputFullPath = Resolve-FromRepo $OutputPath $false
[int64]$totalBytes = Get-TreeBytes $rootPath
$sitePackagesPath = @(
    (Join-Path $rootPath "python\Lib\site-packages"),
    (Join-Path $rootPath "resources\python\Lib\site-packages"),
    (Join-Path $rootPath "Lib\site-packages")
) | Where-Object { Test-Path -LiteralPath $_ -PathType Container } | Select-Object -First 1

$report = [pscustomobject][ordered]@{
    schemaVersion = 1
    root = $rootPath
    totalBytes = $totalBytes
    totalMiB = Convert-ToMiB $totalBytes
    budgetMiB = if ($BudgetMiB -gt 0) { $BudgetMiB } else { $null }
    topLevel = @(Get-ChildReports $rootPath $totalBytes $Top)
    sitePackagesRoot = $sitePackagesPath
    sitePackages = if ($sitePackagesPath) { @(Get-ChildReports $sitePackagesPath $totalBytes $Top) } else { @() }
}

$outputDir = Split-Path -Parent $outputFullPath
if ($outputDir -and -not (Test-Path -LiteralPath $outputDir)) {
    New-Item -ItemType Directory -Path $outputDir -Force | Out-Null
}
$json = $report | ConvertTo-Json -Depth 5
[IO.File]::WriteAllText($outputFullPath, $json + [Environment]::NewLine, [Text.UTF8Encoding]::new($false))

Write-Host ("Runtime root: {0}" -f $rootPath)
Write-Host ("Runtime size: {0:N2} MiB ({1:N0} bytes)" -f $report.totalMiB, $totalBytes)
Write-Host "Largest top-level entries:"
$report.topLevel | Format-Table name, kind, mib, percent -AutoSize
if ($report.sitePackages.Count -gt 0) {
    Write-Host "Largest site-packages entries:"
    $report.sitePackages | Format-Table name, kind, mib, percent -AutoSize
}
Write-Host ("JSON report: {0}" -f $outputFullPath)

if ($BudgetMiB -gt 0 -and $report.totalMiB -gt $BudgetMiB) {
    throw ("Runtime size {0:N2} MiB exceeds budget {1:N2} MiB" -f $report.totalMiB, $BudgetMiB)
}
