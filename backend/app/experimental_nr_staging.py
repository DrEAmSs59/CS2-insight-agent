"""CS2 运行时注入物 staging：抓帧前装、抓帧后卸（实验档专用）。"""

from __future__ import annotations

import json
import shutil
from pathlib import Path
from typing import Any

AGENT_FILES = (
    "dxgi.dll",
    "ReShade.ini",
    "ReShade_advancedfx.addon",
    "amd-nr.addon64",
    "amd-nr.ini",
    "dlssnr_amd_pass1.dll",
    "dlssnr_on_amd_weights.bin",
)

GENERATED_PATTERNS = (
    "ReShade.log",
    "ReShade.ini.tmp",
    "amd-nr.log",
    "advancedfx_bridge.log",
    "dlssnr_on_amd.ini",
    "dlssnr_on_amd.log",
    # danielblnc 运行时在录多 pass 时会落这些副本
    "amd-nr-pass1.dll",
    "amd-nr-pass2.dll",
    "amd-nr-pass3.dll",
)


def cs2_bin_dir(cs2_exe: Path | None) -> Path | None:
    if cs2_exe is None:
        return None
    parent = cs2_exe.parent
    return parent if parent.is_dir() else None


def stage_runtime(runtime_dir: Path, cs2_bin: Path, log_path: Path | None = None) -> dict[str, Any]:
    """把 runtime 文件拷进 CS2 bin；已存在的同名文件先改名备份。"""
    if not runtime_dir.is_dir():
        raise FileNotFoundError(f"runtime dir missing: {runtime_dir}")
    if not cs2_bin.is_dir():
        raise FileNotFoundError(f"cs2 bin missing: {cs2_bin}")

    manifest: dict[str, Any] = {"cs2_bin": str(cs2_bin), "runtime_dir": str(runtime_dir), "staged": [], "backups": []}
    for name in AGENT_FILES:
        source = runtime_dir / name
        if not source.is_file():
            continue
        target = cs2_bin / name
        backup = target.with_name(name + ".cs2insight-bak")
        if target.exists():
            same_as_source = False
            try:
                same_as_source = target.stat().st_size == source.stat().st_size and (
                    target.read_bytes() == source.read_bytes()
                )
            except OSError:
                same_as_source = False
            if not same_as_source:
                if backup.exists():
                    # 上一次没卸干净：优先保留真正的原始备份，只把 staged 副本删掉
                    try:
                        target.unlink()
                    except OSError:
                        pass
                else:
                    target.rename(backup)
                    manifest["backups"].append({"file": name, "backup": str(backup)})
        shutil.copyfile(source, target)
        manifest["staged"].append(name)

    manifest_path = cs2_bin / ".cs2insight-staging.json"
    manifest_path.write_text(json.dumps(manifest, indent=2), encoding="utf-8")
    if log_path is not None:
        _append(log_path, f"staged {len(manifest['staged'])} files into {cs2_bin}")
    return manifest


def unstage_runtime(manifest: dict[str, Any], log_path: Path | None = None) -> None:
    """抓帧后还原 CS2 bin：删掉 staged 文件与日志，恢复被备份的原文件。"""
    cs2_bin = Path(manifest.get("cs2_bin", ""))
    staged = set(manifest.get("staged") or [])
    if log_path is not None:
        # 卸载前把 add-on 运行日志另存一份，便于排查
        for name in ("amd-nr.log", "ReShade.log", "advancedfx_bridge.log"):
            src = cs2_bin / name
            if src.is_file():
                try:
                    (log_path.parent / (log_path.name + "." + name)).write_bytes(src.read_bytes())
                except OSError:
                    pass
    for name in list(staged) + list(GENERATED_PATTERNS):
        target = cs2_bin / name
        if target.is_file():
            try:
                target.unlink()
            except OSError:
                pass
    restored: set[str] = set()
    for item in manifest.get("backups") or []:
        backup = Path(item.get("backup", ""))
        if backup.is_file():
            try:
                backup.rename(cs2_bin / item["file"])
                restored.add(item["file"])
            except OSError:
                pass
    # 上一次 staging 留下的备份（本次 manifest 未必记录）也要还原，否则原文件会丢
    for backup in cs2_bin.glob("*.cs2insight-bak"):
        original_name = backup.name[: -len(".cs2insight-bak")]
        if original_name in restored:
            continue
        target = cs2_bin / original_name
        if target.exists():
            continue
        try:
            backup.rename(target)
        except OSError:
            pass
    manifest_path = cs2_bin / ".cs2insight-staging.json"
    if manifest_path.is_file():
        manifest_path.unlink()
    if log_path is not None:
        _append(log_path, f"unstaged {len(staged)} files from {cs2_bin}")


def _append(path: Path, message: str) -> None:
    from datetime import datetime

    try:
        with path.open("a", encoding="utf-8") as fh:
            fh.write(f"{datetime.now().isoformat(timespec='seconds')} {message}\n")
    except OSError:
        pass
