"""CS2 玩家配置磁盘备份、manifest 与 recording_state 持久化（录制异常恢复）。"""

from __future__ import annotations

import json
import logging
import os
import shutil
import subprocess
import sys
import time
from pathlib import Path
from typing import Any, Optional

from .env_utils import get_data_dir
from .win_cs2_console import find_cs2_hwnd

logger = logging.getLogger(__name__)

_BACKUP_DIR_NAME = ".cs2_config_backup"
RECORDING_STATE_FILENAME = "recording_state.json"
MANIFEST_FILENAME = "manifest.json"
README_FILENAME = "恢复说明.txt"
RECORDING_STATE_VERSION = 1
MANIFEST_VERSION = 4

RECOVERY_README_TEXT = """这是 CS2 Insight Agent 在录制前自动保存的玩家原始配置。

如果软件异常退出，导致 CS2 键位、画面设置或控制台参数没有恢复，请使用软件内的“一键恢复玩家配置”功能。

恢复前请注意：

1. 请先关闭 CS2。
2. 然后打开 CS2 Insight Agent。
3. 在软件提示中点击“一键恢复玩家配置”。
4. 恢复完成后重新进入 CS2。

请不要手动修改本目录下的 manifest.json。
请不要删除本目录，否则可能无法恢复录制前的玩家配置。
"""

CONFIG_RESTORE_REQUIRED = {
    "code": "CONFIG_RESTORE_REQUIRED",
    "message": "检测到上次录制可能异常退出，玩家配置尚未恢复。请先关闭 CS2，并点击一键恢复玩家配置。",
}


def get_backup_root() -> Path:
    """``<repo>/data/.cs2_config_backup``（旧版本曾为仓库根下的同名目录，启动时自动迁入 data）。"""
    return get_data_dir() / _BACKUP_DIR_NAME


def get_recording_state_path() -> Path:
    return get_backup_root() / RECORDING_STATE_FILENAME


def get_manifest_path() -> Path:
    return get_backup_root() / MANIFEST_FILENAME


def read_recording_state() -> dict[str, Any]:
    p = get_recording_state_path()
    if not p.is_file():
        return {}
    try:
        return json.loads(p.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError) as e:
        logger.warning("read recording_state failed: %s", e)
        return {}


def write_recording_state(status: str, extra: Optional[dict[str, Any]] = None) -> None:
    state_path = get_recording_state_path()
    backup_dir = state_path.parent
    backup_dir.mkdir(parents=True, exist_ok=True)
    now = time.time()
    payload: dict[str, Any] = {
        "version": RECORDING_STATE_VERSION,
        "status": status,
        "started_at": now,
        "started_at_iso": time.strftime("%Y-%m-%d %H:%M:%S", time.localtime(now)),
        "backup_dir": str(backup_dir.resolve()),
    }
    if status == "recording":
        payload["message"] = "录制中，玩家配置已备份，等待正常恢复"
    elif status == "recorded":
        payload["message"] = "玩家配置状态正常"
    if extra:
        payload.update(extra)
    tmp = state_path.with_suffix(".json.tmp")
    tmp.write_text(json.dumps(payload, ensure_ascii=False, indent=2), encoding="utf-8")
    os.replace(tmp, state_path)


def is_restore_required() -> bool:
    return read_recording_state().get("status") == "recording"


def extract_steam_account_id(path: Path) -> Optional[str]:
    parts = path.parts
    for i, part in enumerate(parts):
        if part.lower() == "userdata" and i + 1 < len(parts):
            cand = parts[i + 1]
            if cand.isdigit():
                return cand
    return None


def _steam_backup_prefix(account_id: Optional[str]) -> str:
    if account_id:
        return f"Steam账号_{account_id}"
    return "未知账号"


def make_backup_relpath(original: Path, used: set[str]) -> str:
    account_id = extract_steam_account_id(original)
    prefix = _steam_backup_prefix(account_id)
    fname = original.name
    base = f"{prefix}/730/local/cfg/{fname}"
    if base not in used:
        used.add(base)
        return base
    stem = original.stem
    suf = original.suffix
    h = hex(abs(hash(str(original.resolve()))))[-8:]
    candidate = f"{prefix}/730/local/cfg/{stem}_{h}{suf}"
    n = 0
    while candidate in used:
        n += 1
        candidate = f"{prefix}/730/local/cfg/{stem}_{h}_{n}{suf}"
    used.add(candidate)
    return candidate


