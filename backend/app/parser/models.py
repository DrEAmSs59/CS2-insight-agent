from __future__ import annotations

from dataclasses import dataclass, field, asdict
from typing import Any, Optional

_CHIEF_RD_BADGE = "👨‍🔬 首席研发工程师"


def meme_series_badges_for_kd(kills: int, deaths: int) -> list[str]:
    """本局 K/D 对应的 CS2 社区梗标签（o / i / z / 211 系列）。"""
    k, d = int(kills), int(deaths)
    if k == 2 and d == 11:
        return ["🎓 211高材生"]
    if k == 0:
        return [f"🥚 o{d}", _CHIEF_RD_BADGE]
    if k == 1 and d == 18:
        return [f"🗿 i{d}", _CHIEF_RD_BADGE]
    if k == 1:
        return [f"👨‍💻 i{d}", _CHIEF_RD_BADGE]
    if k == 2:
        return [f"💤 z{d}", _CHIEF_RD_BADGE]
    return []


@dataclass
class MatchMeta:
    map_name: str
    target_player: str
    total_rounds: int
    # 解析侧的观战编号兜底；录制期以 GSI 校准出的 spec_player 槽位为准。
    target_player_user_id: Optional[int] = None
    # Steam64 十进制字符串；观战仍靠昵称在 seek tick 上算槽位（CS2 无按 Steam 切 spec 的官方命令）
    target_steam_id: Optional[str] = None
    # player_death 汇总；meme 合集条数可能小于 target_deaths（与下饭去重）
    target_kills: int = 0
    target_deaths: int = 0
    team_a_score: int = 0  # 通常为 Team 2
    team_b_score: int = 0  # 通常为 Team 3
    team_a_name: str = "Team A"
    team_b_name: str = "Team B"
    match_date: str = ""  # 预留；当前 Demo 无可靠真实开赛时间，保持空串
    duration_mins: int = 0  # 回放时长（分钟），来自 header playback_time
    # o/i/z/211 系梗标签（与前端 PlayerSelect 一致）；非梗局为空列表
    meme_series_badges: list[str] = field(default_factory=list)
    # 「研发全集」大卡专用：整局特殊战绩总评（仅在有 meme_death 合集且开启 AI 时填充）
    ai_meme_montage_score: Optional[float] = None
    ai_meme_montage_commentary: Optional[str] = None
    # Demo 来源平台（从 header server_name 读取）；供录制侧计算 spec_slot 偏移量
    server_name: str = ""
    # 全员名单：[{name, steamid64, spec_slot, team_num}, ...]；spec_slot 为原始未校准值
    all_players: list = field(default_factory=list)
    # 比赛结算界面（cs_win_panel_match）出现的 tick；0 = demo 无该事件。供录制侧最后一回合封顶。
    win_panel_match_tick: int = 0


