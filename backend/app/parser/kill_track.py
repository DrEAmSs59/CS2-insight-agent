"""击杀特效轨道（Kill FX track）提取。

为 OBS Browser Source 击杀特效 overlay 预提取片段内目标玩家的击杀事件，
并锚定第一梯队特效标识（与 tag 体系语义对齐，但只做事件级可判定的子集）：

  图标（icons，按稀有度排序）:
    air_noscope   ✈️ 飞天盲狙（盲狙 + 攻击者腾空）
    collateral    🍡 一石二鸟（awp/ssg08/沙鹰系 ±2 tick 双杀）
    one_tap       💥 颗秒（步枪/沙鹰系爆头 + 单次命中击杀）
    humiliation   🔪 刀杀
    revenge       🧾 上回合的债（受害者上一回合杀过目标）
    first_blood   ⚔️ 首杀（本回合全场第一滴血）
    wallbang      🧱 穿墙杀
    no_scope      🙈 盲狙
    smoke_kill    🌫️ 混烟

  横幅视频（banner）:
    double / triple / quad / ace   本回合第 2/3/4/5 杀
    clutch_1vN_to_1vM              残局人数递减（例如 1v5 击杀后进入 1v4）

回合级/空间级 tag（赛点、天王山、超远穿墙等）不在此处理。
"""

from __future__ import annotations

import logging
import os
import re
import threading
from typing import Any, Optional

import pandas as pd
from demoparser2 import DemoParser

from .parse_utils import _to_pandas_df as _to_df
from .tag_constants import (
    TICK_RATE,
    _KEQIAO_WEAPONS,
    _PLAYER_DEATH_GAME_KEYS,
)
from .weapons import SNIPER_WEAPONS, DEAGLE_VARIANTS, _normalize_item, _is_knife_highlight_weapon

logger = logging.getLogger(__name__)

# 一石二鸟判定武器与 tick 容差（对齐 tag_detection 的 🍡 规则）
_COLLATERAL_WEAPONS = SNIPER_WEAPONS | DEAGLE_VARIANTS
_COLLATERAL_TICK_TOL = 2
# 颗秒命中计数回看窗口（同一次交火内的 player_hurt）
_ONE_TAP_HURT_LOOKBACK_SEC = 5.0

# 图标优先级（小 = 更稀有 / 优先展示）
_ICON_PRIORITY = (
    "air_noscope",
    "collateral",
    "one_tap",
    "humiliation",
    "revenge",
    "first_blood",
    "wallbang",
    "no_scope",
    "smoke_kill",
)

_CLUTCH_TAG_RE = re.compile(r"1v(\d+)\s*史诗残局")

# ── demo 级事件表缓存（同一 demo 多 segment 复用，避免重复扫描）──────────
_CACHE_LOCK = threading.Lock()
_CACHE_MAX = 4
_tables_cache: dict[tuple, dict] = {}
_CACHE_LOAD_LOCKS = tuple(threading.Lock() for _ in range(8))


def _demo_cache_key(demo_path: str) -> tuple:
    try:
        st = os.stat(demo_path)
        return (os.path.abspath(demo_path), int(st.st_mtime_ns), int(st.st_size))
    except OSError:
        return (os.path.abspath(demo_path), 0, 0)


