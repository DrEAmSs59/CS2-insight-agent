#Requires -Version 5.1
param(
  [Parameter(Mandatory = $true)]
  [string] $Version
)
$ErrorActionPreference = "Stop"
try {
  if ($env:ComSpec) { & $env:ComSpec /c "chcp 65001>nul" | Out-Null }
} catch { }
$cs2Utf8 = [System.Text.UTF8Encoding]::new($false)
[Console]::OutputEncoding = $cs2Utf8
[Console]::InputEncoding = $cs2Utf8
$OutputEncoding = $cs2Utf8
$root = Resolve-Path (Join-Path $PSScriptRoot "..\..")
$out = Join-Path $root "backend\app\release_version.txt"
$v = $Version.Trim().TrimStart("v")
if (-not $v) { throw "Empty version" }
Set-Content -LiteralPath $out -Value $v -Encoding utf8 -NoNewline
Write-Host "Wrote $out <= $v"
