"""POV HUD：安装 pov.vpk、增量 patch gameinfo.gi、备份与恢复（实验性功能）。"""

from __future__ import annotations

import hashlib
import json
import shutil
import sys
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Optional

from .obs_director import is_cs2_running

CS2_RUNNING_POV_MSG = (
    "检测到 CS2 正在运行。POV HUD 需要修改本地资源加载配置，请先关闭 CS2 后再继续。"
)


class PovHudError(RuntimeError):
    pass


def find_project_root() -> Path:
    current = Path(__file__).resolve()
    for parent in [current.parent, *current.parents]:
        if (parent / "pov" / "pov.vpk").is_file():
            return parent
    raise PovHudError("未找到项目根目录下的 pov/pov.vpk")


def resolve_csgo_dir_from_cs2_path(cs2_path: str) -> Path:
    s = (cs2_path or "").strip()
    if not s:
        raise PovHudError("未找到 CS2 安装目录，请先在设置中配置 cs2.exe 路径。")
    p = Path(s).expanduser()
    if not p.exists():
        raise PovHudError("未找到 CS2 安装目录，请先在设置中配置 cs2.exe 路径。")
    name = p.name.lower()
    if p.is_file() and name == "cs2.exe":
        # .../game/bin/win64/cs2.exe → .../game/csgo
        game = p.parent.parent.parent
        return game / "csgo"
    if p.is_dir():
        cand = p / "game" / "csgo"
        if cand.is_dir():
            return cand
    raise PovHudError("未找到 CS2 安装目录，请先在设置中配置 cs2.exe 路径。")


def patch_gameinfo_content(content: str) -> str:
    if "csgo/pov.vpk" in content:
        return content

    lines = content.splitlines()
    patched: list[str] = []
    inserted = False

    for line in lines:
        patched.append(line)
        if not inserted and "Game_LowViolence" in line and "csgo_lv" in line:
            indent = line[: len(line) - len(line.lstrip())]
            patched.append("")
            patched.append(f"{indent}Game    csgo/pov.vpk")
            inserted = True

    if inserted:
        out = "\n".join(patched)
        return out + ("\n" if content.endswith("\n") else "")

    patched = []
    inserted = False
    for line in lines:
        if not inserted:
            stripped = line.strip()
            parts = stripped.split()
            if len(parts) >= 2 and parts[0] == "Game" and parts[1] == "csgo":
                indent = line[: len(line) - len(line.lstrip())]
                patched.append(f"{indent}Game    csgo/pov.vpk")
                inserted = True
        patched.append(line)

    if not inserted:
        raise PovHudError("未能修改 gameinfo.gi，请检查文件内容是否被 Steam 更新改变。")

    out = "\n".join(patched)
    return out + ("\n" if content.endswith("\n") else "")


def sha256_file(path: Path) -> str:
    h = hashlib.sha256()
    with path.open("rb") as f:
        for chunk in iter(lambda: f.read(1024 * 1024), b""):
            h.update(chunk)
    return h.hexdigest()


