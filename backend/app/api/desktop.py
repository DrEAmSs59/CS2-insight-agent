"""Desktop-native file and folder chooser API routes."""

from __future__ import annotations

import asyncio
import json
import os
import re
import subprocess
import sys
from pathlib import Path

from fastapi import APIRouter, HTTPException
from pydantic import BaseModel, Field

from ..win_cs2_console import find_cs2_hwnd

router = APIRouter(tags=["desktop"])


class FilePickerBody(BaseModel):
    file_type: str = Field(default="any", pattern=r"^(audio|video_or_image|lite_cut_asset|exe|any)$")
    multiple: bool = False


_FILE_PICKER_FILTERS: dict[str, str] = {
    "audio": "音频文件|*.mp3;*.ogg;*.wav;*.flac;*.aac;*.m4a|所有文件|*.*",
    "video_or_image": "视频与图片|*.mp4;*.mov;*.mkv;*.avi;*.png;*.jpg;*.jpeg;*.webp;*.bmp;*.gif|所有文件|*.*",
    "lite_cut_asset": (
        "LiteCut 素材|*.webm;*.png;*.gif;*.jpg;*.jpeg;*.webp;*.mp4;*.mov;*.m4v;*.mkv;*.avi;"
        "*.mp3;*.wav;*.m4a;*.aac;*.ogg;*.flac;*.woff;*.woff2;*.ttf;*.otf|所有文件|*.*"
    ),
    "exe": "可执行文件|*.exe|所有文件|*.*",
    "any": "所有文件|*.*",
}


def _run_windows_file_picker(file_filter: str, multiple: bool) -> list[str]:
    escaped_filter = file_filter.replace("'", "''")
    multiselect = "$true" if multiple else "$false"
    script = (
        "[Console]::OutputEncoding = [System.Text.Encoding]::UTF8;"
        "Add-Type -AssemblyName System.Windows.Forms;"
        "$d = New-Object System.Windows.Forms.OpenFileDialog;"
        f"$d.Filter = '{escaped_filter}';"
        f"$d.Multiselect = {multiselect};"
        "$d.RestoreDirectory = $true;"
        "if ($d.ShowDialog() -eq 'OK') { "
        "[Console]::Out.Write((ConvertTo-Json -Compress -InputObject @($d.FileNames))) }"
    )
    result = subprocess.run(
        ["powershell", "-NoProfile", "-NonInteractive", "-STA", "-Command", script],
        capture_output=True,
        timeout=600,
        creationflags=getattr(subprocess, "CREATE_NO_WINDOW", 0),
    )
    if result.returncode != 0:
        message = (result.stderr or b"").decode("utf-8", errors="replace").strip()
        raise RuntimeError(message or f"PowerShell exited with code {result.returncode}")
    output = (result.stdout or b"").decode("utf-8", errors="replace").strip()
    if not output:
        return []
    decoded = json.loads(output)
    values = decoded if isinstance(decoded, list) else [decoded]
    return [str(value).strip() for value in values if str(value).strip()]


@router.post("/api/file-picker")
async def file_picker(body: FilePickerBody):
    if sys.platform != "win32":
        raise HTTPException(400, "文件浏览对话框仅 Windows 可用")

    ft = body.file_type if body.file_type in _FILE_PICKER_FILTERS else "any"

    try:
        paths = await asyncio.to_thread(
            _run_windows_file_picker,
            _FILE_PICKER_FILTERS[ft],
            body.multiple,
        )
    except Exception as exc:
        raise HTTPException(500, f"文件选择器失败: {exc}") from exc

    return {"path": paths[0] if paths else None, "paths": paths}


@router.post("/api/directory-picker")
async def directory_picker():
    """Windows directory chooser fallback for browser-based development mode."""
    if sys.platform != "win32":
        raise HTTPException(400, "文件夹选择对话框仅 Windows 可用")
    ps = (
        "[Console]::OutputEncoding = [System.Text.Encoding]::UTF8;"
        "Add-Type -AssemblyName System.Windows.Forms;"
        "$d = New-Object System.Windows.Forms.FolderBrowserDialog;"
        "$d.Description = '选择 LiteCut 素材存储目录';"
        "$d.ShowNewFolderButton = $true;"
        "if ($d.ShowDialog() -eq 'OK') { Write-Output $d.SelectedPath }"
    )

    def _run_directory_picker() -> str:
        result = subprocess.run(
            ["powershell", "-NoProfile", "-NonInteractive", "-Command", ps],
            capture_output=True,
            timeout=120,
        )
        return (result.stdout or b"").decode("utf-8", errors="replace").strip()

    try:
        path = await asyncio.to_thread(_run_directory_picker)
    except Exception as exc:
        raise HTTPException(500, f"文件夹选择器失败: {exc}") from exc
    return {"path": path or None}


class OpenFolderBody(BaseModel):
    path: str = Field(..., min_length=1, max_length=2048)


class RevealFileInExplorerBody(BaseModel):
    path: str = Field(..., min_length=1, max_length=2600)


class Cs2InspectBody(BaseModel):
    hex: str = Field(..., min_length=12, max_length=8192)


_CS2_INSPECT_HEX_PATTERN = re.compile(r"^[0-9a-fA-F]+$")


