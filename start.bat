@echo off
setlocal
cd /d "%~dp0"

if exist "%~dp0NearbyLanToolbox.exe" (
  start "" "%~dp0NearbyLanToolbox.exe"
  goto :eof
)

if exist "%~dp0outputs\NearbyLanToolbox.exe" (
  start "" "%~dp0outputs\NearbyLanToolbox.exe"
  goto :eof
)

set "BUNDLED_NODE=%USERPROFILE%\.cache\codex-runtimes\codex-primary-runtime\dependencies\node\bin\node.exe"
where node >nul 2>nul
if %errorlevel%==0 (
  node server.js
) else if exist "%BUNDLED_NODE%" (
  "%BUNDLED_NODE%" server.js
) else (
  echo NearbyLanToolbox.exe and Node.js were not found.
  echo Put NearbyLanToolbox.exe beside this script, or install Node.js 18+.
  pause
)