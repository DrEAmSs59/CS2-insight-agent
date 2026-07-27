@echo off
setlocal
cd /d "%~dp0\..\.."

if not exist ".venv\Scripts\python.exe" (
  echo [desktop:dev] Missing .venv\Scripts\python.exe.
  echo Run packaging\demoparser-lean\setup-backend-dev.ps1 once, then retry.
  exit /b 1
)

if not exist "frontend\node_modules\.bin\tauri.cmd" (
  echo [desktop:dev] Frontend dependencies are not installed.
  echo Run pnpm.cmd --dir frontend install --frozen-lockfile once, then retry.
  exit /b 1
)

cd /d "frontend"
echo CS2 Insight Agent - Tauri hot-reload development
echo Frontend edits use Vite HMR; no NSIS installer will be built.
call pnpm.cmd run desktop:dev
exit /b %errorlevel%
