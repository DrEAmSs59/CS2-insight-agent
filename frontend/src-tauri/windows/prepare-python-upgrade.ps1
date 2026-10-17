param(
    [Parameter(Mandatory = $true)][string]$InstallDir,
    [ValidateRange(1, 60)][int]$WaitSeconds = 15
)

$ErrorActionPreference = 'Stop'
try {
    # NSIS is 32-bit even when installing the x64 application. The hook must
    # launch native PowerShell so Process.Path can identify the bundled Python.
    if ([Environment]::Is64BitOperatingSystem -and -not [Environment]::Is64BitProcess) {
        throw 'The installer must use 64-bit PowerShell to inspect Python processes.'
    }
    $runtimeDir = Join-Path ([IO.Path]::GetFullPath($InstallDir)) 'python'
    if (-not (Test-Path -LiteralPath $runtimeDir)) { exit 0 }
    $runtimePrefix = $runtimeDir.TrimEnd('\') + '\'
    $deadline = [DateTime]::UtcNow.AddSeconds($WaitSeconds)
    do {
        $pending = @()
        # Include workers and pythonw; neither has to own the HTTP listen port.
        foreach ($process in @(Get-Process -Name python, pythonw -ErrorAction SilentlyContinue)) {
            $processPath = $process.Path
            if ($processPath -and $processPath.StartsWith($runtimePrefix, [StringComparison]::OrdinalIgnoreCase)) {
                try {
                    Stop-Process -InputObject $process -Force -ErrorAction Stop
                    if (-not $process.WaitForExit(1000)) { $pending += "PID $($process.Id)" }
                } catch {
                    if (-not $process.HasExited) { $pending += "PID $($process.Id): $($_.Exception.Message)" }
                }
            }
        }

        # A loaded native extension can remain locked after its server stops
        # listening. Check before NSIS deletes or overwrites any runtime files.
        foreach ($file in @(Get-ChildItem -LiteralPath $runtimeDir -Recurse -File |
                Where-Object { $_.Extension -in '.pyd', '.dll', '.exe' })) {
            $stream = $null
            try {
                $stream = [IO.File]::Open($file.FullName, [IO.FileMode]::Open,
                    [IO.FileAccess]::ReadWrite, [IO.FileShare]::None)
            } catch {
                $pending += $file.FullName
            } finally {
                if ($null -ne $stream) { $stream.Dispose() }
            }
        }
        if ($pending.Count -eq 0) {
            Write-Output 'Bundled Python processes stopped; native runtime files are writable.'
            exit 0
        }
        if ([DateTime]::UtcNow -ge $deadline) {
            throw ('Runtime files are still in use or not writable: ' + (($pending | Select-Object -First 5) -join '; '))
        }
        Start-Sleep -Milliseconds 250
    } while ($true)
} catch {
    Write-Output $_.Exception.Message
    exit 1
}
