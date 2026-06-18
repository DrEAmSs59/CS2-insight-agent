@echo off
setlocal
cd /d "%~dp0"

echo CS2 Insight Agent - Electron (python 由 npm 脚本自动准备)
echo 可选第一个参数：本机 Python 目录，等价 CS2_INSIGHT_PORTABLE_PYTHON_DIR
echo.

if not "%~1"=="" set "CS2_INSIGHT_PORTABLE_PYTHON_DIR=%~1"

cd /d "%~dp0frontend"
call npm run electron:build
set "ERR=%ERRORLEVEL%"

if not %ERR%==0 (
  echo.
  echo Failed: %ERR%
  pause
  exit /b %ERR%
)

echo.
echo Done.
pause
