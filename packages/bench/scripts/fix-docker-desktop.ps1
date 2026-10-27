# Docker Desktop on this Windows machine often fails to start after an unclean stop: a leftover AF_UNIX socket
# file (a ReparsePoint) in %LOCALAPPDATA%\Docker\run or \docker-secrets-engine cannot be deleted, and the backend
# stops with "listening on unix://...: remove ...: The file cannot be accessed by the system."
# Renaming the containing directory works where deleting the file does not. Docker recreates both on boot.
#
# Usage:  powershell -ExecutionPolicy Bypass -File scripts/fix-docker-desktop.ps1
Get-Process | Where-Object { $_.Name -match '^(Docker Desktop|com\.docker\..*|docker)$' } |
  ForEach-Object { Stop-Process -Id $_.Id -Force -ErrorAction SilentlyContinue }
wsl --shutdown
Start-Sleep -Seconds 5
$stamp = Get-Date -Format 'yyyyMMddHHmmss'
foreach ($d in @("$env:LOCALAPPDATA\Docker\run", "$env:LOCALAPPDATA\docker-secrets-engine")) {
  if (Test-Path $d) {
    try { Rename-Item $d "$d.stale-$stamp" -ErrorAction Stop; "renamed $d" }
    catch { "could not rename ${d}: $($_.Exception.Message)" }
  }
}
Remove-Item "$env:LOCALAPPDATA\Docker\backend.error.json" -Force -ErrorAction SilentlyContinue
Start-Process "$env:ProgramFiles\Docker\Docker\Docker Desktop.exe"
"Docker Desktop relaunched; wait until 'docker info' answers."
