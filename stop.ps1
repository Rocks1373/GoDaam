$ErrorActionPreference = "SilentlyContinue"

function Stop-Port([int]$port) {
  $lines = netstat -ano | Select-String (":$port\s+.*LISTENING\s+(\d+)$")
  $pids = @()
  foreach ($m in $lines.Matches) { $pids += [int]$m.Groups[1].Value }
  $pids = $pids | Sort-Object -Unique
  foreach ($pid in $pids) {
    try { Stop-Process -Id $pid -Force } catch {}
  }
}

Stop-Port 3001
Stop-Port 5173
Stop-Port 8081
Stop-Port 8090
Write-Host "Stopped anything listening on 3001/5173/8081/8090 (if any)."

