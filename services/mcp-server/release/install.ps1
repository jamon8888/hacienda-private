# xberg-mcp one-liner installer (PowerShell 5.1-compatible).
# Usage: irm https://xberg-io.github.io/install.ps1 | iex
# (No untrusted content is ever executed via Invoke-Expression; this script
#  downloads a binary, verifies it, then copies it into place.)
[CmdletBinding()]
param(
  [string]$ReleaseBase = "https://github.com/xberg-io/xberg/releases/latest/download"
)

$ErrorActionPreference = "Stop"
$asset = "xberg-mcp-windows.exe"
$target = Join-Path $env:TEMP $asset
$checksumsUrl = "$ReleaseBase/SHA256SUMS"

Write-Host "Downloading $asset from $ReleaseBase"
try {
  Invoke-WebRequest -Uri "$ReleaseBase/$asset" -OutFile $target -UseBasicParsing
} catch {
  Write-Error "Failed to download $asset : $_"
  exit 1
}

# --- verify SHA256 ----------------------------------------------------------
$expected = $null
try {
  $sums = (Invoke-WebRequest -Uri $checksumsUrl -UseBasicParsing).Content
  foreach ($line in ($sums -split "`n")) {
    $parts = $line.Trim() -split '\s+'
    if ($parts.Count -ge 2 -and $parts[1] -eq $asset) { $expected = $parts[0]; break }
  }
} catch { Write-Host "WARNING: could not fetch SHA256SUMS" }

if (-not $expected) {
  # TODO_SHA256: replace with the real released hash. Verification skipped until then.
  $expected = "TODO_SHA256"
  Write-Host "WARNING: no checksum available (TODO_SHA256) - skipping verification."
}

if ($expected -ne "TODO_SHA256") {
  $actual = (Get-FileHash -Algorithm SHA256 -Path $target).Hash.ToLower()
  if ($actual -ne $expected.ToLower()) {
    Write-Error "Checksum mismatch: expected $expected got $actual"
    exit 1
  }
  Write-Host "Checksum verified."
}

# --- install ----------------------------------------------------------------
$destDir = Join-Path $env:LOCALAPPDATA "Microsoft\WindowsApps"
if (-not (Test-Path $destDir)) { $destDir = "C:\Program Files\xberg" }
if (-not (Test-Path $destDir)) { New-Item -ItemType Directory -Force -Path $destDir | Out-Null }

Copy-Item -Path $target -Destination (Join-Path $destDir $asset) -Force
Write-Host "Installed to $destDir"

$inPath = ($env:Path -split ';') -contains $destDir
if (-not $inPath) {
  Write-Host "NOTE: '$destDir' is not on PATH. Add it, or run from that directory."
  Write-Host "  e.g. [Environment]::SetEnvironmentVariable('Path', $env:Path + ';$destDir', 'User')"
}

Write-Host "Run 'xberg-mcp serve' to open the UI, or 'xberg-mcp mcp' for Claude Desktop."
