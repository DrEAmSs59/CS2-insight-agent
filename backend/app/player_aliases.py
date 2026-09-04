# ---------------------------------------------------------------------------------------------
# Copyright (c) unicbm. All rights reserved.
# Licensed under the PolyForm Noncommercial License 1.0.0. See LICENSE in the project root for license information.
# ---------------------------------------------------------------------------------------------

"""Session-only player display names. No identity changes and no source writes."""
from __future__ import annotations

from functools import lru_cache
import json
from pathlib import Path
import re
import subprocess
import sys
import tempfile
import unicodedata
from typing import Annotated

from pydantic import AfterValidator, StrictStr


class PlayerAliasError(ValueError):
    pass


def validate_player_aliases(value: dict[str, str]) -> dict[str, str]:
    if len(value) > 64:
        raise PlayerAliasError("最多配置 64 名玩家的昵称。")
    result = {}
    for steamid, name in value.items():
        if not re.fullmatch(r"[1-9][0-9]{0,19}", steamid) or int(steamid) > 2**64 - 1:
            raise PlayerAliasError("玩家 SteamID 必须是原始十进制身份字符串。")
        if not isinstance(name, str):
            raise PlayerAliasError("昵称必须是字符串。")
        if not name.strip():
            continue  # An empty edit means keep the original name.
        if any(unicodedata.category(c) in {"Cc", "Cs"} for c in name):
            raise PlayerAliasError("昵称不能包含换行、控制字符或无效 Unicode。")
        if len(name.encode("utf-16-le")) // 2 > 32 or len(name.encode("utf-8")) > 127:
            raise PlayerAliasError("昵称过长：最多 32 个 UTF-16 单位、127 个 UTF-8 字节。")
        result[steamid] = name  # Preserve spacing, Unicode, punctuation and duplicate names.
    return result


PlayerAliases = Annotated[dict[str, StrictStr], AfterValidator(validate_player_aliases)]


@lru_cache(maxsize=16)
def _roster(path: str, size: int, modified: int) -> tuple[tuple[str, str, int], ...]:
    from demoparser2 import DemoParser
    from .native_table import DataFrame

    try:
        frame = DataFrame(DemoParser(path).parse_player_info())
        rows = frame.to_dict("records")
    except (KeyboardInterrupt, SystemExit, GeneratorExit):
        raise
    except BaseException as exc:
        raise PlayerAliasError(f"读取 Demo 玩家名单失败：{exc}") from exc
    result = {}
    for row in rows:
        steamid = str(row.get("steamid") or "0")
        if not steamid.isdecimal() or int(steamid) == 0:
            continue
        result[steamid] = (steamid, str(row.get("name") or ""), int(row.get("team_number") or 0))
    return tuple(sorted(result.values(), key=lambda row: (row[2], row[1], row[0])))


def player_alias_roster(path: str | Path) -> list[dict]:
    source = Path(path).resolve(strict=True)
    stat = source.stat()
    return [dict(steamid64=sid, name=name, team_number=team)
            for sid, name, team in _roster(str(source), stat.st_size, stat.st_mtime_ns)]


def resolve_alias_rewriter() -> Path:
    root = Path(__file__).resolve().parents[2]
    name = "demo-player-aliases.exe" if sys.platform == "win32" else "demo-player-aliases"
    for candidate in (
        Path(sys.executable).resolve().parent.parent / "tools" / name,
        root / "tools" / "demo-cosmetic-rewriter" / "target" / "release" / name,
        root / "frontend" / "src-tauri" / "bundle-resources" / "tools" / name,
    ):
        if candidate.is_file():
            return candidate
    raise PlayerAliasError("安装包缺少玩家改名组件，请安装完整新版。")


def create_player_alias_copy(source: str | Path, output: str | Path, aliases: dict[str, str]) -> Path:
    source, output = Path(source).resolve(strict=True), Path(output).resolve()
    aliases = validate_player_aliases(aliases)
    if output.exists() or source == output:
        raise PlayerAliasError("改名必须写入新的临时副本，不能覆盖已有 Demo。")
    before = player_alias_roster(source)
    known = {p["steamid64"] for p in before}
    if not aliases or not set(aliases).issubset(known):
        raise PlayerAliasError("改名配置为空或包含本场 Demo 中不存在的玩家。")
    original_stat = source.stat()
    output.parent.mkdir(parents=True, exist_ok=True)
    try:
        with tempfile.TemporaryDirectory(prefix="alias-config-", dir=output.parent) as directory:
            config = Path(directory) / "aliases.json"
            config.write_text(json.dumps(aliases, ensure_ascii=False), encoding="utf-8")
            result = subprocess.run(
                [str(resolve_alias_rewriter()), "--input", str(source), "--output", str(output), "--config", str(config)],
                capture_output=True, text=True, encoding="utf-8", errors="replace", timeout=600,
                creationflags=getattr(subprocess, "CREATE_NO_WINDOW", 0),
            )
        if result.returncode != 0:
            raise PlayerAliasError(f"Demo 改名失败：{result.stderr[-1500:]}")
        after = {p["steamid64"]: p for p in player_alias_roster(output)}
        if set(after) != known:
            raise PlayerAliasError("改名校验失败：玩家身份集合发生改变。")
        for player in before:
            sid = player["steamid64"]
            expected = {**player, "name": aliases.get(sid, player["name"])}
            if after[sid] != expected:
                raise PlayerAliasError(f"改名校验失败：玩家 {sid}，预期 {expected!r}，实际 {after[sid]!r}。")
        current = source.stat()
        if (current.st_size, current.st_mtime_ns) != (original_stat.st_size, original_stat.st_mtime_ns):
            raise PlayerAliasError("改名期间源 Demo 被其他操作改变，请重试。")
        return output
    except Exception:
        output.unlink(missing_ok=True)
        raise
