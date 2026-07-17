#Requires -Version 5.1
param(
  [string]$DemoparserWheel = ""
)

$ErrorActionPreference = "Stop"
$ProgressPreference = "SilentlyContinue"
try {
  if ($env:ComSpec) { & $env:ComSpec /c "chcp 65001>nul" | Out-Null }
} catch { }
$cs2Utf8 = [System.Text.UTF8Encoding]::new($false)
[Console]::OutputEncoding = $cs2Utf8
[Console]::InputEncoding = $cs2Utf8
$OutputEncoding = $cs2Utf8
$repoRoot = Resolve-Path (Join-Path $PSScriptRoot "..\..")
$staging = Join-Path $repoRoot "dist\staging"
$metaPath = Join-Path $PSScriptRoot "python-runtime.json"
$meta = Get-Content $metaPath -Raw | ConvertFrom-Json
$tmp = Join-Path $env:TEMP ("cs2insight-py-" + [Guid]::NewGuid().ToString("n"))
New-Item -ItemType Directory -Path $tmp -Force | Out-Null
$tarball = Join-Path $tmp "cpython-windows.tar.gz"
$previousNoUserSite = $env:PYTHONNOUSERSITE
$env:PYTHONNOUSERSITE = "1"

function Remove-TreeIfExists([string]$Path) {
  if (Test-Path -LiteralPath $Path) { Remove-Item -LiteralPath $Path -Recurse -Force }
}

