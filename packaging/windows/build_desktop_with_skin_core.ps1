# Copyright (c) CS2 Insight Agent contributors.
# One-click Windows desktop package that rebuilds skin-core from a sibling
# CS2-demo-anyskin checkout and embeds it into the Tauri NSIS installer.
#
# Usage (from repo root OR this script's directory):
#   powershell -ExecutionPolicy Bypass -File .\packaging\windows\build_desktop_with_skin_core.ps1 `
#     -Version 2.4.0
#
# Prerequisites:
#   - This repo and CS2-demo-anyskin as siblings, e.g.
#       C:\code\CS2-insight-agent
#       C:\code\CS2-demo-anyskin
#   - Rust + pnpm + Python staging already set up for normal desktop:build:ver
#   - For -Pack (default): UPX on PATH, or pass -UpxPath / -SkipPack
#
# Flow (two-pass so parent PE allowlist matches the shipped Agent):
#   1) Stage python + build Insight once (skin-core optional/missing OK)
#   2) Build anyskin skin-core with -ParentPe @(Agent.exe, python.exe) [+ UPX]
#   3) Rebuild Insight with CS2_SKIN_CORE_EXE pointing at dist\skin-core.exe

[CmdletBinding()]
param(
    # Installer / app version (same as desktop:build:ver).
    [Parameter(Mandatory = $true)]
    [ValidatePattern('^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$')]
    [string]$Version,

    # Override sibling anyskin root. Default: <insight-parent>\CS2-demo-anyskin
    [string]$AnyskinRoot = "",

    # Optional path to upx.exe when not on PATH.
    [string]$UpxPath = "",

    # Skip UPX even for shipping-shaped builds (not recommended for release).
    [switch]$SkipPack,

    # Reuse an existing Agent PE from a prior Pass-1 build (skip first tauri build).
    [switch]$ReuseExistingAgent,

    # Force refresh of the lean python\ runtime (sets CS2_INSIGHT_REFRESH_PYTHON=1).
    [switch]$RefreshPython,

    # Optional demoparser2 wheel path (same as CS2_INSIGHT_DEMOPARSER_WHEEL).
    [string]$DemoparserWheel = ""
)

$ErrorActionPreference = "Stop"

function Get-InsightRepoRoot {
    # packaging/windows -> packaging -> repo root
    return (Resolve-Path (Join-Path $PSScriptRoot "..\..")).Path
}

function Resolve-AnyskinRoot {
    param(
        [string]$InsightRoot,
        [string]$Override
    )
    if ($Override) {
        if (-not (Test-Path -LiteralPath $Override)) {
            throw "AnyskinRoot not found: $Override"
        }
        return (Resolve-Path -LiteralPath $Override).Path
    }

    $parent = Split-Path -Parent $InsightRoot
    $candidates = @(
        (Join-Path $parent "CS2-demo-anyskin"),
        (Join-Path $InsightRoot "..\CS2-demo-anyskin")
    )
    foreach ($c in $candidates) {
        $releaseScript = Join-Path $c "scripts\release-skin-core.ps1"
        if ((Test-Path -LiteralPath $c) -and (Test-Path -LiteralPath $releaseScript)) {
            return (Resolve-Path -LiteralPath $c).Path
        }
    }
    throw @"
CS2-demo-anyskin not found next to Insight.

Expected sibling layout:
  $(Split-Path -Parent $InsightRoot)\CS2-insight-agent
  $(Split-Path -Parent $InsightRoot)\CS2-demo-anyskin

Clone the private anyskin repo beside Insight, or pass -AnyskinRoot <path>.
"@
}

function Invoke-Native {
    param(
        [scriptblock]$Block,
        [string]$FailMessage
    )
    & $Block
    if ($LASTEXITCODE -and $LASTEXITCODE -ne 0) {
        throw "$FailMessage (exit $LASTEXITCODE)"
    }
}

function Find-AgentExe {
    param([string]$ReleaseDir)
    $preferred = Join-Path $ReleaseDir "cs2-insight-agent-desktop.exe"
    if (Test-Path -LiteralPath $preferred) {
        return $preferred
    }
    $alt = Join-Path $ReleaseDir "CS2 Insight Agent.exe"
    if (Test-Path -LiteralPath $alt) {
        return $alt
    }
    throw "Agent PE not found under $ReleaseDir (expected cs2-insight-agent-desktop.exe)"
}

function Invoke-DesktopBuildVer {
    param(
        [string]$FrontendRoot,
        [string]$AppVersion
    )
    Push-Location $FrontendRoot
    try {
        Write-Host "==> pnpm desktop:build:ver -- $AppVersion"
        Invoke-Native -FailMessage "desktop:build:ver failed" -Block {
            pnpm.cmd run desktop:build:ver -- $AppVersion
        }
    } finally {
        Pop-Location
    }
}

# ---------------------------------------------------------------------------
$InsightRoot = Get-InsightRepoRoot
$FrontendRoot = Join-Path $InsightRoot "frontend"
$ReleaseDir = Join-Path $FrontendRoot "src-tauri\target\release"
$BundlePython = Join-Path $FrontendRoot "src-tauri\bundle-resources\python\python.exe"
$Anyskin = Resolve-AnyskinRoot -InsightRoot $InsightRoot -Override $AnyskinRoot
$ReleaseSkinCore = Join-Path $Anyskin "scripts\release-skin-core.ps1"
$SkinCoreDist = Join-Path $Anyskin "dist\skin-core.exe"

