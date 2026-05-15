#Requires -Version 5.1
param(
  [Parameter(Mandatory = $true)]
  [string] $AppRoot
)
$ErrorActionPreference = "Stop"
$VerbosePreference = "SilentlyContinue"
$InformationPreference = "SilentlyContinue"
# Leave $ProgressPreference default (Continue) so Write-Progress is visible during download / hash.
try {
  if ($env:ComSpec) { & $env:ComSpec /c "chcp 65001>nul" | Out-Null }
} catch { }
$cs2Utf8 = [System.Text.UTF8Encoding]::new($false)
[Console]::OutputEncoding = $cs2Utf8
[Console]::InputEncoding = $cs2Utf8
$OutputEncoding = $cs2Utf8
$AppRoot = (Resolve-Path $AppRoot).Path
$metaPath = Join-Path $PSScriptRoot "ffmpeg-redist.json"
if (-not (Test-Path $metaPath)) {
  $metaPath = Join-Path $AppRoot "scripts\ffmpeg-redist.json"
}
$meta = Get-Content $metaPath -Raw | ConvertFrom-Json
$tmp = Join-Path $env:TEMP ("cs2insight-ff-" + [Guid]::NewGuid().ToString("n"))
New-Item -ItemType Directory -Path $tmp -Force | Out-Null
$zipPath = Join-Path $tmp "ffmpeg.zip"

function Download-FileWithProgress {
  param(
    [string] $Uri,
    [string] $DestPath,
    [string] $Activity = "Downloading FFmpeg (optional)"
  )
  try {
    [Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12
  } catch { }

  $maxTotal = [TimeSpan]::FromSeconds(1800)
  $deadline = [Diagnostics.Stopwatch]::StartNew()

  $request = [System.Net.WebRequest]::Create($Uri)
  $request.UserAgent = "CS2-Insight-Agent-FFmpeg-Installer/1.0"
  $request.Timeout = 30000
  if ($request -is [System.Net.HttpWebRequest]) {
    $request.ReadWriteTimeout = 120000
    $request.AllowAutoRedirect = $true
  }

  $prevProgress = $ProgressPreference
  $ProgressPreference = "Continue"
  try {
    $response = $request.GetResponse()
    try {
      $total = [int64]$response.ContentLength
      if ($total -lt 0) { $total = -1 }
      $inStream = $response.GetResponseStream()
      $outStream = [System.IO.File]::Create($DestPath)
      try {
        $buf = New-Object byte[] (256 * 1024)
        $received = [int64]0
        $uiThrottle = [Diagnostics.Stopwatch]::StartNew()
        if ($total -gt 0) {
          Write-Progress -Activity $Activity -Status ("0.0 / {0:n1} MB (0%)" -f ($total / 1MB)) -PercentComplete 0 -Id 77
        }
        else {
          Write-Progress -Activity $Activity -Status "Downloading (total size unknown)..." -PercentComplete -1 -Id 77
        }
        while ($true) {
          if ($deadline.Elapsed -gt $maxTotal) {
            throw "Download timed out after $($maxTotal.TotalMinutes) minutes."
          }
          $n = $inStream.Read($buf, 0, $buf.Length)
          if ($n -le 0) { break }
          $outStream.Write($buf, 0, $n)
          $received += $n
          if ($uiThrottle.ElapsedMilliseconds -ge 300) {
            $uiThrottle.Restart()
            if ($total -gt 0) {
              $pct = [Math]::Min(100, [int](100.0 * $received / $total))
              $status = "{0:n1} / {1:n1} MB ({2}%)" -f ($received / 1MB), ($total / 1MB), $pct
              Write-Progress -Activity $Activity -Status $status -PercentComplete $pct -Id 77
            }
            else {
              Write-Progress -Activity $Activity -Status ("{0:n1} MB downloaded" -f ($received / 1MB)) -PercentComplete -1 -Id 77
            }
          }
        }
        if ($total -gt 0 -and $received -ne $total) {
          throw "Download incomplete: received $received bytes, expected $total."
        }
      }
      finally {
        $outStream.Close()
        $inStream.Close()
      }
    }
    finally {
      $response.Close()
    }
  }
  finally {
    Write-Progress -Activity $Activity -Completed -Id 77
    $ProgressPreference = $prevProgress
  }
}

function Expand-ZipQuiet([string]$ZipPath, [string]$DestDir) {
  Add-Type -AssemblyName System.IO.Compression.FileSystem
  [System.IO.Compression.ZipFile]::ExtractToDirectory($ZipPath, $DestDir)
}

try {
  Write-Host "[CS2 Insight Agent] Downloading FFmpeg (optional) - watch the green progress bar at the top of this window."
  Download-FileWithProgress -Uri $meta.zip_url -DestPath $zipPath
  Write-Host "[CS2 Insight Agent] Verifying FFmpeg zip SHA256..."
  $hash = (Get-FileHash -Path $zipPath -Algorithm SHA256).Hash.ToLowerInvariant()
  if ($hash -ne $meta.sha256.ToLowerInvariant()) {
    throw "FFmpeg zip SHA256 mismatch: expected $($meta.sha256) got $hash"
  }
  Write-Host "[CS2 Insight Agent] Extracting FFmpeg into app folder..."
  $extractRoot = Join-Path $tmp "extract"
  New-Item -ItemType Directory -Path $extractRoot -Force | Out-Null
  Expand-ZipQuiet -ZipPath $zipPath -DestDir $extractRoot
  $srcFf = Join-Path $extractRoot ($meta.zip_relative_ffmpeg -replace "/", "\")
  $srcFb = Join-Path $extractRoot ($meta.zip_relative_ffprobe -replace "/", "\")
  if (-not (Test-Path $srcFf)) { throw "ffmpeg.exe not found at $srcFf" }
  if (-not (Test-Path $srcFb)) { throw "ffprobe.exe not found at $srcFb" }
  $outDir = Join-Path $AppRoot "third_party\ffmpeg"
  New-Item -ItemType Directory -Path $outDir -Force | Out-Null
  Copy-Item $srcFf (Join-Path $outDir "ffmpeg.exe") -Force
  Copy-Item $srcFb (Join-Path $outDir "ffprobe.exe") -Force
} finally {
  Remove-Item -Recurse -Force $tmp -ErrorAction SilentlyContinue
}
Write-Host "[CS2 Insight Agent] FFmpeg installed to: $outDir"
