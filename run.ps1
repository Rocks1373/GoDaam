# If .\run.ps1 fails with "running scripts is disabled", use .\run.bat / .\run.cmd
# or: powershell.exe -NoProfile -ExecutionPolicy Bypass -File .\run.ps1

$ErrorActionPreference = "Stop"

function Write-Step([string]$msg) { Write-Host "`n==> $msg" -ForegroundColor Cyan }

$Root = Split-Path -Parent $MyInvocation.MyCommand.Path
Set-Location $Root

$NodeDir = "C:\Program Files\nodejs"
$NpmCmd = Join-Path $NodeDir "npm.cmd"
if (-not (Test-Path $NpmCmd)) {
  throw "npm not found at '$NpmCmd'. Install Node.js from https://nodejs.org/ then re-run."
}

# Ensure this session can find node/npm without relying on npm.ps1
$env:Path = "$NodeDir;$env:Path"

function Stop-Port([int]$port) {
  $lines = netstat -ano | Select-String (":$port\s+.*LISTENING\s+(\d+)$")
  $pids = @()
  foreach ($m in $lines.Matches) { $pids += [int]$m.Groups[1].Value }
  $pids = $pids | Sort-Object -Unique
  foreach ($pid in $pids) {
    try {
      Write-Host "Stopping PID $pid on port $port"
      Stop-Process -Id $pid -Force
    } catch {
      # ignore
    }
  }
}

Write-Step "Verifying toolchain"
& node -v
& $NpmCmd -v

Write-Step "Freeing common ports (best-effort)"
Stop-Port 3001
Stop-Port 5173
Stop-Port 8090

Write-Step "Installing dependencies (repo root workspaces)"
& $NpmCmd install

Write-Step "Installing mobile app dependencies (godam-mobile)"
& $NpmCmd install --prefix godam-mobile

Write-Step "Ensuring admin user exists (admin/admin123 by default)"
& node ".\backend\scripts\ensure-admin.js"

Write-Step "Starting backend + frontend + Expo (mobile)"
Write-Host "Frontend: http://localhost:5173"
Write-Host "Backend:  http://localhost:3001/api/health"
Write-Host "Mobile:   Expo dev server on port 8090 (Expo Go or emulator; see Metro terminal output)"
Write-Host ""
Write-Host "APK (cloud): Run from repo root: .\build-apk.ps1" -ForegroundColor DarkGray
Write-Host "  Dashboard: https://expo.dev/eas | Docs: https://docs.expo.dev/build-reference/apk/" -ForegroundColor DarkGray
Write-Host ""
& $NpmCmd run dev:all