try {
  Write-Host "[CS2 Insight Agent] Downloading embedded Python (this may take a few minutes)..."
  $curl = Join-Path $env:SystemRoot "System32\curl.exe"
  if (Test-Path $curl) {
    & $curl -fsSL --connect-timeout 30 --max-time 0 --retry 2 --retry-delay 1 -o $tarball $meta.tarball_url
    if ($LASTEXITCODE -ne 0) { throw "curl download failed, exit code: $LASTEXITCODE" }
  } else {
    Invoke-WebRequest -Uri $meta.tarball_url -OutFile $tarball -UseBasicParsing
  }
  Write-Host "[CS2 Insight Agent] Verifying Python tarball SHA256..."
  $hash = (Get-FileHash -Path $tarball -Algorithm SHA256).Hash.ToLowerInvariant()
  if ($hash -ne $meta.sha256.ToLowerInvariant()) {
    throw "Python tarball SHA256 mismatch: expected $($meta.sha256) got $hash"
  }
  New-Item -ItemType Directory -Path $staging -Force | Out-Null
  $extractRoot = Join-Path $tmp "extract"
  New-Item -ItemType Directory -Path $extractRoot -Force | Out-Null
  tar -xzf $tarball -C $extractRoot
  $inner = Get-ChildItem -Path $extractRoot -Directory | Select-Object -First 1
  if (-not $inner) { throw "Unexpected Python tarball layout (no top-level directory)" }
  $destPython = Join-Path $staging "python"
  if (Test-Path $destPython) { Remove-Item -Recurse -Force $destPython }
  Move-Item -Path $inner.FullName -Destination $destPython
  $py = Join-Path $destPython "python.exe"
  if (-not (Test-Path $py)) { throw "python.exe missing under $destPython" }
  & $py -m ensurepip --upgrade
  & $py -m pip install --no-cache-dir --upgrade pip==25.0
  if ($DemoparserWheel.Trim()) {
    $leanWheel = (Resolve-Path -LiteralPath $DemoparserWheel).Path
    Write-Host "[CS2 Insight Agent] Installing lean demoparser wheel..."
    & $py -m pip install --no-cache-dir --no-deps $leanWheel
    if ($LASTEXITCODE -ne 0) { throw "lean demoparser wheel install failed: $LASTEXITCODE" }
  }
  $req = Join-Path $repoRoot "backend\requirements.txt"
  & $py -m pip install --no-cache-dir -r $req
  if ($LASTEXITCODE -ne 0) { throw "backend requirements install failed: $LASTEXITCODE" }
  if ($DemoparserWheel.Trim()) {
    & $py -m pip uninstall -y polars pyarrow polars-runtime-32
    $leanMeta = Get-Content (Join-Path $repoRoot "packaging\demoparser-lean\demoparser-runtime.json") -Raw | ConvertFrom-Json
    & $py -c "import importlib.metadata as m, importlib.util as u, sys; assert m.version('demoparser2') == sys.argv[1]; assert u.find_spec('polars') is None; assert u.find_spec('pyarrow') is None" $leanMeta.distribution_version
    if ($LASTEXITCODE -ne 0) { throw "lean demoparser runtime verification failed: $LASTEXITCODE" }
  }
  & $py -m pip uninstall -y pip setuptools wheel
  if ($LASTEXITCODE -ne 0) { throw "runtime build-tool removal failed: $LASTEXITCODE" }
  Write-Host "[CS2 Insight Agent] Trimming Python runtime to reduce installer size..."
  foreach ($rel in @(
      "Lib\test",
      "Lib\idle_test",
      "Lib\idlelib",
      "Lib\lib2to3",
      "Lib\sqlite3\test",
      "Lib\venv",
      "Lib\ensurepip",
      "Lib\tkinter",
      "Lib\turtledemo",
      "Include",
      "include",
      "Doc",
      "Tools",
      "tcl"
    )) {
    Remove-TreeIfExists (Join-Path $destPython $rel)
  }
  foreach ($rel in @(
      "DLLs\_tkinter.pyd",
      "DLLs\tcl86t.dll",
      "DLLs\tk86t.dll"
    )) {
    $file = Join-Path $destPython $rel
    if (Test-Path -LiteralPath $file -PathType Leaf) { Remove-Item -LiteralPath $file -Force }
  }
  Get-ChildItem -LiteralPath $destPython -Recurse -File -Filter "*.pdb" -ErrorAction SilentlyContinue |
  ForEach-Object { Remove-Item -LiteralPath $_.FullName -Force -ErrorAction SilentlyContinue }
  $sp = Join-Path $destPython "Lib\site-packages"
  if (Test-Path $sp) {
    foreach ($pkgRel in @(
        "pandas\tests",
        "numpy\tests",
        "numpy\f2py\tests",
        "matplotlib\tests",
        "matplotlib\mpl-data\sample_data",
        "pyarrow\tests"
      )) {
      Remove-TreeIfExists (Join-Path $sp $pkgRel)
    }
    Get-ChildItem -LiteralPath $sp -Recurse -Directory -Filter "__pycache__" -ErrorAction SilentlyContinue |
    ForEach-Object { Remove-Item -LiteralPath $_.FullName -Recurse -Force -ErrorAction SilentlyContinue }
  }
  Get-ChildItem -LiteralPath $destPython -Recurse -Directory -Filter "__pycache__" -ErrorAction SilentlyContinue |
  ForEach-Object { Remove-Item -LiteralPath $_.FullName -Recurse -Force -ErrorAction SilentlyContinue }
  $backendDst = Join-Path $staging "backend"
  if (Test-Path $backendDst) { Remove-Item -Recurse -Force $backendDst }
  Copy-Item -Path (Join-Path $repoRoot "backend") -Destination $backendDst -Recurse
  Remove-TreeIfExists (Join-Path $backendDst "tests")
  Remove-TreeIfExists (Join-Path $backendDst ".pytest_cache")
  Get-ChildItem -LiteralPath $backendDst -Recurse -Directory -Filter "__pycache__" -ErrorAction SilentlyContinue |
  ForEach-Object { Remove-Item -LiteralPath $_.FullName -Recurse -Force -ErrorAction SilentlyContinue }
  $webDst = Join-Path $staging "web"
  if (Test-Path $webDst) { Remove-Item -Recurse -Force $webDst }
  Copy-Item -Path (Join-Path $repoRoot "frontend\dist") -Destination $webDst -Recurse
  Get-ChildItem -LiteralPath $webDst -Recurse -File -Filter "*.map" -ErrorAction SilentlyContinue |
  ForEach-Object { Remove-Item -LiteralPath $_.FullName -Force -ErrorAction SilentlyContinue }
  $dataDst = Join-Path $staging "data"
  New-Item -ItemType Directory -Path $dataDst -Force | Out-Null
  Copy-Item -Path (Join-Path $repoRoot "data\cs2-insight.config.example.json") -Destination (Join-Path $dataDst "cs2-insight.config.example.json") -Force
  $scriptsDst = Join-Path $staging "scripts"
  New-Item -ItemType Directory -Path $scriptsDst -Force | Out-Null
  Copy-Item -Path (Join-Path $PSScriptRoot "install-optional-ffmpeg.ps1") -Destination (Join-Path $scriptsDst "install-optional-ffmpeg.ps1") -Force
  Copy-Item -Path (Join-Path $PSScriptRoot "ffmpeg-redist.json") -Destination (Join-Path $scriptsDst "ffmpeg-redist.json") -Force
  Copy-Item -Path (Join-Path $PSScriptRoot "launch-cs2-insight.cmd") -Destination (Join-Path $staging "CS2 Insight Agent.cmd") -Force
  Copy-Item -Path (Join-Path $PSScriptRoot "Launch-CS2Insight.ps1") -Destination (Join-Path $staging "Launch-CS2Insight.ps1") -Force
  Copy-Item -Path (Join-Path $PSScriptRoot "app-icon.ico") -Destination (Join-Path $staging "app-icon.ico") -Force
} finally {
  Remove-Item -Recurse -Force $tmp -ErrorAction SilentlyContinue
  if ($null -eq $previousNoUserSite) {
    Remove-Item Env:PYTHONNOUSERSITE -ErrorAction SilentlyContinue
  } else {
    $env:PYTHONNOUSERSITE = $previousNoUserSite
  }
}
Write-Host ('Staging ready at ' + $staging)
