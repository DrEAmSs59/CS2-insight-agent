"""Desktop-native file and folder chooser API routes."""

from __future__ import annotations

import asyncio
import os
import subprocess
import sys
from pathlib import Path

from fastapi import APIRouter, HTTPException
from pydantic import BaseModel, Field

router = APIRouter(tags=["desktop"])


class FilePickerBody(BaseModel):
    file_type: str = Field(default="any", pattern=r"^(audio|video_or_image|exe|any)$")


_FILE_PICKER_FILTERS: dict[str, str] = {
    "audio": "音频文件|*.mp3;*.ogg;*.wav;*.flac;*.aac;*.m4a|所有文件|*.*",
    "video_or_image": "视频与图片|*.mp4;*.mov;*.mkv;*.avi;*.png;*.jpg;*.jpeg;*.webp;*.bmp;*.gif|所有文件|*.*",
    "exe": "可执行文件|*.exe|所有文件|*.*",
    "any": "所有文件|*.*",
}


@router.post("/api/file-picker")
async def file_picker(body: FilePickerBody):
    import sys
    import subprocess as sp

    if sys.platform != "win32":
        raise HTTPException(400, "文件浏览对话框仅 Windows 可用")

    ft = body.file_type if body.file_type in _FILE_PICKER_FILTERS else "any"
    filt = _FILE_PICKER_FILTERS[ft].replace("'", "''")

    ps = (
        "[Console]::OutputEncoding = [System.Text.Encoding]::UTF8;"
        "Add-Type -AssemblyName System.Windows.Forms;"
        "$d = New-Object System.Windows.Forms.OpenFileDialog;"
        f"$d.Filter = '{filt}';"
        "$d.Multiselect = $false;"
        "if ($d.ShowDialog() -eq 'OK') { Write-Output $d.FileName }"
    )

    def _run() -> str:
        r = sp.run(
            ["powershell", "-NoProfile", "-NonInteractive", "-Command", ps],
            capture_output=True,
            timeout=120,
        )
        return (r.stdout or b"").decode("utf-8", errors="replace").strip()

    try:
        path = await asyncio.to_thread(_run)
    except Exception as exc:
        raise HTTPException(500, f"文件选择器失败: {exc}") from exc

    return {"path": path or None}


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
