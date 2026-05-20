@echo off
setlocal
chcp 65001 >nul
cd /d "%~dp0"
powershell -NoProfile -WindowStyle Normal -ExecutionPolicy Bypass -File "%~dp0Launch-CS2Insight.ps1"
endlocal