def _load_demo_tables(demo_path: str) -> dict:
    key = _demo_cache_key(demo_path)
    with _CACHE_LOCK:
        hit = _tables_cache.get(key)
    if hit is not None:
        return hit

    # Phase 0 并行预构建多个 segment 时，同一 demo 只允许一个线程做首次解析。
    # 使用 striped lock 保留不同 demo 之间的有限并行度。
    load_lock = _CACHE_LOAD_LOCKS[hash(key) % len(_CACHE_LOAD_LOCKS)]
    with load_lock:
        with _CACHE_LOCK:
            hit = _tables_cache.get(key)
        if hit is not None:
            return hit

        parser = DemoParser(demo_path)
        death_other = list(dict.fromkeys(["total_rounds_played"] + list(_PLAYER_DEATH_GAME_KEYS)))
        try:
            deaths = _to_df(parser.parse_event("player_death", other=death_other))
        except Exception as e:
            logger.warning("[kill_track] player_death parse failed: %s", e)
            deaths = pd.DataFrame()
        try:
            hurts = _to_df(parser.parse_event("player_hurt"))
        except Exception as e:
            logger.warning("[kill_track] player_hurt parse failed (one_tap disabled): %s", e)
            hurts = pd.DataFrame()

        tables = {"deaths": deaths, "hurts": hurts}
        with _CACHE_LOCK:
            if len(_tables_cache) >= _CACHE_MAX:
                _tables_cache.pop(next(iter(_tables_cache)))
            _tables_cache[key] = tables
        return tables


# ── 小工具 ──────────────────────────────────────────────────────────────


def _col(df: pd.DataFrame, *candidates: str) -> Optional[str]:
    cols = list(df.columns)
    low = {c.lower(): c for c in cols}
    for c in candidates:
        if c in cols:
            return c
        if c.lower() in low:
            return low[c.lower()]
    return None


def _b(v: Any) -> bool:
    if isinstance(v, bool):
        return v
    if v is None:
        return False
    try:
        if isinstance(v, (int, float)):
            return bool(int(v))
    except (TypeError, ValueError):
        return False
    return str(v).strip().lower() in ("true", "1", "yes")


def _i(v: Any, default: int = 0) -> int:
    try:
        if v is None or (isinstance(v, float) and pd.isna(v)):
            return default
        return int(float(v))
    except (TypeError, ValueError):
        return default


def _s(v: Any) -> str:
    if v is None or (isinstance(v, float) and pd.isna(v)):
        return ""
    return str(v).strip()


def _row_matches_player(
    row: pd.Series,
    *,
    sid_col: Optional[str],
    name_col: Optional[str],
    steamid: str | int | None,
    player_name: str | None,
) -> bool:
    if steamid is not None and sid_col:
        if _s(row.get(sid_col)) == str(steamid).strip():
            return True
    if player_name and name_col:
        if _s(row.get(name_col)) == str(player_name).strip():
            return True
    return False


def _parse_clutch_enemy_count(context_tags: Optional[list[str]]) -> Optional[int]:
    for t in context_tags or []:
        m = _CLUTCH_TAG_RE.search(str(t))
        if m:
            return int(m.group(1))
    return None


_BANNER_BY_KILL_INDEX = {2: "double", 3: "triple", 4: "quad", 5: "ace"}


