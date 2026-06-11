from __future__ import annotations

import pandas as pd
from demoparser2 import DemoParser

from .parse_utils import _to_pandas_df as _to_df
from .weapons import GRENADE_ITEMS, _normalize_item

PROP_BUTTONS = "buttons"
PROP_WALK = "is_walking"
PROP_SCOPE = "is_scoped"
PROP_DUCKING = "ducking"
PROP_RELOAD = "is_in_reload"

# CS2 默认按键位（已在 falcons-vs-legacy demo 标定确认）
BIT_ATTACK = 0
BIT_JUMP = 1
BIT_FWD = 3
BIT_BACK = 4
BIT_LEFT = 9
BIT_RIGHT = 10
BIT_ATTACK2 = 11  # 右键：刀划 / 开镜按下

# demoparser2 从 m_nButtonDownMaskPrev 派生的布尔列
PROP_FIRE = "FIRE"
PROP_RIGHTCLICK = "RIGHTCLICK"
PROP_FORWARD = "FORWARD"
PROP_MOVELEFT = "LEFT"
PROP_MOVERIGHT = "RIGHT"
PROP_MOVEBACK = "BACK"
PROP_WALK_BTN = "WALK"
PROP_RELOAD_BTN = "RELOAD"

KEYS = ("W", "A", "S", "D", "jump", "crouch", "walk", "reload", "fire", "scope")
EPHEMERAL_KEYS = ("jump", "fire", "scope")

_MAX_TICKS = 2000
# 降采样时短按合并：全 tick 密采样上限（约 8 分钟 @64tick）
_MAX_DENSE_TICKS = 32_000


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


def _select_player(
    df: pd.DataFrame,
    *,
    steamid: str | int | None,
    player_name: str | None,
    c_sid: str | None,
    c_name: str | None,
) -> pd.DataFrame:
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
    return pdf


def _to_int_list(series: pd.Series) -> list[int]:
    out: list[int] = []
    for v in series:
        try:
            out.append(int(v))
        except (TypeError, ValueError):
            out.append(0)
    return out


def _bcol(series_col: pd.Series | None, n: int) -> list[bool]:
    if series_col is None:
        return [False] * n
    return [
        bool(int(v)) if pd.notna(v) else False
        for v in pd.to_numeric(series_col, errors="coerce")
    ]


def _bvec(mask_ints: list[int], bit: int) -> list[bool]:
    return [bool((m >> bit) & 1) for m in mask_ints]


def _pick_bool(
    derived: list[bool] | None,
    mask_ints: list[int],
    bit: int,
    i: int,
) -> bool:
    if derived is not None:
        return derived[i]
    return bool((mask_ints[i] >> bit) & 1)


def _scope_press_at(i: int, *, rightclick: bool, scoped_b: list[bool]) -> bool:
    """右键按下；开镜仅在 is_scoped 由 false→true 的 tick 补闪（非开镜全程）。"""
    if rightclick:
        return True
    return bool(scoped_b[i] and (i == 0 or not scoped_b[i - 1]))


def _merge_ephemeral_buckets(
    records: list[dict],
    ephemeral_by_tick: dict[int, dict[str, bool]],
    end_tick: int,
) -> None:
    """把密采样 tick 上的短按 OR 进每个降采样帧所在的 tick 桶。"""
    if not ephemeral_by_tick or not records:
        return
    for i, rec in enumerate(records):
        bucket_start = int(rec["tick"])
        bucket_end = (
            int(records[i + 1]["tick"]) if i + 1 < len(records) else int(end_tick) + 1
        )
        for t in range(bucket_start, bucket_end):
            ep = ephemeral_by_tick.get(t)
            if not ep:
                continue
            for k in EPHEMERAL_KEYS:
                if ep.get(k):
                    rec[k] = True


