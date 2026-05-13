#requires -Version 5.1
<#
.SYNOPSIS
  Bootstrap GitHub labels, milestones, and a Projects (v2) board for CS2 Insight Agent.

.DESCRIPTION
  Uses GitHub CLI (`gh`) only. Intended to be idempotent:
  - Labels: `gh label create ... --force` updates color/description.
  - Milestones: match by title; create or PATCH description.
  - Project: reuse open project with the same title; link repo; add missing SINGLE_SELECT fields.

  Projects require token scope `project`. Refresh with:
    gh auth refresh -h github.com -s project

.PARAMETER Repo
  `owner/name` of the repository (default: current `gh repo view`).

.PARAMETER ProjectOwner
  User or org login that owns the Project (default: owner segment of Repo).

.PARAMETER ProjectTitle
  Title of the GitHub Project v2 board to create or reuse.

.PARAMETER SkipProject
  Only sync labels and milestones (no `gh project` calls).
#>
param(
  [string] $Repo = "",
  [string] $ProjectOwner = "",
  [string] $ProjectTitle = "CS2 Insight Agent Roadmap",
  [switch] $SkipProject
)

Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"

function Write-Step([string] $Message) {
  Write-Host ""
  Write-Host "==> $Message" -ForegroundColor Cyan
}

function Invoke-Gh {
  param(
    [Parameter(Mandatory = $true)]
    [string[]] $Arguments
  )
  $out = & gh @Arguments 2>&1
  if ($LASTEXITCODE -ne 0) {
    $cmd = "gh " + ($Arguments -join " ")
    $detail = if ($null -eq $out) { "" } else { ($out | Out-String).Trim() }
    throw "Command failed ($LASTEXITCODE): $cmd`n$detail"
  }
  return $out
}

function Parse-MilestoneList([object] $Raw) {
  $t = (@($Raw) -join "").Trim()
  if (-not $t -or $t -eq "[]") { return @() }
  $parsed = $t | ConvertFrom-Json
  if ($null -eq $parsed) { return @() }
  return @($parsed)
}

if (-not (Get-Command gh -ErrorAction SilentlyContinue)) {
  throw "GitHub CLI (gh) not found in PATH. Install from https://cli.github.com/"
}

if ([string]::IsNullOrWhiteSpace($Repo)) {
  $rn = Invoke-Gh @("repo", "view", "--json", "nameWithOwner", "-q", ".nameWithOwner")
  $Repo = (@($rn) -join "").Trim()
}

if ([string]::IsNullOrWhiteSpace($Repo) -or $Repo -notmatch "^[^/]+/[^/]+$") {
  throw "Could not resolve Repo. Pass -Repo owner/name or run inside a gh-linked git clone."
}

if ([string]::IsNullOrWhiteSpace($ProjectOwner)) {
  $ProjectOwner = ($Repo -split "/")[0]
}

Write-Step "Repository: $Repo | Project owner: $ProjectOwner | Project title: $ProjectTitle"

# --- Labels (create or update) ---
Write-Step "Syncing labels"
$labelDefs = @(
  @{ n = "type: bug"; c = "D73A4A"; d = "Defect / incorrect behavior" },
  @{ n = "type: enhancement"; c = "A2EEEF"; d = "Improvement to existing behavior" },
  @{ n = "type: feature"; c = "1D76DB"; d = "New capability or user-facing addition" },
  @{ n = "type: refactor"; c = "FBCA04"; d = "Internal change without intended user-visible behavior change" },
  @{ n = "type: docs"; c = "0075CA"; d = "Documentation / guidance" },
  @{ n = "area: OBS"; c = "5319E7"; d = "OBS WebSocket / recording integration" },
  @{ n = "area: demo-parser"; c = "C5DEF5"; d = "Demo parsing / demoparser2 pipeline" },
  @{ n = "area: recorder"; c = "B60205"; d = "Recording flow (CS2 + director)" },
  @{ n = "area: radar"; c = "0E8A16"; d = "Radar / map overlays" },
  @{ n = "area: UI"; c = "F9D0C4"; d = "Frontend / UX" },
  @{ n = "area: settings"; c = "BFDADC"; d = "Configuration / env / app settings" },
  @{ n = "area: release"; c = "FEF2C0"; d = "Versioning / changelog / distribution" },
  @{ n = "area: installer"; c = "DAEAF6"; d = "Packaging / setup / first-run" },
  @{ n = "priority: P0"; c = "B60205"; d = "Drop everything" },
  @{ n = "priority: P1"; c = "D93F0B"; d = "Next up / major" },
  @{ n = "priority: P2"; c = "FBCA04"; d = "Normal" },
  @{ n = "priority: P3"; c = "C2E0C6"; d = "Nice to have" },
  @{ n = "status: needs-repro"; c = "FEF2C0"; d = "Waiting for repro / evidence" },
  @{ n = "status: confirmed"; c = "0E8A16"; d = "Repro accepted; ready to schedule" },
  @{ n = "status: planned"; c = "1D76DB"; d = "Accepted for roadmap" },
  @{ n = "status: blocked"; c = "000000"; d = "Blocked on external dependency" },
  @{ n = "status: wontfix"; c = "F9D0C4"; d = "Won't be addressed (by design / out of scope)" }
)