@dataclass
class Clip:
    clip_id: str
    round: int
    category: str  # "highlight" | "fail" | "meme_death" | "compilation"
    weapon_used: str
    kill_count: int
    start_tick: int
    end_tick: int
    # 与 MatchMeta 同源，供 recorded_clips.clip_meta / 雷达使用（不从成片文件名推断）
    map_name: str = "unknown"
    context_tags: list[str] = field(default_factory=list)
    # 玩家互动：下饭 = 谁杀了目标；高光 = 目标本回合多杀里杀了哪些人
    killer_name: Optional[str] = None
    victims: list[str] = field(default_factory=list)
    killers: list[str] = field(default_factory=list)
    # 与 killers 等长；每次死亡对应击杀者的 steamid64（来自 player_death attacker_steamid），供 killer POV 分段
    killers_steamid64s: list[str] = field(default_factory=list)
    # 高光多杀：本片段内目标玩家每次击杀的 tick（升序），供导播智能跳跃剪辑分段
    kill_ticks: list[int] = field(default_factory=list)
    # 与 victims 等长；每次击杀对应受害者的 steamid64（来自 player_death user_steamid），供受害者 POV 分段
    victim_steamid64s: list[str] = field(default_factory=list)
    # 击杀目标玩家的凶手 steamid64（来自 player_death attacker_steamid），供下饭 killer POV 分段
    killer_steamid64: Optional[str] = None
    # 目标玩家的 spec_player 槽位（解析时计算，录制时直接用；高光=击杀者，下饭=被击杀者）
    target_spec_slot: Optional[int] = None
    # 与 kill_ticks 等长；目标玩家（击杀者）在各击杀处的 spec_player 槽位
    kill_spec_slots: list[Optional[int]] = field(default_factory=list)
    # 与 victims 等长；各受害者的 spec_player 槽位
    victim_spec_slots: list[Optional[int]] = field(default_factory=list)
    # 下饭片段：击杀了目标玩家的凶手的 spec_player 槽位
    killer_spec_slot: Optional[int] = None
    # 死亡合集：与 killers 等长；每次死亡对应击杀者的 spec_player 槽位
    killers_spec_slots: list[Optional[int]] = field(default_factory=list)
    # 本回合开局比分（目标方 round 胜场 : 对方），来自 round_freeze_end 刻度与 team_num
    score_own: Optional[int] = None
    score_opp: Optional[int] = None
    # 本回合目标方是否赢得该回合（True=赢, False=输, None=未知）
    round_won: Optional[bool] = None
    # 本回合 round_freeze_end 的绝对 tick（seek 时不应早于此，避免穿越到上一回合黑屏）
    clip_min_tick: Optional[int] = None
    # 目标玩家在本回合的死亡 tick（供"虽败犹荣"类片段延伸录制到结局画面；赢了的回合亦填充，但导播默认不延伸）
    death_tick: Optional[int] = None
    # 本回合 demo 可安全录制的最晚 tick 上限（约等于下一回合 freeze_end - 5s）。
    # 超过此 tick，CS2 比赛结算界面会单向锁定渲染，demo_gototick 倒退无法恢复画面。
    clip_max_tick: Optional[int] = None
    ai_score: Optional[float] = None
    ai_commentary: Optional[str] = None
    # 合集片段（category="compilation"）专用：跨回合多个子片段的 (start_tick, end_tick) 列表
    # 导播剪辑按此列表逐个跳转，中间可插转场。非合集片段保持空列表。
    source_ticks: list[list[int]] = field(default_factory=list)
    source_rounds: list[int] = field(default_factory=list)
    # 与 source_ticks 等长；freeze_to_death 每段 (start_round, end_round) 含端点，供前端按勾选子集入队切片
    source_round_ends: list[int] = field(default_factory=list)
    compilation_kind: Optional[str] = None
    # 为 True 时：导播与入队合并忽略智能分段 / 击杀前后预留等 pacing（仍保留 POV 开关类字段的显式覆写）
    fixed_segment_pacing: bool = False
    # 回合合集（compilation_kind=freeze_to_death）：本次解析使用的回合范围，写入结果 JSON 供库缓存/前端恢复。
    # None = 使用全部合规非赛后回合；非空 list = 仅这些回合（与 source_ticks 同源）。
    freeze_to_death_round_filter: Optional[list[int]] = None
    # 每合规回合一条精确 [start_tick,end_tick]（与 source_ticks 合并段不同）；前端按勾选子集合并连续回合入队，无需重新解析。
    freeze_to_death_round_windows: Optional[list[dict[str, Any]]] = None
    # 本片段中因 assistedflash=True 的击杀对应的助攻闪光手玩家名（去重保序），供前端 hover 展示
    flash_assisters: list[str] = field(default_factory=list)

    def to_dict(self) -> dict:
        return asdict(self)


@dataclass
class ParseResult:
    match_meta: MatchMeta
    clips: list[Clip]
    timeline: Optional[dict] = None
    round_timeline: Optional[list] = None

    def to_dict(self) -> dict:
        out: dict = {
            "match_meta": asdict(self.match_meta),
            "clips": [c.to_dict() for c in self.clips],
        }
        if self.timeline is not None:
            out["timeline"] = self.timeline
        if self.round_timeline is not None:
            out["round_timeline"] = self.round_timeline
        return out