class PovHudManager:
    """定位资源、安装 / 恢复 POV HUD 文件。"""

    def __init__(self, config_like: Any) -> None:
        self._cs2_path = str(getattr(config_like, "cs2_path", "") or "").strip()

    def get_csgo_dir(self) -> Path:
        return resolve_csgo_dir_from_cs2_path(self._cs2_path)

    def get_gameinfo_path(self) -> Path:
        return self.get_csgo_dir() / "gameinfo.gi"

    def get_pov_vpk_target_path(self) -> Path:
        return self.get_csgo_dir() / "pov.vpk"

    def get_backup_dir(self) -> Path:
        return self.get_csgo_dir() / ".cs2_insight_pov_backup"

    def get_manifest_path(self) -> Path:
        return self.get_backup_dir() / "pov_manifest.json"

    def get_backup_gameinfo_path(self) -> Path:
        return self.get_backup_dir() / "gameinfo.gi.bak"

    def get_project_pov_dir(self) -> Path:
        return find_project_root() / "pov"

    def get_pov_vpk_source_path(self) -> Path:
        return self.get_project_pov_dir() / "pov.vpk"

    def get_reference_default_gameinfo_path(self) -> Path:
        return self.get_project_pov_dir() / "gameinfo.gi.default"

    def get_reference_pov_gameinfo_path(self) -> Path:
        return self.get_project_pov_dir() / "gameinfo.gi.pov"

    def is_gameinfo_patched(self, content: str) -> bool:
        return "csgo/pov.vpk" in content

    def status(self) -> dict[str, Any]:
        warnings: list[str] = []
        csgo = None
        try:
            csgo = self.get_csgo_dir()
        except PovHudError:
            warnings.append("无法解析 CS2 game/csgo 路径。")

        cs2_running = bool(is_cs2_running())
        gi_path = csgo / "gameinfo.gi" if csgo else None
        manifest_path = csgo / ".cs2_insight_pov_backup" / "pov_manifest.json" if csgo else None
        bak_path = csgo / ".cs2_insight_pov_backup" / "gameinfo.gi.bak" if csgo else None
        pov_dst = csgo / "pov.vpk" if csgo else None

        gameinfo_patched = False
        if gi_path and gi_path.is_file():
            try:
                txt = gi_path.read_text(encoding="utf-8", errors="ignore")
                gameinfo_patched = self.is_gameinfo_patched(txt)
            except OSError:
                pass

        manifest_exists = bool(manifest_path and manifest_path.is_file())
        backup_exists = bool(bak_path and bak_path.is_file())
        pov_installed = bool(pov_dst and pov_dst.is_file())

        if gameinfo_patched and not manifest_exists:
            warnings.append(
                "检测到 gameinfo.gi 中存在 csgo/pov.vpk，但未找到 CS2 Insight Agent 的备份记录。请用户手动检查 gameinfo.gi。"
            )

        needs_restore = bool(manifest_exists)

        return {
            "installed": pov_installed,
            "gameinfo_patched": gameinfo_patched,
            "backup_exists": backup_exists,
            "manifest_exists": manifest_exists,
            "cs2_running": cs2_running,
            "needs_restore": needs_restore,
            "warnings": warnings,
        }

    def install(self) -> None:
        if sys.platform != "win32":
            raise PovHudError("POV HUD 仅支持 Windows。")
        if is_cs2_running():
            raise PovHudError(CS2_RUNNING_POV_MSG)

        pov_src = self.get_pov_vpk_source_path()
        if not pov_src.is_file():
            raise PovHudError("未找到 POV HUD 资源文件 pov/pov.vpk，请确认 POV 资源已正确放入项目根目录的 pov 文件夹。")

        csgo = self.get_csgo_dir()
        gi_path = self.get_gameinfo_path()
        if not gi_path.is_file():
            raise PovHudError("未找到 gameinfo.gi，请确认 CS2 路径是否正确。")

        backup_dir = self.get_backup_dir()
        manifest_path = self.get_manifest_path()
        bak_path = self.get_backup_gameinfo_path()
        pov_dst = self.get_pov_vpk_target_path()

        # 若残留 manifest，先尝试恢复再重装，避免重复备份错乱
        if manifest_path.is_file():
            try:
                self.restore()
            except PovHudError:
                pass

        backup_dir.mkdir(parents=True, exist_ok=True)

        raw_gi = gi_path.read_text(encoding="utf-8", errors="surrogateescape")
        original_sha = sha256_file(gi_path)

        if not bak_path.is_file():
            shutil.copy2(gi_path, bak_path)

        try:
            shutil.copy2(pov_src, pov_dst)
        except OSError as e:
            raise PovHudError("无法写入 CS2 目录，请尝试以管理员权限运行，或检查 Steam / CS2 目录权限。") from e

        patched_txt = patch_gameinfo_content(raw_gi)
        try:
            gi_path.write_text(patched_txt, encoding="utf-8", newline="\n")
        except OSError as e:
            try:
                if bak_path.is_file():
                    shutil.copy2(bak_path, gi_path)
            except OSError:
                pass
            try:
                if pov_dst.is_file():
                    pov_dst.unlink()
            except OSError:
                pass
            raise PovHudError("无法写入 CS2 目录，请尝试以管理员权限运行，或检查 Steam / CS2 目录权限。") from e

        patched_sha = sha256_file(gi_path)
        pov_sha = sha256_file(pov_dst)

        manifest = {
            "enabled_by": "CS2 Insight Agent",
            "feature": "experimental_pov",
            "installed_at": datetime.now(timezone.utc).isoformat(),
            "gameinfo_path": str(gi_path),
            "backup_gameinfo_path": str(bak_path),
            "pov_vpk_path": str(pov_dst),
            "original_gameinfo_sha256": original_sha,
            "patched_gameinfo_sha256": patched_sha,
            "installed_pov_vpk_sha256": pov_sha,
        }
        try:
            manifest_path.write_text(json.dumps(manifest, ensure_ascii=False, indent=2), encoding="utf-8")
        except OSError as e:
            raise PovHudError("无法写入 CS2 目录，请尝试以管理员权限运行，或检查 Steam / CS2 目录权限。") from e

    def restore(self) -> None:
        if sys.platform != "win32":
            raise PovHudError("POV HUD 仅支持 Windows。")
        if is_cs2_running():
            raise PovHudError("检测到 CS2 正在运行，请先关闭 CS2 后再恢复 POV HUD 修改。")

        manifest_path = self.get_manifest_path()
        bak_path = self.get_backup_gameinfo_path()
        gi_path = self.get_gameinfo_path()
        pov_dst = self.get_pov_vpk_target_path()
        backup_dir = self.get_backup_dir()

        if not manifest_path.is_file():
            raise PovHudError("未找到 POV 安装记录，无需恢复。")
        if not bak_path.is_file():
            raise PovHudError("POV HUD 自动恢复失败，请到 .cs2_insight_pov_backup 目录手动恢复 gameinfo.gi.bak。")

        try:
            shutil.copy2(bak_path, gi_path)
        except OSError as e:
            raise PovHudError("POV HUD 自动恢复失败，请到 .cs2_insight_pov_backup 目录手动恢复 gameinfo.gi.bak。") from e

        try:
            manifest_path.unlink()
        except OSError:
            pass

        try:
            if pov_dst.is_file():
                pov_dst.unlink()
        except OSError as e:
            raise PovHudError("POV HUD 自动恢复失败：无法删除 pov.vpk。") from e

        try:
            if backup_dir.is_dir() and not any(backup_dir.iterdir()):
                backup_dir.rmdir()
        except OSError:
            pass

    def debug_compare_reference_gameinfo(self) -> dict[str, Any]:
        """开发阶段：对比参考 gameinfo，不参与录制。"""
        d = self.get_reference_default_gameinfo_path()
        p = self.get_reference_pov_gameinfo_path()
        if not d.is_file() or not p.is_file():
            return {"ok": False, "error": "缺少 gameinfo.gi.default / gameinfo.gi.pov"}
        td = d.read_text(encoding="utf-8", errors="ignore")
        tp = p.read_text(encoding="utf-8", errors="ignore")
        return {
            "ok": True,
            "default_has_pov": "csgo/pov.vpk" in td,
            "pov_has_pov": "csgo/pov.vpk" in tp,
            "len_delta": len(tp) - len(td),
        }


def try_restore_stale_pov_on_startup(cfg: Any) -> list[str]:
    """后端启动：若存在 manifest 且 CS2 未运行，自动恢复。"""
    out: list[str] = []
    if sys.platform != "win32":
        return out
    try:
        mgr = PovHudManager(cfg)
        st = mgr.status()
        if st.get("manifest_exists") and not st.get("cs2_running"):
            mgr.restore()
            out.append("已自动恢复上次未完成的 POV HUD 修改。")
    except PovHudError as e:
        out.append(str(e))
    except Exception:
        pass
    return out
