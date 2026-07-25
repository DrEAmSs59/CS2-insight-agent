# Development Setup

## Prerequisites

- Windows 10 or 11
- Node.js 22
- pnpm 11.9.0
- uv 0.11.x
- Rust stable with the MSVC toolchain and Visual Studio C++ Build Tools
- Microsoft Edge WebView2 Runtime

## First-time setup

Run these commands from the repository root:

```powershell
.\packaging\demoparser-lean\setup-backend-dev.ps1

Set-Location frontend
pnpm install --frozen-lockfile
Set-Location ..
```

The backend setup creates `.venv` from `uv.lock` and verifies the project's
patched Rust `demoparser2` runtime.

## Browser development

Start the backend and frontend in separate terminals.

Terminal 1, from the repository root:

```powershell
.\.venv\Scripts\python.exe -m uvicorn app.main:app `
  --app-dir backend --reload --port 8000
```

Terminal 2:

```powershell
Set-Location frontend
pnpm run dev
```

Open `http://localhost:5173`. Vite proxies `/api/*` to the backend on port
`8000`.

## Tauri desktop development

Do not start the backend separately. Tauri starts it automatically from the
repository `.venv`.

```powershell
Set-Location frontend
pnpm run desktop:dev
```

## Tests

From the repository root:

```powershell
uv run --frozen python -m pytest backend/tests -q
pnpm --dir frontend test
cargo test --manifest-path frontend/src-tauri/Cargo.toml --locked
```
