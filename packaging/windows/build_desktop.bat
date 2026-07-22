@echo off
setlocal
cd /d "%~dp0\..\..\frontend"
echo CS2 Insight Agent - Tauri desktop build
if not "%~1"=="" set "CS2_INSIGHT_PORTABLE_PYTHON_DIR=%~1"
call npm.cmd run desktop:build
exit /b %errorlevel%
