from __future__ import annotations
import pandas as pd
from demoparser2 import DemoParser

from .parse_utils import _to_pandas_df as _to_df

PROP_BUTTONS = "buttons"
PROP_WALK    = "is_walking"
PROP_SCOPE   = "is_scoped"
PROP_DUCKING = "ducking"
PROP_RELOAD  = "is_in_reload"

# CS2 默认按键位（已在 falcons-vs-legacy demo 标定确认）
BIT_ATTACK  = 0
BIT_JUMP    = 1
BIT_FWD     = 3
BIT_BACK    = 4
BIT_LEFT    = 9
BIT_RIGHT   = 10

KEYS = ("W", "A", "S", "D", "jump", "crouch", "walk", "reload", "fire", "scope")


def _resolve_col(df: pd.DataFrame, *candidates: str) -> str | None:
    cols = list(df.columns)
    for c in candidates:
        if c in cols:
            return c
    low = {c.lower(): c for c in cols}
    for c in candidates:
        if c.lower() in low:
            return low[c.lower()]
    return None


def extract_input_track(
    demo_path: str,
    *,
    steamid: str | int | None = None,
    player_name: str | None = None,
    start_tick: int,
    end_tick: int,
) -> list[dict]:
    """返回 [{tick, W,A,S,D,jump,crouch,walk,reload,fire,scope}, ...]（按 tick 升序）。

    steamid 为主键；缺失时用 player_name 兜底（存在 steamid 缺失的真实片段）。
    """
    parser = DemoParser(demo_path)
    ticks = list(range(int(start_tick), int(end_tick) + 1))
    df = _to_df(parser.parse_ticks(
        [PROP_BUTTONS, PROP_WALK, PROP_SCOPE, PROP_DUCKING, PROP_RELOAD, "name", "steamid"],
        ticks=ticks,
    ))
    if df.empty:
        return []

    c_mask   = _resolve_col(df, PROP_BUTTONS, "m_nButtonDownMaskPrev")
    c_walk   = _resolve_col(df, PROP_WALK,    "m_bIsWalking")
    c_scope  = _resolve_col(df, PROP_SCOPE,   "m_bIsScoped")
    c_duck   = _resolve_col(df, PROP_DUCKING, "m_bDucking", "in_crouch")
    c_reload = _resolve_col(df, PROP_RELOAD,  "m_bInReload")
    c_name   = _resolve_col(df, "name")
    c_sid    = _resolve_col(df, "steamid")

    if c_mask is None:
        raise RuntimeError("按键掩码列缺失：检查 demoparser2 版本的 'buttons' 别名")

    sel = pd.Series(False, index=df.index)
    if steamid is not None and c_sid:
        sel |= df[c_sid].astype(str).str.strip() == str(steamid).strip()
    if not sel.any() and player_name and c_name:
        sel |= df[c_name].astype(str).str.strip() == str(player_name).strip()
    pdf = df[sel]
    if pdf.empty:
        names = sorted(set(df[c_name].astype(str))) if c_name else []
        raise RuntimeError(
            f"片段内未匹配到玩家 sid={steamid} name={player_name!r}；在场={names}"
        )

    masks = pd.to_numeric(pdf[c_mask], errors="coerce").fillna(0).astype("int64")

    def bvec(bit: int) -> "pd.Series":
        return ((masks >> bit) & 1).astype(bool)

    frame = {
        "tick":   pdf["tick"].astype(int),
        "W":      bvec(BIT_FWD),
        "A":      bvec(BIT_LEFT),
        "S":      bvec(BIT_BACK),
        "D":      bvec(BIT_RIGHT),
        "jump":   bvec(BIT_JUMP),
        "fire":   bvec(BIT_ATTACK),
        "crouch": pd.to_numeric(pdf[c_duck],   errors="coerce").fillna(0).astype(bool) if c_duck   else False,
        "walk":   pd.to_numeric(pdf[c_walk],   errors="coerce").fillna(0).astype(bool) if c_walk   else False,
        "reload": pd.to_numeric(pdf[c_reload], errors="coerce").fillna(0).astype(bool) if c_reload else False,
        "scope":  pd.to_numeric(pdf[c_scope],  errors="coerce").fillna(0).astype(bool) if c_scope  else False,
    }
    return pd.DataFrame(frame).sort_values("tick").to_dict("records")