def _classify_grenade_throw_row(
    row: pd.Series,
    *,
    c_fire: str | None,
    c_rightclick: str | None,
    c_buttons: str | None,
) -> dict[str, bool] | None:
    """投掷出手 tick 的左/右/双键 → overlay 的 fire / scope。"""
    fire = False
    scope = False
    if c_fire and c_fire in row.index and pd.notna(row[c_fire]):
        fire = bool(row[c_fire])
    if c_rightclick and c_rightclick in row.index and pd.notna(row[c_rightclick]):
        scope = bool(row[c_rightclick])
    if c_buttons and c_buttons in row.index and pd.notna(row[c_buttons]):
        try:
            mask = int(row[c_buttons])
        except (TypeError, ValueError):
            mask = 0
        fire = fire or bool(mask & (1 << BIT_ATTACK))
        scope = scope or bool(mask & (1 << BIT_ATTACK2))
    if not fire and not scope:
        return None
    return {"jump": False, "fire": fire, "scope": scope}


def _grenade_throw_flags_from_weapon_fire(
    fire_df: pd.DataFrame,
    *,
    steamid: str | int | None,
    player_name: str | None,
    start_tick: int,
    end_tick: int,
) -> dict[int, dict[str, bool]]:
    """投掷物出手记为 weapon_fire；用出手 tick 的 FIRE/RIGHTCLICK 区分左/右/双键。"""
    if fire_df.empty or "tick" not in fire_df.columns:
        return {}
    c_weapon = _resolve_col(fire_df, "weapon")
    if not c_weapon:
        return {}
    c_name = _resolve_col(fire_df, "user_name", "name", "attacker_name")
    c_sid = _resolve_col(fire_df, "steamid", "user_steamid", "player_steamid")
    c_fire = _resolve_col(fire_df, "user_FIRE", "FIRE")
    c_rightclick = _resolve_col(fire_df, "user_RIGHTCLICK", "RIGHTCLICK")
    c_buttons = _resolve_col(fire_df, "user_buttons", "buttons")

    start_i, end_i = int(start_tick), int(end_tick)
    sub = fire_df.loc[(fire_df["tick"] >= start_i) & (fire_df["tick"] <= end_i)]
    if sub.empty:
        return {}

    player_mask = pd.Series(False, index=sub.index)
    if steamid is not None and c_sid:
        player_mask |= sub[c_sid].astype(str).str.strip() == str(steamid).strip()
    if player_name and c_name:
        player_mask |= sub[c_name].astype(str).str.strip() == str(player_name).strip()
    if not player_mask.any():
        return {}

    out: dict[int, dict[str, bool]] = {}
    for _, row in sub.loc[player_mask].iterrows():
        if _normalize_item(row[c_weapon]) not in GRENADE_ITEMS:
            continue
        classified = _classify_grenade_throw_row(
            row,
            c_fire=c_fire,
            c_rightclick=c_rightclick,
            c_buttons=c_buttons,
        )
        if classified:
            out[int(row["tick"])] = classified
    return out


def _collect_grenade_throw_flags(
    parser: DemoParser,
    *,
    steamid: str | int | None,
    player_name: str | None,
    start_tick: int,
    end_tick: int,
) -> dict[int, dict[str, bool]]:
    # 仅用 weapon_fire 的出手 tick；parse_grenades 含整条弹道轨迹 tick，会污染 fire 状态
    try:
        return _grenade_throw_flags_from_weapon_fire(
            _to_df(parser.parse_event(
                "weapon_fire",
                player=["FIRE", "RIGHTCLICK", "buttons"],
            )),
            steamid=steamid,
            player_name=player_name,
            start_tick=start_tick,
            end_tick=end_tick,
        )
    except Exception:
        return {}


def _ephemeral_flags_for_ticks(
    ticks: set[int],
    *,
    fire: bool = False,
    scope: bool = False,
) -> dict[int, dict[str, bool]]:
    out: dict[int, dict[str, bool]] = {}
    for t in ticks:
        out[int(t)] = {"jump": False, "fire": fire, "scope": scope}
    return out