def read_manifest() -> dict[str, Any]:
    p = get_manifest_path()
    if not p.is_file():
        return {}
    try:
        return json.loads(p.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError) as e:
        logger.warning("read manifest failed: %s", e)
        return {}


def write_manifest(manifest: dict[str, Any]) -> None:
    p = get_manifest_path()
    tmp = p.with_suffix(".json.tmp")
    tmp.write_text(json.dumps(manifest, ensure_ascii=False, indent=2), encoding="utf-8")
    os.replace(tmp, p)


def is_cs2_running() -> bool:
    """Return True when CS2 has either a visible window or a live cs2.exe process."""
    if sys.platform != "win32":
        return bool(find_cs2_hwnd())
    if find_cs2_hwnd():
        return True
    try:
        cp = subprocess.run(
            ["tasklist", "/FI", "IMAGENAME eq cs2.exe", "/NH"],
            creationflags=getattr(subprocess, "CREATE_NO_WINDOW", 0),
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            text=True,
            timeout=5,
        )
        if "cs2.exe" in (cp.stdout or "").lower():
            return True
    except Exception as e:  # noqa: BLE001
        logger.debug("Could not query cs2.exe via tasklist: %s", e)

    try:
        cp = subprocess.run(
            [
                "powershell",
                "-NoProfile",
                "-ExecutionPolicy",
                "Bypass",
                "-Command",
                "if (Get-Process -Name cs2 -ErrorAction SilentlyContinue) { 'cs2' }",
            ],
            creationflags=getattr(subprocess, "CREATE_NO_WINDOW", 0),
            stdout=subprocess.PIPE,
            stderr=subprocess.DEVNULL,
            text=True,
            timeout=5,
        )
        return "cs2" in (cp.stdout or "").lower()
    except Exception as e:  # noqa: BLE001
        logger.debug("Could not query cs2.exe via PowerShell: %s", e)
        return False


def _atomic_write_bytes(target: Path, data: bytes) -> None:
    target.parent.mkdir(parents=True, exist_ok=True)
    tmp = target.with_suffix(target.suffix + ".cs2insight.tmp")
    tmp.write_bytes(data)
    os.replace(tmp, target)


def restore_latest_user_config_backup(*, skip_cs2_running_check: bool = False) -> dict[str, Any]:
    """按 manifest 将备份写回原始路径；全部成功后将 ``recording_state`` 置为 ``recorded``。"""
    backup_root = get_backup_root()
    manifest = read_manifest()
    entries: list[dict[str, Any]] = list(manifest.get("entries") or [])
    state = read_recording_state()
    status_was = state.get("status")

    if not entries:
        if status_was == "recording":
            return {
                "ok": False,
                "restored": 0,
                "failed": [{"original": "", "error": "manifest 缺失或 entries 为空，无法恢复"}],
            }
        return {"ok": True, "restored": 0, "failed": [], "message": "无 manifest 备份"}

    if not skip_cs2_running_check and is_cs2_running():
        return {
            "ok": False,
            "code": "CS2_RUNNING",
            "restored": 0,
            "failed": [],
            "message": "请先关闭 CS2 后再恢复玩家配置",
        }

    failed: list[dict[str, str]] = []
    restored = 0

    for ent in entries:
        orig_s = ent.get("original")
        if not orig_s:
            continue
        original = Path(orig_s)
        existed = bool(ent.get("existed", True))
        rel = ent.get("backup_relpath")

        try:
            if existed:
                if not rel:
                    failed.append({"original": str(original), "error": "manifest 缺少 backup_relpath"})
                    continue
                src = backup_root / str(rel)
                if not src.is_file():
                    failed.append({"original": str(original), "error": f"备份文件不存在: {rel}"})
                    continue
                data = src.read_bytes()
                _atomic_write_bytes(original, data)
                restored += 1
            else:
                if original.is_file():
                    original.unlink()
                    restored += 1
        except OSError as e:
            failed.append({"original": str(original), "error": str(e)})

    if failed:
        return {"ok": False, "restored": restored, "failed": failed}

    if status_was == "recording":
        write_recording_state("recorded")

    return {"ok": True, "restored": restored, "failed": []}


