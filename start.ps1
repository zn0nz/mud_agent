[CmdletBinding()]
param(
  [switch]$InstallWsl,
  [string]$Distro = "Debian"
)

$ErrorActionPreference = "Stop"
Set-StrictMode -Version Latest

function Write-Info {
  param([string]$Message)
  Write-Host "[start.ps1] $Message"
}

function Convert-ToWslPath {
  param([string]$WindowsPath)

  if ($WindowsPath -match '^\\\\wsl(?:\.localhost)?\\([^\\]+)\\(.+)$') {
    $script:WslDistro = $Matches[1]
    return "/" + ($Matches[2] -replace '\\', '/')
  }

  $converted = & wsl.exe wslpath -a "$WindowsPath"
  if ($LASTEXITCODE -ne 0) {
    throw "Failed to convert Windows path to WSL path: $WindowsPath"
  }

  return ($converted | Select-Object -First 1).Trim()
}

function Ensure-WslReady {
  $status = & wsl.exe --status 2>&1
  $statusText = ($status | Out-String)

  if (
    $LASTEXITCODE -ne 0 -or
    $statusText -match 'no installed distributions' -or
    $statusText -match 'There is no distribution' -or
    $statusText -match 'WSL is not installed'
  ) {
    if ($InstallWsl) {
      Write-Info "Installing WSL with distro $Distro"
      & wsl.exe --install -d $Distro
      exit $LASTEXITCODE
    }

    Write-Host "WSL 2 is required because this project depends on tmux."
    Write-Host "Install it from an elevated PowerShell window with:"
    Write-Host "  wsl --install -d $Distro"
    Write-Host "Restart if prompted, then rerun .\\start.ps1."
    Write-Host "To let this script trigger the install, rerun with -InstallWsl."
    exit 1
  }
}

function Invoke-WslBash {
  param([string]$Script)

  $args = @()
  if ($script:WslDistro) {
    $args += @("-d", $script:WslDistro)
  }
  $args += @("bash", "-lc", $Script)

  & wsl.exe @args
}

function Ensure-WslPrerequisites {
  $missing = Invoke-WslBash @'
set -euo pipefail
missing=()
for command_name in node npm tmux luit telnet; do
  if ! command -v "$command_name" >/dev/null 2>&1; then
    missing+=("$command_name")
  fi
done
printf "%s\n" "${missing[@]}"
'@

  if ($LASTEXITCODE -ne 0) {
    throw "Failed to inspect WSL prerequisites."
  }

  $missing = @($missing | Where-Object { $_ -and $_.Trim() })
  if ($missing.Count -eq 0) {
    return
  }

  Write-Info ("Installing missing WSL prerequisites: " + ($missing -join ", "))
  Invoke-WslBash @'
set -euo pipefail
sudo apt update
if ! command -v node >/dev/null 2>&1 || ! command -v npm >/dev/null 2>&1; then
  if ! command -v curl >/dev/null 2>&1; then
    sudo apt install -y curl ca-certificates
  fi
  curl -fsSL https://deb.nodesource.com/setup_22.x | sudo -E bash -
  sudo apt install -y nodejs
fi
sudo apt install -y tmux telnet luit
'@

  if ($LASTEXITCODE -ne 0) {
    throw "Failed to install WSL prerequisites."
  }
}

$repoRoot = Split-Path -Parent $MyInvocation.MyCommand.Path
Set-Location $repoRoot

if (-not (Get-Command wsl.exe -ErrorAction SilentlyContinue)) {
  throw "WSL is not available. Install it with 'wsl --install -d $Distro' and rerun .\\start.ps1."
}

Ensure-WslReady

$script:WslDistro = $null
$resolvedRepoRoot = (Resolve-Path $repoRoot).Path
$wslRepoRoot = Convert-ToWslPath -WindowsPath $resolvedRepoRoot
$escapedRepoRoot = $wslRepoRoot.Replace("'", "'\"'\"'")

$wslArgs = @()
if ($script:WslDistro) {
  Write-Info "Using WSL distro $script:WslDistro for path-mounted repo"
  $wslArgs += @("-d", $script:WslDistro)
}

Ensure-WslPrerequisites

Write-Info "Delegating to start.sh inside WSL"
& wsl.exe @wslArgs bash -lc "cd '$escapedRepoRoot' && exec ./start.sh"
exit $LASTEXITCODE