def _build_ephemeral_map(
    pdf: pd.DataFrame,
    *,
    c_mask: str,
    c_fire: str | None,
    c_rightclick: str | None,
    c_scope: str | None,
) -> dict[int, dict[str, bool]]:
    mask_ints = _to_int_list(pdf[c_mask])
    fire_b = _bcol(pdf[c_fire] if c_fire else None, len(mask_ints))
    rc_b = _bcol(pdf[c_rightclick] if c_rightclick else None, len(mask_ints))
    scope_b = _bcol(pdf[c_scope] if c_scope else None, len(mask_ints))
    ticks = [int(t) for t in pdf["tick"]]
    out: dict[int, dict[str, bool]] = {}
    for i, t in enumerate(ticks):
        jump = bool((mask_ints[i] >> BIT_JUMP) & 1)
        fire = fire_b[i] if c_fire else bool((mask_ints[i] >> BIT_ATTACK) & 1)
        rightclick = rc_b[i] if c_rightclick else bool((mask_ints[i] >> BIT_ATTACK2) & 1)
        out[t] = {
            "jump": jump,
            "fire": fire,
            "scope": _scope_press_at(i, rightclick=rightclick, scoped_b=scope_b),
        }
    return out


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
    start_i = int(start_tick)
    end_i = int(end_tick)
    total = end_i - start_i + 1
    stride = max(1, (total + _MAX_TICKS - 1) // _MAX_TICKS)
    sample_ticks = list(range(start_i, end_i + 1, stride))

    tick_props = [
        PROP_BUTTONS,
        PROP_WALK,
        PROP_SCOPE,
        PROP_DUCKING,
        PROP_RELOAD,
        PROP_FIRE,
        PROP_RIGHTCLICK,
        PROP_FORWARD,
        PROP_MOVELEFT,
        PROP_MOVERIGHT,
        PROP_MOVEBACK,
        PROP_WALK_BTN,
        PROP_RELOAD_BTN,
        "name",
        "steamid",
    ]
    df = _to_df(parser.parse_ticks(tick_props, ticks=sample_ticks))
    if df.empty:
        return []

    c_mask = _resolve_col(df, PROP_BUTTONS, "m_nButtonDownMaskPrev")
    c_walk = _resolve_col(df, PROP_WALK, "m_bIsWalking")
    c_scope = _resolve_col(df, PROP_SCOPE, "m_bIsScoped")
    c_duck = _resolve_col(df, PROP_DUCKING, "m_bDucking", "in_crouch")
    c_reload = _resolve_col(df, PROP_RELOAD, "m_bInReload")
    c_fire = _resolve_col(df, PROP_FIRE)
    c_rightclick = _resolve_col(df, PROP_RIGHTCLICK)
    c_fwd = _resolve_col(df, PROP_FORWARD)
    c_left = _resolve_col(df, PROP_MOVELEFT)
    c_back = _resolve_col(df, PROP_MOVEBACK)
    c_right = _resolve_col(df, PROP_MOVERIGHT)
    c_walk_btn = _resolve_col(df, PROP_WALK_BTN)
    c_reload_btn = _resolve_col(df, PROP_RELOAD_BTN)
    c_name = _resolve_col(df, "name")
    c_sid = _resolve_col(df, "steamid")

    if c_mask is None:
        raise RuntimeError("按键掩码列缺失：检查 demoparser2 版本的 'buttons' 别名")

    pdf = _select_player(
        df, steamid=steamid, player_name=player_name, c_sid=c_sid, c_name=c_name,
    )

    mask_ints = _to_int_list(pdf[c_mask])
    n = len(mask_ints)
    w_derived = _bcol(pdf[c_fwd] if c_fwd else None, n) if c_fwd else None
    a_derived = _bcol(pdf[c_left] if c_left else None, n) if c_left else None
    s_derived = _bcol(pdf[c_back] if c_back else None, n) if c_back else None
    d_derived = _bcol(pdf[c_right] if c_right else None, n) if c_right else None
    fire_derived = _bcol(pdf[c_fire] if c_fire else None, n) if c_fire else None
    rc_derived = _bcol(pdf[c_rightclick] if c_rightclick else None, n) if c_rightclick else None
    walk_derived = _bcol(pdf[c_walk_btn] if c_walk_btn else None, n) if c_walk_btn else None
    reload_derived = _bcol(pdf[c_reload_btn] if c_reload_btn else None, n) if c_reload_btn else None
    scoped_b = _bcol(pdf[c_scope] if c_scope else None, n)

    ticks_out = [int(t) for t in pdf["tick"]]
    crouch_b = _bcol(pdf[c_duck] if c_duck else None, n)
    walk_state_b = _bcol(pdf[c_walk] if c_walk else None, n)
    reload_state_b = _bcol(pdf[c_reload] if c_reload else None, n)

    records: list[dict] = []
    for i in range(n):
        rightclick = _pick_bool(rc_derived, mask_ints, BIT_ATTACK2, i)
        records.append({
            "tick": ticks_out[i],
            "W": _pick_bool(w_derived, mask_ints, BIT_FWD, i),
            "A": _pick_bool(a_derived, mask_ints, BIT_LEFT, i),
            "S": _pick_bool(s_derived, mask_ints, BIT_BACK, i),
            "D": _pick_bool(d_derived, mask_ints, BIT_RIGHT, i),
            "jump": bool((mask_ints[i] >> BIT_JUMP) & 1),
            "fire": _pick_bool(fire_derived, mask_ints, BIT_ATTACK, i),
            "crouch": crouch_b[i],
            "walk": walk_derived[i] if c_walk_btn else walk_state_b[i],
            "reload": reload_derived[i] if c_reload_btn else reload_state_b[i],
            # 右键按下；开镜仅补 is_scoped 上升沿，避免瞄准时全程长亮
            "scope": _scope_press_at(i, rightclick=rightclick, scoped_b=scoped_b),
        })

    ephemeral: dict[int, dict[str, bool]] = {}
    if stride > 1:
        dense_stride = max(1, (total + _MAX_DENSE_TICKS - 1) // _MAX_DENSE_TICKS)
        dense_ticks = list(range(start_i, end_i + 1, dense_stride))
        dense_df = _to_df(parser.parse_ticks(
            [PROP_BUTTONS, PROP_FIRE, PROP_RIGHTCLICK, PROP_SCOPE, "name", "steamid"],
            ticks=dense_ticks,
        ))
        if not dense_df.empty:
            d_mask = _resolve_col(dense_df, PROP_BUTTONS, "m_nButtonDownMaskPrev")
            d_fire = _resolve_col(dense_df, PROP_FIRE)
            d_rc = _resolve_col(dense_df, PROP_RIGHTCLICK)
            d_scope = _resolve_col(dense_df, PROP_SCOPE)
            d_name = _resolve_col(dense_df, "name")
            d_sid = _resolve_col(dense_df, "steamid")
            if d_mask:
                dense_pdf = _select_player(
                    dense_df,
                    steamid=steamid,
                    player_name=player_name,
                    c_sid=d_sid,
                    c_name=d_name,
                )
                ephemeral = _build_ephemeral_map(
                    dense_pdf,
                    c_mask=d_mask,
                    c_fire=d_fire,
                    c_rightclick=d_rc,
                    c_scope=d_scope,
                )

    # 投掷物出手：weapon_fire + 出手 tick 的 FIRE/RIGHTCLICK 区分左/右/双键
    grenade_flags = _collect_grenade_throw_flags(
        parser,
        steamid=steamid,
        player_name=player_name,
        start_tick=start_i,
        end_tick=end_i,
    )
    for t, gflags in grenade_flags.items():
        bucket = ephemeral.setdefault(t, {"jump": False, "fire": False, "scope": False})
        if gflags.get("fire"):
            bucket["fire"] = True
        if gflags.get("scope"):
            bucket["scope"] = True
    if ephemeral:
        _merge_ephemeral_buckets(records, ephemeral, end_i)

    records.sort(key=lambda r: r["tick"])
    return records
