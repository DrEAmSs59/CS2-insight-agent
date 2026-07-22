import json
from pathlib import Path


REPO_ROOT = Path(__file__).resolve().parents[2]
TAURI_ROOT = REPO_ROOT / "frontend" / "src-tauri"


def test_tauri_identifier_and_installer_hook_are_stable():
    config = json.loads((TAURI_ROOT / "tauri.conf.json").read_text(encoding="utf-8"))

    assert config["identifier"] == "com.cs2insightagent.app"
    hook = config["bundle"]["windows"]["nsis"]["installerHooks"]
    assert hook == "windows/upgrade-hooks.nsh"
    assert (TAURI_ROOT / hook).is_file()


def test_installer_hook_covers_electron_upgrade_surfaces():
    hook = (TAURI_ROOT / "windows" / "upgrade-hooks.nsh").read_text(encoding="utf-8")

    assert 'tasklist.exe" /FI "IMAGENAME eq CS2 Insight Agent.exe"' in hook
    assert 'IMAGENAME eq cs2-insight-agent-desktop.exe' in hook
    assert "EnumRegKey $R5 HKCU" in hook
    assert "EnumRegKey $R5 HKLM" in hook
    assert "SetRegView 64" in hook
    assert "SetRegView 32" in hook
    assert "uninstall cs2 insight agent.exe" in hook.lower()
    assert "ExecWait '$R8 /S'" in hook
    assert "desktop_data_migration.py" in hook
    assert "NSIS_HOOK_PREINSTALL" in hook
    assert "NSIS_HOOK_POSTINSTALL" in hook
