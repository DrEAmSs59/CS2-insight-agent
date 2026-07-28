import json
from pathlib import Path


REPO_ROOT = Path(__file__).resolve().parents[2]
TAURI_ROOT = REPO_ROOT / "frontend" / "src-tauri"
TAURI_BUILD_SCRIPT = REPO_ROOT / "frontend" / "scripts" / "tauri-build-version.mjs"
TAURI_RUNTIME = TAURI_ROOT / "src" / "lib.rs"


def test_tauri_identifier_and_installer_hook_are_stable():
    config = json.loads((TAURI_ROOT / "tauri.conf.json").read_text(encoding="utf-8"))

    assert config["identifier"] == "com.cs2insightagent.app"
    assert config["build"]["beforeBuildCommand"] == "node node_modules/vite/bin/vite.js build"
    hook = config["bundle"]["windows"]["nsis"]["installerHooks"]
    assert hook == "windows/upgrade-hooks.nsh"
    assert (TAURI_ROOT / hook).is_file()


def test_installer_hook_covers_electron_upgrade_surfaces():
    hook = (TAURI_ROOT / "windows" / "upgrade-hooks.nsh").read_text(encoding="utf-8")

    assert 'tasklist.exe" /FI "IMAGENAME eq $R9"' in hook
    assert 'StrCpy $R9 "CS2 Insight Agent.exe"' in hook
    assert 'StrCpy $R9 "cs2-insight-agent-desktop.exe"' in hook
    # A running Tauri shell is waited for and force-killed with its backend
    # child tree instead of aborting the install.
    assert 'taskkill.exe" /IM "cs2-insight-agent-desktop.exe" /F /T' in hook
    # An orphaned backend must not keep port 19871 busy after an upgrade.
    assert "LocalPort 19871" in hook
    # Same-directory Electron installs are retired before file copy,
    # different-directory ones only after migration (postinstall).
    assert 'StrCpy $CS2ElectronScope "samedir"' in hook
    assert 'StrCpy $CS2ElectronScope "all"' in hook
    assert "EnumRegKey $R5 HKCU" in hook
    assert "EnumRegKey $R5 HKLM" in hook
    assert "SetRegView 64" in hook
    assert "SetRegView 32" in hook
    assert "uninstall cs2 insight agent.exe" in hook.lower()
    # electron-builder's NSIS uninstaller must run from a temporary copy with
    # _?= as its final argument. Otherwise ExecWait can return after only the
    # self-copying launcher exits, leaving the old registry entry behind while
    # the large Electron runtime is still being deleted.
    assert 'CopyFiles /SILENT "$CS2ElectronUninsExe" "$PLUGINSDIR\\cs2-electron-uninstaller.exe"' in hook
    assert 'StrCpy $CS2ElectronMode "/currentuser"' in hook
    assert 'StrCpy $CS2ElectronMode "/allusers"' in hook
    assert (
        'ExecWait \'"$PLUGINSDIR\\cs2-electron-uninstaller.exe" /S /KEEP_APP_DATA '
        '$CS2ElectronMode --updated _?=$CS2ElectronDir\' $R0'
    ) in hook
    assert (
        'ExecWait \'"$CS2ElectronUninsExe" /S /KEEP_APP_DATA '
        '$CS2ElectronMode --updated _?=$CS2ElectronDir\' $R0'
    ) in hook
    assert "ExecWait '$R8 /S'" not in hook
    assert "desktop_data_migration.py" in hook
    assert "--require-desktop-stopped" in hook
    assert "--require-electron-ui-export" in hook
    # In-place upgrades must remove every historical patched-parser metadata
    # generation before copying the new runtime, not a hard-coded version list.
    assert 'FindFirst $0 $1 "$INSTDIR\\python\\Lib\\site-packages\\demoparser2-*.dist-info"' in hook
    assert 'RMDir /r "$INSTDIR\\python\\Lib\\site-packages\\demoparser2"' in hook
    assert "Call CS2_RemoveBundledDemoparser" in hook
    assert "demoparser2-0.41.4+cs2insight1.dist-info" not in hook
    # The installed parser contract is checked before the app can be launched.
    assert 'backend\\app\\demoparser_runtime.py' in hook
    assert "pyarrow-25.0.0.dist-info" in hook
    assert '!define CS2_TAURI_RELEASE_DIR "${__FILEDIR__}\\..\\target\\release"' in hook
    assert 'File /a "/oname=WebView2Loader.dll"' in hook
    assert 'Delete "$INSTDIR\\WebView2Loader.dll"' in hook
    assert "NSIS_HOOK_PREINSTALL" in hook
    assert "NSIS_HOOK_POSTINSTALL" in hook
    assert "NSIS_HOOK_POSTUNINSTALL" in hook


def test_versioned_build_rejects_missing_webview2_loader_bundle():
    script = TAURI_BUILD_SCRIPT.read_text(encoding="utf-8")

    assert "dirname(process.execPath)" in script
    assert "WebView2Loader.dll" in script
    assert "GNU Tauri build is missing required runtime loader" in script
    assert "NSIS hook does not install WebView2Loader.dll" in script
    assert "validated Windows runtime bundle" in script
    assert "createUpdaterArtifacts: false" in script
    assert "updater private key not found" in script
    assert "rmSync(updaterSignature)" in script


def test_close_destroys_webview_before_waiting_for_backend():
    source = TAURI_RUNTIME.read_text(encoding="utf-8")

    destroy = source.index("window.destroy()")
    stop = source.index("stop_backend(&handle);", destroy)
    assert destroy < stop
    # The graceful backend stop must run off the event loop thread so the
    # window disappears immediately instead of freezing on screen.
    spawn = source.index("thread::spawn", destroy)
    assert spawn < stop
