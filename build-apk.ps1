$ErrorActionPreference = "Stop"
$Root = Split-Path -Parent $MyInvocation.MyCommand.Path
$Mobile = Join-Path $Root "godam-mobile"
if (-not (Test-Path $Mobile)) {
  throw "godam-mobile not found under $Root"
}

$NodeDir = "C:\Program Files\nodejs"
$NpmCmd = Join-Path $NodeDir "npm.cmd"
if (-not (Test-Path $NpmCmd)) {
  throw "npm not found at '$NpmCmd'. Install Node.js from https://nodejs.org/"
}
$env:Path = "$NodeDir;$env:Path"

Write-Host ""
Write-Host "Cloud APK builds (download link appears in the terminal when the job finishes):" -ForegroundColor Cyan
Write-Host "  Dashboard:   https://expo.dev/eas" -ForegroundColor Cyan
Write-Host "  EAS docs:    https://docs.expo.dev/build-reference/apk/" -ForegroundColor Cyan
Write-Host ""

Push-Location $Mobile
try {
  $projectCheck = node -p "(() => { const fs=require('fs'); const path=require('path'); const app=JSON.parse(fs.readFileSync('app.json','utf8')); const id=app.expo?.extra?.eas?.projectId; const f=path.join('.eas','project.json'); const hasEas=fs.existsSync(f); return (id||hasEas) ? '1' : '0'; })()"
  if ($projectCheck -ne '1') {
    Write-Host "First time on this PC: link the app to Expo (creates projectId), then re-run build-apk." -ForegroundColor Yellow
    Write-Host "  1) npm run eas:login" -ForegroundColor Yellow
    Write-Host "  2) npm run eas:init" -ForegroundColor Yellow
    Write-Host "  3) npm run eas:apk:preview   (or run this script again)" -ForegroundColor Yellow
    Write-Host ""
  }
  Write-Host "Starting EAS build (profile: preview = APK, see godam-mobile/eas.json)..." -ForegroundColor Green
  & $NpmCmd run eas:apk:preview
} finally {
  Pop-Location
}
