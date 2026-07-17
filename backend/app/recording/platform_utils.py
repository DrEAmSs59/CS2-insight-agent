"""Demo 平台识别与 spec_player 槽位偏移量计算。"""
from __future__ import annotations

import re


VOICE_LISTEN_MASK_ALL = (1 << 64) - 1
_VOICE_FILTER_MODES = frozenset({"off", "open", "team", "enemy", "mute"})


def infer_demo_source(filename: str, server_name: str = "") -> str:
    """从文件名和 demo header server_name 推断录制平台。与 main.py 同逻辑。"""
    fn = filename.lower()
    sn = server_name.lower()
    if "faceit" in sn:
        return "Faceit"
    if "5eplay" in sn or "5e" in sn:
        return "5E"
    if "完美世界" in sn or "wanmei" in sn:
        return "Perfect World"
    if "valve" in sn:
        return "Matchmaking"
    if "esl" in sn:
        return "ESL"
    if "esea" in sn:
        return "ESEA"
    if "blast" in sn:
        return "Blast"
    if "pgl" in sn:
        return "PGL"
    if "starladder" in sn:
        return "StarLadder"
    if "flashpoint" in sn:
        return "Flashpoint"
    if "challengermode" in sn:
        return "Challengermode"
    # 文件名兜底
    if re.match(r"^g\d+-", fn):
        return "5E"
    if re.match(r"^\d+_team", fn):
        return "Faceit"
    if "faceit" in fn:
        return "Faceit"
    if "5e" in fn:
        return "5E"
    if "perfectworld" in fn or "pvp" in fn:
        return "Perfect World"
    if "match730" in fn or "matchmaking" in fn:
        return "Matchmaking"
    if "esl" in fn:
        return "ESL"
    if "esea" in fn:
        return "ESEA"
    return "Local/Other"


def platform_slot_offset(filename: str, server_name: str = "") -> int:
    """返回该平台的 spec_player 槽位偏移量（5E / Perfect World = +1，其余 = 0）。"""
    source = infer_demo_source(filename, server_name)
    return 1 if source in ("5E", "Perfect World") else 0


def compute_voice_listen_mask(
    all_players: list[dict],
    target_steamid64: str,
    slot_offset: int,
) -> int:
    """计算 ``tv_listen_voice_indices`` 位掩码，只听目标玩家队伍的语音。

    掩码规则：slot 1-based → bit index = slot-1 → bit value = 1<<(slot-1)。
    所有属于目标玩家队伍的 spec_slot（加 offset 后）对应的位置 1。

    SteamID 是唯一身份真源；不会按昵称回退。返回 0 表示数据不足，调用方必须
    fail-closed（静音），不能回落到 -1（全员）。
    """
    target_team = _resolve_target_team(all_players, target_steamid64)
    return _compute_team_mask(all_players, target_team, slot_offset)


def compute_voice_listen_mask_enemy(
    all_players: list[dict],
    target_steamid64: str,
    slot_offset: int,
) -> int:
    """计算 ``tv_listen_voice_indices`` 位掩码，只听目标玩家对方队伍的语音。"""
    target_team = _resolve_target_team(all_players, target_steamid64)
    if target_team not in (2, 3):
        return 0
    enemy_team = 3 if target_team == 2 else 2
    return _compute_team_mask(all_players, enemy_team, slot_offset)


def _steamid_key(value) -> str:
    """Return the exact comparable SteamID representation used by demo rosters."""
    return str(value).strip() if value is not None else ""


def _valid_team_num(value) -> int:
    try:
        team_num = int(value)
    except (TypeError, ValueError, OverflowError):
        return 0
    return team_num if team_num in (2, 3) else 0


def _resolve_target_team(all_players: list[dict], target_steamid64: str) -> int:
    target_key = _steamid_key(target_steamid64)
    if not all_players or not target_key:
        return 0

    teams = {
        _valid_team_num(player.get("team_num"))
        for player in all_players
        if isinstance(player, dict)
        and _steamid_key(player.get("steamid64")) == target_key
    }
    teams.discard(0)
    # Conflicting roster rows are unsafe to guess through.
    return next(iter(teams)) if len(teams) == 1 else 0


def _compute_team_mask(all_players: list[dict], team_num: int, slot_offset: int) -> int:
    if team_num not in (2, 3):
        return 0

    mask = 0
    for player in all_players or []:
        if not isinstance(player, dict):
            continue
        # Unidentified roster rows are never allowed into a team voice mask.
        if not _steamid_key(player.get("steamid64")):
            continue
        if _valid_team_num(player.get("team_num")) != team_num:
            continue
        slot = player.get("spec_slot")
        if slot is None:
            continue
        try:
            actual = int(slot) + int(slot_offset)
        except (TypeError, ValueError, OverflowError):
            continue
        if 1 <= actual <= 64:
            mask |= 1 << (actual - 1)
    return mask


def normalize_voice_filter(value) -> str:
    """Normalize persisted/legacy values; unknown modes default to mute."""
    mode = str(value or "mute").strip().lower()
    if mode == "all":  # historical value meant mute-all
        return "mute"
    return mode if mode in _VOICE_FILTER_MODES else "mute"


def select_voice_listen_mask(
    voice_filter,
    team_mask: int,
    enemy_mask: int,
) -> "int | None":
    """Resolve the final per-segment mask. ``None`` is reserved for explicit off."""
    mode = normalize_voice_filter(voice_filter)
    if mode == "off":
        return None
    if mode == "open":
        return VOICE_LISTEN_MASK_ALL
    if mode == "team":
        return int(team_mask or 0)
    if mode == "enemy":
        return int(enemy_mask or 0)
    return 0


def split_voice_listen_mask(mask: int) -> tuple[int, int]:
    """Split a 64-bit mask into the signed int32 values accepted by CS2 cvars."""
    if isinstance(mask, bool) or not isinstance(mask, int):
        raise ValueError("voice listen mask must be an integer")
    if mask < 0 or mask > VOICE_LISTEN_MASK_ALL:
        raise ValueError("voice listen mask must fit in 64 bits")

    def _signed_int32(word: int) -> int:
        return word if word < (1 << 31) else word - (1 << 32)

    low = _signed_int32(mask & 0xFFFFFFFF)
    high = _signed_int32((mask >> 32) & 0xFFFFFFFF)
    return low, high


def voice_listen_mask_console_commands(mask: int) -> list[str]:
    """Build a fail-closed low/high mask update for one POV segment."""
    low, high = split_voice_listen_mask(mask)
    commands = [
        "tv_listen_voice_indices 0",
        "tv_listen_voice_indices_h 0",
    ]
    if mask:
        commands.extend(
            (
                f"tv_listen_voice_indices {low}",
                f"tv_listen_voice_indices_h {high}",
            )
        )
    return commands
