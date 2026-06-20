#Requires -Version 5.1
# Hot-patch a local dev build into an existing Electron install (planners + Electron UI in app.asar).
# Usage:
#   powershell -NoProfile -ExecutionPolicy Bypass -File packaging\windows\patch-electron-install.ps1 `
#     -InstallRoot "E:\programs\CS2InsightAgent\CS2 Insight Agent"

param(
    [string]$InstallRoot = "E:\programs\CS2InsightAgent\CS2 Insight Agent"
)

$ErrorActionPreference = "Stop"
$repoRoot = Resolve-Path (Join-Path $PSScriptRoot "..\..")
$resources = Join-Path $InstallRoot "resources"
if (-not (Test-Path (Join-Path $resources "backend"))) {
    throw "Electron resources not found under: $resources"
}

Write-Host "[patch] Building frontend..."
Push-Location (Join-Path $repoRoot "frontend")
try {
    npm run build
} finally {
    Pop-Location
}

$plannerSrc = Join-Path $repoRoot "backend\app\recording\planners"
$plannerDst = Join-Path $resources "backend\app\recording\planners"
foreach ($f in @("pov_interleave.py", "event_clip_planner.py", "event_compilation_planner.py", "ai_directed_planner.py")) {
    Copy-Item (Join-Path $plannerSrc $f) $plannerDst -Force
    Write-Host "[patch] backend -> planners/$f"
}

$backendAppSrc = Join-Path $repoRoot "backend\app"
$backendAppDst = Join-Path $resources "backend\app"
foreach ($f in @("ai_reviewer.py", "llm_compat.py", "env_utils.py")) {
    $src = Join-Path $backendAppSrc $f
    if (Test-Path $src) {
        Copy-Item $src $backendAppDst -Force
        Write-Host "[patch] backend -> app/$f"
    }
}

$recordingRootSrc = Join-Path $repoRoot "backend\app\recording"
$recordingRootDst = Join-Path $resources "backend\app\recording"
foreach ($f in @("ai_director.py", "plan_builder.py", "models.py", "api.py", "normalizer.py", "roster_utils.py")) {
    $src = Join-Path $recordingRootSrc $f
    if (Test-Path $src) {
        Copy-Item $src $recordingRootDst -Force
        Write-Host "[patch] backend -> recording/$f"
    }
}

$postSrc = Join-Path $repoRoot "backend\app\recording\postprocess\segment_postprocessor.py"
$postDst = Join-Path $resources "backend\app\recording\postprocess\segment_postprocessor.py"
if (Test-Path $postSrc) {
    Copy-Item $postSrc $postDst -Force
    Write-Host "[patch] backend -> postprocess/segment_postprocessor.py"
}

$executorSrc = Join-Path $repoRoot "backend\app\recording\executor\recording_executor.py"
$executorDst = Join-Path $resources "backend\app\recording\executor\recording_executor.py"
if (Test-Path $executorSrc) {
    Copy-Item $executorSrc $executorDst -Force
    Write-Host "[patch] backend -> executor/recording_executor.py"
}

$modelsSrc = Join-Path $repoRoot "backend\app\recording\models.py"
$modelsDst = Join-Path $resources "backend\app\recording\models.py"
if (Test-Path $modelsSrc) {
    Copy-Item $modelsSrc $modelsDst -Force
    Write-Host "[patch] backend -> models.py (duplicate ok)"
}

# Electron loads UI from app.asar/dist (NOT resources/web).
$asarPath = Join-Path $resources "app.asar"
if (-not (Test-Path $asarPath)) {
    throw "app.asar not found: $asarPath"
}

$extractDir = Join-Path $env:TEMP "cs2-insight-asar-patch"
if (Test-Path $extractDir) { Remove-Item $extractDir -Recurse -Force }
Write-Host "[patch] Extracting app.asar..."
& npx --yes @electron/asar extract $asarPath $extractDir | Out-Null

$asarDist = Join-Path $extractDir "dist"
if (Test-Path $asarDist) { Remove-Item $asarDist -Recurse -Force }
Copy-Item (Join-Path $repoRoot "frontend\dist") $asarDist -Recurse -Force
Write-Host "[patch] app.asar/dist refreshed"

$asarBackup = "$asarPath.bak"
if (-not (Test-Path $asarBackup)) {
    Copy-Item $asarPath $asarBackup -Force
    Write-Host "[patch] backup -> app.asar.bak"
}
Write-Host "[patch] Repacking app.asar..."
& npx --yes @electron/asar pack $extractDir $asarPath | Out-Null
Remove-Item $extractDir -Recurse -Force

# Keep resources/web in sync for manual / legacy launches (optional).
$webDst = Join-Path $resources "web"
if (Test-Path $webDst) { Remove-Item $webDst -Recurse -Force }
Copy-Item (Join-Path $repoRoot "frontend\dist") $webDst -Recurse -Force
Write-Host "[patch] resources/web refreshed (optional mirror)"

$py = Join-Path $resources "python\python.exe"
$backendWd = Join-Path $resources "backend"
$env:PYTHONPATH = $backendWd
Push-Location $backendWd
try {
    & $py -c "from app.recording.ai_director import suggest_recording_outline; from app.recording.api import router; print('verify ok')"
} finally {
    Pop-Location
    Remove-Item Env:PYTHONPATH -ErrorAction SilentlyContinue
}

Write-Host "[patch] Done. Fully quit and restart CS2 Insight Agent.exe before testing."
