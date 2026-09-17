@echo off
setlocal EnableExtensions
set "PORT=8787"
set "FOUND="

for /f "tokens=5" %%P in ('netstat -ano ^| findstr /R /C:":%PORT% .*LISTENING"') do (
  if not "%%P"=="0" (
    set "FOUND=1"
    echo Stopping LAN Toolbox on port %PORT% ^(PID %%P^)...
    taskkill /PID %%P /T /F >nul 2>&1
    if errorlevel 1 (
      echo Failed to stop PID %%P. Try running this file as administrator.
    ) else (
      echo Stopped.
    )
  )
)

if not defined FOUND echo LAN Toolbox is not running on port %PORT%.
if not defined NO_PAUSE pause