foreach ($lb in $labelDefs) {
  Invoke-Gh @(
    "label", "create", $lb.n,
    "-R", $Repo,
    "-c", $lb.c,
    "-d", $lb.d,
    "-f"
  )
  Write-Host ("  label OK: {0}" -f $lb.n)
}

# --- Milestones ---
Write-Step "Syncing milestones"
$milestoneDefs = @(
  @{
    title       = "v1.3.x"
    description = "Maintenance / patch-line planning for v1.3.x."
  },
  @{
    title       = "v2.0.0-beta"
    description = "Beta milestone for v2.0.0."
  },
  @{
    title       = "v2.0.0"
    description = "Stable v2.0.0 release bucket."
  }
)

$milestoneJsonOpen = Invoke-Gh @("api", "repos/$Repo/milestones?state=open&per_page=100")
$milestoneJsonClosed = Invoke-Gh @("api", "repos/$Repo/milestones?state=closed&per_page=100")
$milestones = @()
$milestones += Parse-MilestoneList $milestoneJsonOpen
$milestones += Parse-MilestoneList $milestoneJsonClosed

foreach ($ms in $milestoneDefs) {
  $existing = @($milestones | Where-Object { $_.title -eq $ms.title }) | Select-Object -First 1
  if ($null -eq $existing) {
    Invoke-Gh @(
      "api", "--method", "POST", "repos/$Repo/milestones",
      "-f", "title=$($ms.title)",
      "-f", "description=$($ms.description)"
    ) | Out-Null
    Write-Host ("  milestone created: {0}" -f $ms.title)
  }
  else {
    $num = $existing.number
    Invoke-Gh @(
      "api", "--method", "PATCH", "repos/$Repo/milestones/$num",
      "-f", "description=$($ms.description)"
    ) | Out-Null
    Write-Host ("  milestone updated: {0} (#{1})" -f $ms.title, $num)
  }
}

if ($SkipProject) {
  Write-Step "SkipProject set: done (labels + milestones only)."
  exit 0
}

Write-Host ""
Write-Host "Tip: GitHub Projects v2 needs token scope 'project'. If the next step fails, run:" -ForegroundColor DarkYellow
Write-Host "  gh auth refresh -h github.com -s project" -ForegroundColor DarkYellow

# --- Project (v2) ---
Write-Step "Ensuring GitHub Project v2 board"
$projectNumber = $null
$projectUrl = $null

