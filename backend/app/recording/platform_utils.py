"""Demo 平台识别与 spec_player 槽位偏移量计算。"""
from __future__ import annotations

import re
from typing import Optional


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
) -> Optional[int]:
    """计算 ``tv_listen_voice_indices`` 位掩码，只听目标玩家队伍的语音。

    掩码规则：slot 1-based → bit index = slot-1 → bit value = 1<<(slot-1)。
    所有属于目标玩家队伍的 spec_slot（加 offset 后）对应的位置 1。

    返回 None 表示数据不足（无法确定队伍），调用方应回落到 -1（全员）。
    """
    if not all_players or not target_steamid64:
        return None

    # 找目标玩家的 team_num
    target_team: Optional[int] = None
    for p in all_players:
        if p.get("steamid64") == target_steamid64 and p.get("team_num") in (2, 3):
            target_team = p["team_num"]
            break

    if target_team is None:
        return None

    # 对目标玩家队伍中所有有效 slot 的玩家设置对应 bit
    mask = 0
    for p in all_players:
        if p.get("team_num") != target_team:
            continue
        slot = p.get("spec_slot")
        if slot is None:
            continue
        actual = int(slot) + slot_offset
        if 1 <= actual <= 64:
            mask |= 1 << (actual - 1)

    return mask if mask != 0 else None
