from __future__ import annotations

import logging
import os
from typing import Optional

import pandas as pd
from demoparser2 import DemoParser

from .tag_constants import TICK_RATE

logger = logging.getLogger(__name__)

# demoparser2 在坏/不兼容 demo 上可能 Rust panic → PyO3 的 PanicException 不是 Exception 子类。
_DEMOPARSER_RE_RAISE = (KeyboardInterrupt, SystemExit, GeneratorExit)


def win_panel_ceiling_from_match_tick(
    win_panel_match_tick: int, tick_rate: float
) -> "Optional[int]":
    """终局回合录制上限 = cs_win_panel_match tick − 守护（env CS2_INSIGHT_WIN_PANEL_GUARD_SEC，默认 0.5s）。

    win_panel_match_tick <= 0 → None（demo 无结算事件，调用方回退旧逻辑）。
    """
    if not win_panel_match_tick or int(win_panel_match_tick) <= 0:
        return None
    trf = float(tick_rate) if float(tick_rate) > 0 else 64.0
    guard_ticks = int(float(
        os.environ.get("CS2_INSIGHT_WIN_PANEL_GUARD_SEC", "0.5") or "0.5"
    ) * trf)
    return int(win_panel_match_tick) - guard_ticks


def _to_pandas_df(result) -> pd.DataFrame:
    """将 demoparser2 的 parse_event / parse_ticks 返回值统一为 pandas DataFrame。"""
    if isinstance(result, pd.DataFrame):
        return result
    if hasattr(result, "to_pandas"):
        return result.to_pandas()
    if isinstance(result, list):
        return pd.DataFrame(result) if result else pd.DataFrame()
    return pd.DataFrame()


def _safe_parse_event(parser: DemoParser, event_name: str, **kwargs) -> pd.DataFrame:
    """模块级 demoparser2 parse_event 包装，供各子模块复用。"""
    try:
        return _to_pandas_df(parser.parse_event(event_name, **kwargs))
    except _DEMOPARSER_RE_RAISE:
        raise
    except Exception:
        return pd.DataFrame()


def safe_parse_events_batch(
    parser: DemoParser,
    event_names: list[str],
    player: list[str] | None = None,
    other: list[str] | None = None,
) -> dict[str, pd.DataFrame]:
    """
    一次 demo 扫描获取多个事件类型的数据（P0 批量优化）。
    返回 {event_name: DataFrame}，缺失字段列自动为 NaN，失败时各事件返回空 DataFrame。

    兼容两种 demoparser2 返回格式：
    - 旧版：单个合并 DataFrame，带 'event_name' 列区分类型
    - 新版：[(event_name, DataFrame), ...] 元组列表
    """
    try:
        raw = parser.parse_events(event_names, player=player or [], other=other or [])

        # 新版格式：list of (event_name, DataFrame) tuples
        if isinstance(raw, list) and raw and isinstance(raw[0], tuple):
            result: dict[str, pd.DataFrame] = {}
            for item in raw:
                if isinstance(item, tuple) and len(item) == 2:
                    name, df = item
                    result[str(name)] = df if isinstance(df, pd.DataFrame) else _to_pandas_df(df)
            for name in event_names:
                result.setdefault(name, pd.DataFrame())
            return result

        # 旧版格式：合并 DataFrame 带 event_name 列
        df = _to_pandas_df(raw)
        if df.empty or "event_name" not in df.columns:
            return {name: pd.DataFrame() for name in event_names}
        result2: dict[str, pd.DataFrame] = {}
        for name in event_names:
            subset = df[df["event_name"] == name].copy()
            subset = subset.drop(columns=["event_name"], errors="ignore")
            result2[name] = subset.reset_index(drop=True)
        return result2
    except _DEMOPARSER_RE_RAISE:
        raise
    except Exception as e:
        logger.warning("safe_parse_events_batch %s failed: %s", event_names, e)
        return {name: pd.DataFrame() for name in event_names}


def _bool(val) -> bool:
    if val is None:
        return False
    if isinstance(val, bool):
        return val
    try:
        return int(val) != 0
    except (ValueError, TypeError):
        return False


def _int(val, default: int = 0) -> int:
    if val is None:
        return default
    try:
        return int(val)
    except (ValueError, TypeError):
        return default


def _round_end_winner_team_num(val) -> Optional[int]:
    """
    ``round_end`` 的 ``winner`` 转为 ``team_num``（2=T / 3=CT）。
    CS2 常见为字符串 ``CT`` / ``T``；旧 demo 可能已是 ``2`` / ``3``。
    """
    if val is None or (isinstance(val, float) and pd.isna(val)):
        return None
    if isinstance(val, (int, float)) and not isinstance(val, bool):
        try:
            i = int(val)
        except (TypeError, ValueError):
            return None
        if i in (2, 3):
            return i
        return None
    s = str(val).strip().upper()
    if s == "CT":
        return 3
    if s in ("T", "TERRORIST", "TERRORISTS"):
        return 2
    return None


def _cell_str(val) -> str:
    if val is None or (isinstance(val, float) and pd.isna(val)):
        return ""
    s = str(val).strip()
    if not s or s.lower() == "nan":
        return ""
    return s


def _cell_team(val) -> Optional[int]:
    if val is None or (isinstance(val, float) and pd.isna(val)):
        return None
    try:
        return int(float(val))
    except (ValueError, TypeError):
        return None


def _pick_assister_column(df: pd.DataFrame) -> Optional[str]:
    for col in ("assister_name", "assister", "assistor_name"):
        if col in df.columns:
            return col
    return None


