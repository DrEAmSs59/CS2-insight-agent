# ---------------------------------------------------------------------------------------------
# Copyright (c) unicbm. All rights reserved.
# Licensed under the PolyForm Noncommercial License 1.0.0. See LICENSE in the project root for license information.
# ---------------------------------------------------------------------------------------------

"""Apply each demo's alias map once, before any VPK or recording plan is built."""
from pathlib import Path

from ..demo_compat_service import ensure_demo_compatible
from ..player_aliases import PlayerAliasError, create_player_alias_copy


def prepare_recording_aliases(requests, directory: Path):
    groups = {}
    for dto in requests:
        key = str(Path(dto.demo.demo_path).resolve())
        aliases = dict(dto.player_aliases)
        if key in groups and groups[key] != aliases:
            raise PlayerAliasError("同一 Demo 的录制片段必须使用相同的玩家改名配置。")
        groups[key] = aliases
    copies = {}
    for index, (source, aliases) in enumerate(groups.items()):
        if aliases:
            copies[source] = create_player_alias_copy(source, directory / f"aliases-{index}.dem", aliases)
            ensure_demo_compatible(copies[source])

    result = []
    for dto in requests:
        key = str(Path(dto.demo.demo_path).resolve())
        if key not in copies:
            result.append(dto)
            continue
        data = dto.model_dump()
        data["demo"]["demo_path"] = str(copies[key])
        aliases = groups[key]

        def rename_player(player):
            sid = str(player.get("steamid64") or "")
            if sid in aliases:
                player["name"] = aliases[sid]

        rename_player(data["target_player"])
        for event in data["events"]:
            for role in ("killer", "victim", "target_player"):
                rename_player(event[role])
        for player in data["demo"]["all_players"]:
            if isinstance(player, dict):
                rename_player(player)
        result.append(type(dto).model_validate(data))
    return result
