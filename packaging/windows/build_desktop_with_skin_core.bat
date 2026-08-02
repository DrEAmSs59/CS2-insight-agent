@echo off
setlocal EnableExtensions
cd /d "%~dp0\..\.."

if "%~1"=="" (
  echo Usage: %~nx0 ^<x.y.z^> [extra args for the .ps1...]
  echo Example: %~nx0 2.4.0
  echo Example: %~nx0 2.4.0 -SkipPack
  echo Example: %~nx0 2.4.0 -ReuseExistingAgent
  echo Example: %~nx0 2.4.0 -AnyskinRoot D:\src\CS2-demo-anyskin
  echo.
  echo Requires sibling checkout: ..\CS2-demo-anyskin
  exit /b 1
)

set "VERSION=%~1"
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0build_desktop_with_skin_core.ps1" -Version "%VERSION%" %2 %3 %4 %5 %6 %7 %8 %9
exit /b %errorlevel%
