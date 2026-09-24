@echo off
rem ============================================================
rem  Event Logger - stop the local static server (Windows)
rem  Frees the port (default 3002, override with: set PORT=8080)
rem ============================================================
setlocal
if "%PORT%"=="" set PORT=3002

powershell -NoProfile -Command ^
  "$c = Get-NetTCPConnection -LocalPort %PORT% -State Listen -ErrorAction SilentlyContinue;" ^
  "if ($c) { $c.OwningProcess | Select-Object -Unique | ForEach-Object { Stop-Process -Id $_ -Force }; Write-Host '[Event Logger] stopped (port %PORT%)' } else { Write-Host '[Event Logger] was not running on port %PORT%' }"
