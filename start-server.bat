@echo off
rem ============================================================
rem  Event Logger - start the local static server (Windows)
rem
rem  Only needed to run the app from this machine instead of
rem  deploying it, or to migrate a legacy ./data.json.
rem  All user data lives in the browser IndexedDB; this server
rem  never writes a single byte of it.
rem
rem  Default port 3002, override with: set PORT=8080 && start-server.bat
rem ============================================================
setlocal
cd /d "%~dp0"
if "%PORT%"=="" set PORT=3002

if not exist "dist\index.html" (
  echo [Event Logger] dist\index.html not found - run "npm run build" first.
  exit /b 1
)

powershell -NoProfile -Command ^
  "if (Get-NetTCPConnection -LocalPort %PORT% -State Listen -ErrorAction SilentlyContinue) { Write-Host '[Event Logger] already running: http://localhost:%PORT%'; exit 0 };" ^
  "Start-Process -WindowStyle Hidden -FilePath 'cmd.exe' -ArgumentList '/c node server.js >> server.log 2>&1' -WorkingDirectory (Get-Location);" ^
  "Write-Host '[Event Logger] started: http://localhost:%PORT%'"