try {
  $listRaw = & gh @("project", "list", "--owner", $ProjectOwner, "--format", "json", "-L", "100") 2>&1 | Out-String
  if ($LASTEXITCODE -ne 0) { throw $listRaw }

  $listObj = $listRaw | ConvertFrom-Json
  $candidates = @($listObj.projects | Where-Object { $_.title -eq $ProjectTitle -and -not $_.closed })
  $proj = $candidates | Select-Object -First 1

  if ($null -eq $proj) {
    $createRaw = & gh @("project", "create", "--owner", $ProjectOwner, "--title", $ProjectTitle, "--format", "json") 2>&1 | Out-String
    if ($LASTEXITCODE -ne 0) { throw $createRaw }
    $proj = $createRaw | ConvertFrom-Json
    Write-Host "  created project #$($proj.number)"
  }
  else {
    Write-Host "  using existing open project #$($proj.number)"
  }

  $projectNumber = [int] $proj.number
  $projectUrl = [string] $proj.url

  $shortDesc = "CS2 Insight Agent roadmap (managed via labels + this Project). Bootstrapped by scripts/github-bootstrap.ps1."
  Invoke-Gh @("project", "edit", "$projectNumber", "--owner", $ProjectOwner, "-d", $shortDesc)

  Write-Step "Linking project to repository (idempotent)"
  $linkLog = & gh @("project", "link", "$projectNumber", "--owner", $ProjectOwner, "--repo", $Repo) 2>&1 | Out-String
  if ($LASTEXITCODE -ne 0) {
    if ($linkLog -match "(?i)already|linked|duplicate|http 422") {
      Write-Host ("  link: already linked or no-op ({0})" -f $linkLog.Trim())
    }
    else {
      throw "gh project link failed: $linkLog"
    }
  }
  else {
    Write-Host "  link OK"
  }

  Write-Step "Ensuring Project single-select fields"
  $fieldListRaw = & gh @("project", "field-list", "$projectNumber", "--owner", $ProjectOwner, "--format", "json") 2>&1 | Out-String
  if ($LASTEXITCODE -ne 0) { throw $fieldListRaw }
  $fieldListObj = $fieldListRaw | ConvertFrom-Json
  $existingFieldNames = New-Object "System.Collections.Generic.HashSet[string]" ([StringComparer]::OrdinalIgnoreCase)
  foreach ($f in @($fieldListObj.fields)) {
    if ($null -ne $f.name) {
      [void]$existingFieldNames.Add([string]$f.name)
    }
  }

  $fieldPlans = @(
    @{ name = "Priority"; options = "P0,P1,P2,P3" },
    @{ name = "Type"; options = "Bug,Feature,Optimization,Refactor,Docs" },
    @{ name = "Area"; options = "OBS,Demo Parser,Recorder,Radar,UI,Settings,Release,Installer" },
    @{ name = "Target Version"; options = "v1.3.x,v2.0.0-beta,v2.0.0" },
    @{ name = "Source"; options = "QQ群,GitHub,B站,抖音,自测" },
    @{ name = "Risk"; options = "Low,Medium,High" }
  )

  foreach ($fp in $fieldPlans) {
    if ($existingFieldNames.Contains($fp.name)) {
      Write-Host ("  field exists, skip create: {0}" -f $fp.name)
      continue
    }
    Invoke-Gh @(
      "project", "field-create", "$projectNumber",
      "--owner", $ProjectOwner,
      "--name", $fp.name,
      "--data-type", "SINGLE_SELECT",
      "--single-select-options", $fp.options
    )
    Write-Host ("  field created: {0}" -f $fp.name)
    [void]$existingFieldNames.Add($fp.name)
  }
}
catch {
  Write-Error ($_.Exception.Message)
  Write-Host @"

Project step failed. Labels and milestones may already be updated.
Fix authentication/scopes, then re-run without -SkipProject:

  gh auth status
  gh auth refresh -h github.com -s project

"@
  exit 1
}

Write-Step "Done"
Write-Host ""
Write-Host "Project number: $projectNumber" -ForegroundColor Green
Write-Host "Project URL:    $projectUrl" -ForegroundColor Green
Write-Host ""
Write-Host @"
Next steps:
  1) Commit and push Issue templates under .github/ISSUE_TEMPLATE/ (this script does not git commit).
  2) In the Project board, set field values / views as you like; optional workflow: Project settings -> Workflows -> auto-add issues from $Repo.
  3) Optional Issue form automation: add top-level `projects:` pointing at `"$ProjectOwner/$projectNumber"` once templates are on the default branch (requires appropriate permissions for issue authors).
  4) If you forked the repo, update .github/ISSUE_TEMPLATE/config.yml contact_links URL.

Open in browser:
  gh project view $projectNumber --owner $ProjectOwner --web
"@