# Tauri must write under frontend/src-tauri/target. A redirected CARGO_TARGET_DIR
# (e.g. from skin-core worktrees) puts the NSIS artifact where desktop:build:ver
# cannot find it.
if ($env:CARGO_TARGET_DIR) {
    Write-Host "Clearing inherited CARGO_TARGET_DIR=$env:CARGO_TARGET_DIR for Insight desktop build"
    Remove-Item Env:CARGO_TARGET_DIR -ErrorAction SilentlyContinue
}

Write-Host "Insight root : $InsightRoot"
Write-Host "Anyskin root : $Anyskin"
Write-Host "Version      : $Version"

if (-not (Test-Path -LiteralPath (Join-Path $FrontendRoot "package.json"))) {
    throw "frontend/package.json missing under $InsightRoot"
}
if (-not (Test-Path -LiteralPath $ReleaseSkinCore)) {
    throw "missing anyskin release script: $ReleaseSkinCore"
}

if ($RefreshPython) {
    $env:CS2_INSIGHT_REFRESH_PYTHON = "1"
}
if ($DemoparserWheel) {
    if (-not (Test-Path -LiteralPath $DemoparserWheel)) {
        throw "DemoparserWheel not found: $DemoparserWheel"
    }
    $env:CS2_INSIGHT_DEMOPARSER_WHEEL = (Resolve-Path -LiteralPath $DemoparserWheel).Path
}

try {
    # Pass 1: produce Agent PE (+ stage python into bundle-resources).
    $needPass1 = -not $ReuseExistingAgent
    if ($ReuseExistingAgent) {
        try {
            $null = Find-AgentExe -ReleaseDir $ReleaseDir
            if (-not (Test-Path -LiteralPath $BundlePython)) {
                Write-Host "ReuseExistingAgent set but bundled python missing; running Pass 1."
                $needPass1 = $true
            } else {
                Write-Host "Reusing existing Agent PE and staged python."
            }
        } catch {
            Write-Host "ReuseExistingAgent requested but Agent PE missing; running Pass 1."
            $needPass1 = $true
        }
    }

    if ($needPass1) {
        Write-Host ""
        Write-Host "=== Pass 1/2: Insight build (establish Agent PE + python for allowlist) ==="
        # Do not require skin-core yet; stage-tauri-resources skips if absent.
        Remove-Item Env:CS2_SKIN_CORE_EXE -ErrorAction SilentlyContinue
        Invoke-DesktopBuildVer -FrontendRoot $FrontendRoot -AppVersion $Version
    }

    $agentExe = Find-AgentExe -ReleaseDir $ReleaseDir
    if (-not (Test-Path -LiteralPath $BundlePython)) {
        throw "Bundled python.exe missing after Pass 1: $BundlePython"
    }

    Write-Host ""
    Write-Host "=== Build skin-core (allowlist = Agent + bundled python) ==="
    Write-Host "  Agent : $agentExe"
    Write-Host "  Python: $BundlePython"

    $skinArgs = @{
        ParentPe = @($agentExe, $BundlePython)
    }
    if (-not $SkipPack) {
        $skinArgs.Pack = $true
        if ($UpxPath) {
            $skinArgs.UpxPath = $UpxPath
        }
    } else {
        Write-Host "WARNING: -SkipPack set; shipping without UPX (release-ship only)."
    }

    Push-Location $Anyskin
    try {
        & $ReleaseSkinCore @skinArgs
        if ($LASTEXITCODE -and $LASTEXITCODE -ne 0) {
            throw "release-skin-core.ps1 failed with exit $LASTEXITCODE"
        }
    } finally {
        Pop-Location
    }

    if (-not (Test-Path -LiteralPath $SkinCoreDist)) {
        throw "skin-core.exe not produced: $SkinCoreDist"
    }
    $env:CS2_SKIN_CORE_EXE = $SkinCoreDist
    Write-Host "CS2_SKIN_CORE_EXE=$env:CS2_SKIN_CORE_EXE"

    Write-Host ""
    Write-Host "=== Pass 2/2: Insight build with skin-core embedded ==="
    Invoke-DesktopBuildVer -FrontendRoot $FrontendRoot -AppVersion $Version

    $setup = Join-Path $ReleaseDir "bundle\nsis\CS2 Insight Agent_${Version}_x64-setup.exe"
    $toolsSkin = Join-Path $FrontendRoot "src-tauri\bundle-resources\tools\skin-core.exe"

    Write-Host ""
    Write-Host "Done."
    if (Test-Path -LiteralPath $toolsSkin) {
        Write-Host "  Staged sidecar: $toolsSkin"
    } else {
        Write-Host "WARNING: tools\skin-core.exe missing after Pass 2 staging."
    }
    if (Test-Path -LiteralPath $setup) {
        Write-Host "  Installer:      $setup"
    } else {
        Write-Host "WARNING: NSIS installer not found at expected path: $setup"
    }
} finally {
    Remove-Item Env:CS2_SKIN_CORE_EXE -ErrorAction SilentlyContinue
    Remove-Item Env:CS2_INSIGHT_REFRESH_PYTHON -ErrorAction SilentlyContinue
    Remove-Item Env:CS2_INSIGHT_DEMOPARSER_WHEEL -ErrorAction SilentlyContinue
}