def _validated_cs2_inspect_hex(value: str) -> str:
    payload = str(value or "").strip()
    if (
        len(payload) < 12
        or len(payload) > 8192
        or len(payload) % 2 != 0
        or _CS2_INSPECT_HEX_PATTERN.fullmatch(payload) is None
    ):
        raise ValueError("CS2 检视载荷格式无效")
    return payload.upper()


def _launch_cs2_inspect_url(inspect_url: str) -> None:
    """Hand a validated CS2 preview URL to the host OS.

    Browser development mode cannot invoke Tauri commands, so the local
    backend owns this OS-level action just like Insight's other native helpers.
    """
    if sys.platform == "win32":
        os.startfile(inspect_url)  # type: ignore[attr-defined]  # noqa: S606
        return
    if sys.platform == "darwin":
        subprocess.Popen(
            ["open", inspect_url],
            stdin=subprocess.DEVNULL,
            stdout=subprocess.DEVNULL,
            stderr=subprocess.DEVNULL,
        )
        return
    subprocess.Popen(
        ["xdg-open", inspect_url],
        stdin=subprocess.DEVNULL,
        stdout=subprocess.DEVNULL,
        stderr=subprocess.DEVNULL,
    )


async def _wait_for_cs2_window(timeout: float = 75.0) -> bool:
    deadline = asyncio.get_running_loop().time() + max(1.0, timeout)
    while asyncio.get_running_loop().time() < deadline:
        if await asyncio.to_thread(find_cs2_hwnd):
            return True
        await asyncio.sleep(0.4)
    return False


async def _launch_and_deliver_cs2_inspect(payload: str) -> dict[str, bool]:
    """Ensure CS2 is ready, then dispatch the canonical game-inspect URI.

    A `+` command in the initial cold-start URI can be consumed before CS2 is
    ready. Start the game without a command in that case, wait for the real game
    window to settle, and only then send the `rungame` URI used by Steam item
    inspection. This path does not depend on keyboard focus or console binds.
    """
    already_running = bool(await asyncio.to_thread(find_cs2_hwnd))
    if not already_running:
        await asyncio.to_thread(_launch_cs2_inspect_url, "steam://run/730")
        if not await _wait_for_cs2_window():
            raise RuntimeError("等待 CS2 窗口就绪超时")
        try:
            settle_seconds = max(
                0.0,
                float(os.environ.get("CS2_INSIGHT_INSPECT_STARTUP_SETTLE_SEC", "12")),
            )
        except ValueError:
            settle_seconds = 12.0
        if settle_seconds:
            await asyncio.sleep(settle_seconds)

    inspect_url = (
        "steam://rungame/730/76561202255233023/"
        f"+csgo_econ_action_preview%20{payload}"
    )
    await asyncio.to_thread(_launch_cs2_inspect_url, inspect_url)
    return {"already_running": already_running, "dispatched": True}


@router.post("/api/cs2/inspect")
async def launch_cs2_inspect(body: Cs2InspectBody):
    try:
        payload = _validated_cs2_inspect_hex(body.hex)
    except ValueError as exc:
        raise HTTPException(422, str(exc)) from exc

    try:
        launch_result = await _launch_and_deliver_cs2_inspect(payload)
    except Exception as exc:
        raise HTTPException(400, f"无法通过 Steam 启动 CS2 检视：{exc}") from exc
    return {"ok": True, **launch_result}


@router.post("/api/open-folder")
def open_folder(body: OpenFolderBody):
    import os, subprocess as sp, sys
    p = body.path.strip()
    try:
        if sys.platform == "win32":
            os.startfile(p)  # noqa: S606
        elif sys.platform == "darwin":
            sp.run(["open", p], check=False, timeout=10)
        else:
            sp.run(["xdg-open", p], check=False, timeout=10)
    except Exception as e:
        raise HTTPException(400, str(e)) from e
    return {"ok": True}

@router.post("/api/reveal-file-in-explorer")
def reveal_file_in_explorer(body: RevealFileInExplorerBody):
    """在文件管理器中显示该 Demo：Windows 资源管理器 /select；macOS Finder -R；Linux 打开所在目录。"""
    import subprocess as sp
    import sys

    raw = (body.path or "").strip().strip('"')
    if not raw:
        raise HTTPException(400, "path 为空")
    try:
        p = Path(raw).expanduser().resolve(strict=False)
    except OSError as exc:
        raise HTTPException(400, f"无效路径: {exc}") from exc
    if not p.exists():
        raise HTTPException(404, f"路径不存在: {p}")
    try:
        if sys.platform == "win32":
            if p.is_dir():
                os.startfile(str(p))  # noqa: S606
            else:
                # `/select, <path>` 分成两个参数更稳；把路径拼进同一个参数时，
                # Explorer 在含空格/特殊字符场景下可能退回默认“文档”目录。
                sp.Popen(["explorer.exe", "/select,", str(p)])
        elif sys.platform == "darwin":
            sp.run(["open", "-R", str(p)], check=False, timeout=20)
        else:
            target = str(p.parent) if p.is_file() else str(p)
            sp.run(["xdg-open", target], check=False, timeout=20)
    except Exception as e:
        raise HTTPException(400, str(e)) from e
    return {"ok": True}