def write_persistent_backup_from_snap(snap: dict[Path, Optional[bytes]]) -> Optional[Path]:
    """清空备份目录、按 Steam 账号分层落盘、写 manifest / 说明 / ``recording_state=recording``。"""
    if not snap:
        return None
    if is_restore_required():
        logger.warning("Refusing persistent backup: restore_required (recording state)")
        return None

    backup_dir = get_backup_root()
    try:
        if backup_dir.exists():
            shutil.rmtree(backup_dir, ignore_errors=True)
        backup_dir.mkdir(parents=True, exist_ok=True)
    except OSError as e:
        logger.warning("Persistent backup mkdir %s failed: %s", backup_dir, e)
        return None

    used_rel: set[str] = set()
    entries: list[dict[str, Any]] = []
    now = time.time()
    created_iso = time.strftime("%Y-%m-%d %H:%M:%S", time.localtime(now))

    for orig_path in sorted(snap.keys(), key=lambda p: str(p).lower()):
        original = snap[orig_path]
        account_id = extract_steam_account_id(orig_path)
        entry: dict[str, Any] = {
            "account_id": account_id or "",
            "original": str(orig_path),
            "filename": orig_path.name,
            "existed": original is not None,
        }
        if original is not None:
            rel = make_backup_relpath(orig_path, used_rel)
            target = backup_dir / rel
            try:
                target.parent.mkdir(parents=True, exist_ok=True)
                target.write_bytes(original)
            except OSError as e:
                logger.warning("Persistent backup write %s failed: %s", target, e)
                shutil.rmtree(backup_dir, ignore_errors=True)
                return None
            entry["backup_relpath"] = rel
        entries.append(entry)

    manifest: dict[str, Any] = {
        "version": MANIFEST_VERSION,
        "created_at": now,
        "created_at_iso": created_iso,
        "entries": entries,
    }
    try:
        write_manifest(manifest)
        (backup_dir / README_FILENAME).write_text(RECOVERY_README_TEXT, encoding="utf-8")
        write_recording_state("recording")
    except OSError as e:
        logger.warning("Persistent backup finalize failed: %s", e)
        shutil.rmtree(backup_dir, ignore_errors=True)
        return None

    logger.info(
        "Persistent backup written: %s (%d files)",
        backup_dir,
        len([e for e in entries if e.get("existed")]),
    )
    return backup_dir


def build_config_backup_status_payload() -> dict[str, Any]:
    state = read_recording_state()
    status = state.get("status") or "recorded"
    rr = status == "recording"
    manifest = read_manifest()
    accounts: set[str] = set()
    for ent in manifest.get("entries") or []:
        aid = ent.get("account_id")
        if aid:
            accounts.add(str(aid))
        else:
            op = ent.get("original")
            if op:
                aid2 = extract_steam_account_id(Path(str(op)))
                if aid2:
                    accounts.add(aid2)
    backup_dir = str(get_backup_root().resolve())
    msg = (
        "检测到上次录制可能异常退出，玩家配置尚未恢复。"
        if rr
        else "玩家配置状态正常"
    )
    return {
        "status": status if status in ("recording", "recorded") else "recorded",
        "restore_required": rr,
        "backup_dir": backup_dir,
        "created_at_iso": state.get("started_at_iso") or manifest.get("created_at_iso") or "",
        "accounts": sorted(accounts),
        "cs2_running": is_cs2_running(),
        "message": msg,
    }


def open_backup_directory() -> dict[str, Any]:
    root = get_backup_root()
    try:
        root.mkdir(parents=True, exist_ok=True)
    except OSError:
        pass
    path_str = str(root.resolve())
    try:
        if sys.platform == "win32":
            os.startfile(path_str)  # noqa: S606
        elif sys.platform == "darwin":
            subprocess.run(["open", path_str], check=False, timeout=30)
        else:
            subprocess.run(["xdg-open", path_str], check=False, timeout=30)
        return {"ok": True, "backup_dir": path_str}
    except Exception as e:  # noqa: BLE001
        logger.warning("open backup dir failed: %s", e)
        return {
            "ok": False,
            "backup_dir": path_str,
            "message": "无法自动打开目录，请手动复制路径打开。",
        }