def _pick_assister_team_column(df: pd.DataFrame) -> Optional[str]:
    for col in ("assister_team", "assisterteam", "assistersteam"):
        if col in df.columns:
            return col
    return None


def _winner_to_team_num(val: object) -> Optional[int]:
    """round_end.winner → team_num（T=2, CT=3）。"""
    if val is None or (isinstance(val, float) and pd.isna(val)):
        return None
    if isinstance(val, (int, float)) and not isinstance(val, bool):
        try:
            i = int(float(val))
        except (TypeError, ValueError):
            return None
        if i in (2, 3):
            return i
        return None
    s = str(val).strip().upper()
    if not s or s == "NAN":
        return None
    if s in ("CT", "CTS", "COUNTER-TERRORISTS", "COUNTER_TERRORISTS"):
        return 3
    if s in ("T", "TERRORIST", "TERRORISTS", "TS"):
        return 2
    try:
        i = int(float(s))
        if i in (2, 3):
            return i
    except (TypeError, ValueError):
        pass
    return None


def _winner_side_engine_num(w: object) -> Optional[int]:
    """本回合胜者对应的 engine team_num：T=2，CT=3。"""
    if w is None or (isinstance(w, float) and pd.isna(w)):
        return None
    s = str(w).strip().upper()
    if s in ("T", "TERRORIST", "TERRORISTS", "TS"):
        return 2
    if s in ("CT", "CTS", "COUNTER-TERRORISTS", "COUNTER_TERRORISTS"):
        return 3
    return _winner_to_team_num(w)


def _count_team_wins_from_round_end_df(re_df: pd.DataFrame) -> tuple[int, int]:
    team_a = 0
    team_b = 0
    if re_df.empty:
        return team_a, team_b
    wcol = next((c for c in re_df.columns if str(c).lower() == "winner"), None)
    if wcol is None:
        return team_a, team_b
    for _, row in re_df.iterrows():
        tm = _winner_to_team_num(row.get(wcol))
        if tm == 2:
            team_a += 1
        elif tm == 3:
            team_b += 1
    return team_a, team_b


def _infer_total_rounds_from_round_end(re_df: pd.DataFrame, match_start_tick: int) -> int:
    """用 round_end 的 round 序号估计总回合数。"""
    if re_df.empty or "round" not in re_df.columns:
        return 0
    df = re_df
    if match_start_tick > 0 and "tick" in re_df.columns:
        df = re_df.loc[
            pd.to_numeric(re_df["tick"], errors="coerce").fillna(0).astype(int) >= match_start_tick
        ].copy()
    if df.empty:
        return 0
    mx = pd.to_numeric(df["round"], errors="coerce").max()
    if pd.isna(mx):
        return 0
    return int(mx) + 1


def _norm_steam_id(val: object) -> str:
    if val is None or (isinstance(val, float) and pd.isna(val)):
        return ""
    s = str(val).strip()
    if s.endswith(".0") and s[:-2].isdigit():
        s = s[:-2]
    return s


def _user_id_cell(val) -> Optional[int]:
    if val is None or (isinstance(val, float) and pd.isna(val)):
        return None
    try:
        i = int(float(val))
    except (ValueError, TypeError):
        return None
    if i < 0:
        return None
    return i


def _steam_id_cell(val) -> Optional[int]:
    if val is None or (isinstance(val, float) and pd.isna(val)):
        return None
    if isinstance(val, bool):
        return None
    try:
        if isinstance(val, int):
            i = int(val)
        else:
            s = str(val).strip()
            if not s or s.lower() == "nan":
                return None
            if s.endswith(".0") and s[:-2].isdigit():
                s = s[:-2]
            i = int(s)
    except (ValueError, TypeError):
        return None
    if i <= 0:
        return None
    return i


def _max_demo_tick(parser: DemoParser, re_df: pd.DataFrame, match_start_tick: int) -> int:
    mx = 0
    if not re_df.empty and "tick" in re_df.columns:
        v = pd.to_numeric(re_df["tick"], errors="coerce").max()
        if not pd.isna(v):
            mx = max(mx, int(v))
    try:
        de = _to_pandas_df(parser.parse_event("player_death"))
        if not de.empty and "tick" in de.columns:
            if match_start_tick > 0:
                de = de.loc[
                    pd.to_numeric(de["tick"], errors="coerce").fillna(0).astype(int) >= match_start_tick
                ]
            v2 = pd.to_numeric(de["tick"], errors="coerce").max()
            if not de.empty and not pd.isna(v2):
                mx = max(mx, int(v2))
    except BaseException as e:
        if isinstance(e, (KeyboardInterrupt, SystemExit, GeneratorExit)):
            raise
    return mx


def _duration_mins_from_tick_span(match_start_tick: int, max_tick: int) -> int:
    if max_tick <= 0:
        return 0
    start = max(0, int(match_start_tick))
    return int(max(0, max_tick - start) / float(TICK_RATE) / 60.0)


def _get_match_start_tick(
    parser: DemoParser,
    *,
    precomputed_df: "Optional[pd.DataFrame]" = None,
) -> int:
    """获取比赛正式开始的 Tick（过滤拼刀局和多次 Restart）。"""
    try:
        df = (
            precomputed_df
            if (precomputed_df is not None and not precomputed_df.empty)
            else _to_pandas_df(parser.parse_event("round_announce_match_start"))
        )
        if not df.empty and "tick" in df.columns:
            return int(df["tick"].max())
    except BaseException as e:
        if isinstance(e, _DEMOPARSER_RE_RAISE):
            raise
    return 0
