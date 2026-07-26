# Development Setup

English | [简体中文](dev-setup.zh-CN.md)

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
patched Rust `demoparser2` runtime. If a repo-root `python\python.exe` desktop
packaging runtime already exists, the same command also verifies and repairs its
`demoparser2` installation. It does not create the desktop runtime when absent.

## Browser development

Start the backend and frontend in separate terminals.

Terminal 1, from the repository root:

```powershell
.\.venv\Scripts\python.exe -m uvicorn app.main:app --app-dir backend --port 8000
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

## Manual Windows packaging

Run release builds from a clean PowerShell terminal at the repository root.
Use `desktop:build:ver` rather than `desktop:build` so the requested version is
applied consistently to the frontend, Tauri/NSIS metadata, and the bundled
backend.

### Full reproducible build

Use this flow for the first package, after Python dependency changes, or after
the required `demoparser2` runtime version changes. Replace `2.4.0` with the
version being built.

```powershell
$version = "2.4.0"

# Synchronize .venv, build the exact patched Rust wheel, and verify it.
.\packaging\demoparser-lean\setup-backend-dev.ps1 -BuildFromSource

# Select the wheel required by the shared runtime metadata. Do not select an
# arbitrary demoparser2-*.whl because dist/wheels may contain older builds.
$runtime = Get-Content .\packaging\demoparser-lean\demoparser-runtime.json -Raw |
    ConvertFrom-Json
$wheel = Get-ChildItem -LiteralPath .\dist\wheels -File `
    -Filter "demoparser2-$($runtime.distribution_version)-cp312-cp312-win_amd64.whl" |
    Sort-Object LastWriteTimeUtc -Descending |
    Select-Object -First 1
if (-not $wheel) {
    throw "Required patched demoparser2 wheel was not created."
}

# Force a fresh, lean repo-root python\ runtime for the installer.
$env:CS2_INSIGHT_DEMOPARSER_WHEEL = $wheel.FullName
$env:CS2_INSIGHT_REFRESH_PYTHON = "1"

Push-Location frontend
try {
    pnpm.cmd install --frozen-lockfile
    if ($LASTEXITCODE -ne 0) { throw "pnpm install failed." }

    pnpm.cmd run desktop:build:ver -- $version
    if ($LASTEXITCODE -ne 0) { throw "Desktop build failed." }
} finally {
    Pop-Location
    Remove-Item Env:CS2_INSIGHT_DEMOPARSER_WHEEL -ErrorAction SilentlyContinue
    Remove-Item Env:CS2_INSIGHT_REFRESH_PYTHON -ErrorAction SilentlyContinue
}
```

The build performs the frontend production build, stages the backend and lean
Python runtime, compiles the Tauri executable, creates the NSIS installer, and
validates the final Windows bundle. The outputs are:

```text
frontend/src-tauri/target/release/bundle/nsis/CS2 Insight Agent_<version>_x64-setup.exe
frontend/src-tauri/target/release/bundle/nsis/CS2 Insight Agent_<version>_x64-setup.exe.sig
```

The `.sig` updater signature is produced only when an updater private key is
available. The installer can still be built locally without one.

### Fast repeat build

When the full build has already staged `python\python.exe` and neither the
Python lock nor the patched parser version has changed, verify the runtime and
rebuild without recreating it:

```powershell
$version = "2.4.0"
.\packaging\demoparser-lean\setup-backend-dev.ps1

Push-Location frontend
try {
    pnpm.cmd run desktop:build:ver -- $version
    if ($LASTEXITCODE -ne 0) { throw "Desktop build failed." }
} finally {
    Pop-Location
}
```

If this reports an incompatible repo-root Python runtime, use the full
reproducible build above. The setup script repairs an existing desktop parser,
but the full flow also recreates all locked runtime dependencies.

### Optional updater signing

Generate the updater key once from `frontend` and keep the private key backed
up securely:

```powershell
Push-Location frontend
try {
    node .\node_modules\@tauri-apps\cli\tauri.js signer generate `
        -w "$env:USERPROFILE\.tauri\cs2-insight-agent.key"
} finally {
    Pop-Location
}
```

`desktop:build:ver` automatically uses that default key. If it has a non-empty
password, set `TAURI_SIGNING_PRIVATE_KEY_PASSWORD` in the build terminal. This
updater signature is separate from Windows Authenticode signing; see
`packaging/windows/RELEASE-WINDOWS.md` for production certificate setup and the
release/upload checklist.

## Tests

From the repository root:

```powershell
uv run --frozen python -m pytest backend/tests -q
pnpm --dir frontend test
cargo test --manifest-path frontend/src-tauri/Cargo.toml --locked
```