def extract_kill_track(
    demo_path: str,
    *,
    steamid: str | int | None = None,
    player_name: str | None = None,
    start_tick: int,
    end_tick: int,
    context_tags: Optional[list[str]] = None,
    round_number: Optional[int] = None,
) -> list[dict]:
    """返回片段窗口内目标玩家的击杀特效事件（按 tick 升序）。

    每条: {tick, victim, weapon, headshot, kill_index, icons, banner}
    无特效的普通击杀 icons=[] 且 banner=None，由 overlay 端跳过渲染。
    """
    tables = _load_demo_tables(demo_path)
    deaths: pd.DataFrame = tables["deaths"]
    hurts: pd.DataFrame = tables["hurts"]
    if deaths.empty or "tick" not in deaths.columns:
        return []

    c_att_sid = _col(deaths, "attacker_steamid")
    c_att_name = _col(deaths, "attacker_name")
    c_vic_sid = _col(deaths, "user_steamid", "player_steamid")
    c_vic_name = _col(deaths, "user_name", "player_name")
    c_weapon = _col(deaths, "weapon")
    c_round = _col(deaths, "total_rounds_played")
    c_hs = _col(deaths, "headshot")
    c_nosc = _col(deaths, "noscope")
    c_smoke = _col(deaths, "thrusmoke", "through_smoke")
    c_pen = _col(deaths, "penetrated", "penetrated_objects")
    c_air = _col(deaths, "attackerinair", "attacker_in_air", "inair")
    c_att_team = _col(deaths, "attackerteam")
    c_vic_team = _col(deaths, "userteam")

    start_i, end_i = int(start_tick), int(end_tick)

    # ── 全 demo 单遍扫描：回合首杀 / 目标的回合击杀序列 / 上回合杀过目标的人 ──
    first_death_tick: dict[int, int] = {}
    target_kill_rows: list[dict] = []          # 目标全场击杀（窗口外的也要，用于 kill_index）
    killers_of_target: dict[int, set[str]] = {}

    for _, row in deaths.sort_values("tick", kind="mergesort").iterrows():
        tick = _i(row.get("tick"))
        rnd = _i(row.get(c_round), -1) + 1 if c_round else 0
        att = _s(row.get(c_att_name)) if c_att_name else ""
        vic = _s(row.get(c_vic_name)) if c_vic_name else ""

        if rnd not in first_death_tick:
            first_death_tick[rnd] = tick

        is_target_attacker = _row_matches_player(
            row, sid_col=c_att_sid, name_col=c_att_name,
            steamid=steamid, player_name=player_name,
        )
        is_target_victim = _row_matches_player(
            row, sid_col=c_vic_sid, name_col=c_vic_name,
            steamid=steamid, player_name=player_name,
        )

        if is_target_victim and att and att != vic:
            killers_of_target.setdefault(rnd, set()).add(att)

        if not is_target_attacker or is_target_victim or not att or att == vic:
            continue
        # 排除队友击杀（字段缺失时不拦截）
        if c_att_team and c_vic_team:
            at, vt = _i(row.get(c_att_team), -1), _i(row.get(c_vic_team), -1)
            if at in (2, 3) and at == vt:
                continue

        target_kill_rows.append({
            "tick": tick,
            "round": rnd,
            "victim": vic,
            "weapon": _normalize_item(row.get(c_weapon)) if c_weapon else "",
            "headshot": _b(row.get(c_hs)) if c_hs else False,
            "noscope": _b(row.get(c_nosc)) if c_nosc else False,
            "thrusmoke": _b(row.get(c_smoke)) if c_smoke else False,
            "penetrated": _i(row.get(c_pen)) if c_pen else 0,
            "inair": _b(row.get(c_air)) if c_air else False,
        })

    if not target_kill_rows:
        return []

    # kill_index：按回合内时间序
    per_round_seq: dict[int, int] = {}
    for k in target_kill_rows:
        per_round_seq[k["round"]] = per_round_seq.get(k["round"], 0) + 1
        k["kill_index"] = per_round_seq[k["round"]]

    # ── player_hurt 命中索引（one_tap 用）: (attacker, victim) → [tick...] ──
    hurt_index: dict[tuple[str, str], list[int]] = {}
    if not hurts.empty and "tick" in hurts.columns:
        h_att = _col(hurts, "attacker_name")
        h_vic = _col(hurts, "user_name", "player_name")
        if h_att and h_vic:
            for _, hrow in hurts.iterrows():
                a, v = _s(hrow.get(h_att)), _s(hrow.get(h_vic))
                if a and v:
                    hurt_index.setdefault((a, v), []).append(_i(hrow.get("tick")))
            for arr in hurt_index.values():
                arr.sort()

    target_name = str(player_name or "").strip()

    def _hits_before_kill(victim: str, kill_tick: int) -> Optional[int]:
        if not hurt_index or not target_name:
            return None
        arr = hurt_index.get((target_name, victim))
        if arr is None:
            return None
        lo = kill_tick - int(_ONE_TAP_HURT_LOOKBACK_SEC * TICK_RATE)
        return sum(1 for t in arr if lo <= t <= kill_tick)

    # ── 一石二鸟分组：同回合 ±2 tick 内的狙/沙鹰系多杀，锚定组内最后一杀 ──
    collateral_anchor_ticks: set[int] = set()
    by_round: dict[int, list[dict]] = {}
    for k in target_kill_rows:
        if k["weapon"] in _COLLATERAL_WEAPONS:
            by_round.setdefault(k["round"], []).append(k)
    for kills in by_round.values():
        kills.sort(key=lambda x: x["tick"])
        group: list[dict] = []
        for k in kills:
            if group and k["tick"] - group[-1]["tick"] <= _COLLATERAL_TICK_TOL:
                group.append(k)
            else:
                if len(group) >= 2:
                    collateral_anchor_ticks.add(group[-1]["tick"])
                group = [k]
        if len(group) >= 2:
            collateral_anchor_ticks.add(group[-1]["tick"])

    # 史诗残局标签给出残局开始时的敌人数。该残局必然对应目标玩家在该回合的
    # 最后 N 次击杀，因此即使新版导播把回合拆成多个 K→V 子片段，也能为每次
    # 击杀稳定生成 1v5→1v4、…、1v2→1v1 的递减事件。最终 1v1 获胜没有对应素材，
    # 保留该杀的 2K/3K/4K/ACE 视频。
    clutch_enemy_count = _parse_clutch_enemy_count(context_tags)
    clutch_transition_by_tick: dict[int, str] = {}
    if clutch_enemy_count is not None and 2 <= clutch_enemy_count <= 5:
        target_round = _i(round_number, -1) if round_number is not None else None
        clutch_rounds: dict[int, list[dict]] = {}
        for k in target_kill_rows:
            if target_round is not None and k["round"] != target_round:
                continue
            clutch_rounds.setdefault(k["round"], []).append(k)
        for round_kills in clutch_rounds.values():
            if len(round_kills) < clutch_enemy_count:
                continue
            clutch_kills = round_kills[-clutch_enemy_count:]
            for idx, kill in enumerate(clutch_kills[:-1]):
                before = clutch_enemy_count - idx
                after = before - 1
                clutch_transition_by_tick[kill["tick"]] = f"clutch_1v{before}_to_1v{after}"

    # ── 组装窗口内的输出 ────────────────────────────────────────────────
    in_window = [k for k in target_kill_rows if start_i <= k["tick"] <= end_i]
    out: list[dict] = []
    for k in in_window:
        icons: list[str] = []
        weapon = k["weapon"]
        is_sniper = weapon in SNIPER_WEAPONS
        rnd = k["round"]

        if is_sniper and k["noscope"] and k["inair"]:
            icons.append("air_noscope")
        if k["tick"] in collateral_anchor_ticks:
            icons.append("collateral")
        if k["headshot"] and weapon in _KEQIAO_WEAPONS:
            hits = _hits_before_kill(k["victim"], k["tick"])
            if hits == 1:
                icons.append("one_tap")
        if _is_knife_highlight_weapon(weapon):
            icons.append("humiliation")
        if k["victim"] and k["victim"] in (killers_of_target.get(rnd - 1) or set()):
            icons.append("revenge")
        if first_death_tick.get(rnd) == k["tick"] and k["kill_index"] == 1:
            icons.append("first_blood")
        if k["penetrated"] > 0:
            icons.append("wallbang")
        if is_sniper and k["noscope"] and "air_noscope" not in icons:
            icons.append("no_scope")
        if k["thrusmoke"]:
            icons.append("smoke_kill")

        icons.sort(key=_ICON_PRIORITY.index)

        banner = clutch_transition_by_tick.get(k["tick"])
        if banner is None and k["kill_index"] >= 2:
            banner = _BANNER_BY_KILL_INDEX.get(min(k["kill_index"], 5))

        out.append({
            "tick": k["tick"],
            "victim": k["victim"],
            "weapon": weapon,
            "headshot": k["headshot"],
            "kill_index": k["kill_index"],
            "icons": icons,
            "banner": banner,
        })

    return out
