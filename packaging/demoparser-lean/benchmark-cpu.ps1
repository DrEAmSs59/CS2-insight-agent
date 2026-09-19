#Requires -Version 5.1
[CmdletBinding()]
param(
    [Parameter(Mandatory)][string]$BeforeWheel,
    [Parameter(Mandatory)][string]$AfterWheel,
    [Parameter(Mandatory)][string[]]$Demos,
    [string]$OutputDir = 'tmp/cpu-benchmark',
    [int]$Rounds = 3
)
$ErrorActionPreference = 'Stop'
$root = (Resolve-Path (Join-Path $PSScriptRoot '..\..')).Path
$python = Join-Path $root '.venv\Scripts\python.exe'
$output = [IO.Path]::GetFullPath((Join-Path $root $OutputDir))
New-Item -ItemType Directory -Path $output -Force | Out-Null
$before = (Resolve-Path -LiteralPath $BeforeWheel).Path
$after = (Resolve-Path -LiteralPath $AfterWheel).Path
$oldPythonPath = $env:PYTHONPATH
$oldProfiler = $env:DEMOTRACER_PROFILE
$oldPropertyProfiler = $env:DEMOTRACER_PROFILE_PROPERTIES
try {
    Remove-Item Env:DEMOTRACER_PROFILE -ErrorAction SilentlyContinue
    Remove-Item Env:DEMOTRACER_PROFILE_PROPERTIES -ErrorAction SilentlyContinue
    foreach ($variant in @('before', 'after')) {
        $wheel = if ($variant -eq 'before') { $before } else { $after }
        $dest = Join-Path $output $variant
        & $python -c 'import sys,zipfile; zipfile.ZipFile(sys.argv[1]).extractall(sys.argv[2])' $wheel $dest
        if ($LASTEXITCODE -ne 0) { throw "Cannot extract $wheel" }
    }
    $manifest = @{
        before_wheel = $before; after_wheel = $after
        before_sha256 = (Get-FileHash $before -Algorithm SHA256).Hash
        after_sha256 = (Get-FileHash $after -Algorithm SHA256).Hash
        rounds = $Rounds; demos = $Demos; profiler = $false
        rustc = (& rustc -V); python = (& $python -V)
        release = @{ opt_level = 3; lto = 'fat'; codegen_units = 1; debug = 0; strip = 'symbols'; panic = 'unwind' }
    }
    $manifest | ConvertTo-Json -Depth 5 | Set-Content (Join-Path $output 'manifest.json') -Encoding UTF8
    # One complete warm-up per variant and sample, then AB / BA / AB.
    for ($round = 0; $round -le $Rounds; $round++) {
        $order = if ($round % 2 -eq 0) { @('after','before') } else { @('before','after') }
        for ($index = 0; $index -lt $Demos.Count; $index++) {
            foreach ($variant in $order) {
                $env:PYTHONPATH = Join-Path $output $variant
                $result = Join-Path $output "sample-$index-round-$round-$variant.json"
                & $python (Join-Path $root 'backend\scripts\benchmark_demoparser_cpu.py') $Demos[$index] $result
                if ($LASTEXITCODE -ne 0) { throw "Benchmark failed: $result" }
            }
        }
    }
    for ($index = 0; $index -lt $Demos.Count; $index++) {
        $env:PYTHONPATH = Join-Path $output 'after'
        & $python (Join-Path $root 'backend\scripts\benchmark_demoparser_cpu.py') $Demos[$index] (Join-Path $output "sample-$index-reference.json") --reference
        if ($LASTEXITCODE -ne 0) { throw "Reference validation failed for sample $index" }
    }
} finally {
    $env:PYTHONPATH = $oldPythonPath
    $env:DEMOTRACER_PROFILE = $oldProfiler
    $env:DEMOTRACER_PROFILE_PROPERTIES = $oldPropertyProfiler
}
