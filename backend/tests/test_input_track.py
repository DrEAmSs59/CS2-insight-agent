import sys, os
sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))

import pandas as pd
from app.parser.input_track import (
    KEYS,
    _build_ephemeral_map,
    _classify_grenade_throw_row,
    _ephemeral_flags_for_ticks,
    _grenade_throw_flags_from_weapon_fire,
    _merge_ephemeral_buckets,
    _pick_bool,
    _resolve_col,
    _scope_press_at,
)
from app.parser.parse_utils import _to_pandas_df as _to_df


def test_resolve_col_exact():
    df = pd.DataFrame({"buttons": [1], "name": ["x"]})
    assert _resolve_col(df, "buttons") == "buttons"


def test_resolve_col_case_insensitive():
    df = pd.DataFrame({"Buttons": [1]})
    assert _resolve_col(df, "buttons") == "Buttons"


def test_resolve_col_missing_returns_none():
    df = pd.DataFrame({"foo": [1]})
    assert _resolve_col(df, "buttons") is None


def test_to_df_passthrough():
    df = pd.DataFrame({"a": [1, 2]})
    result = _to_df(df)
    assert list(result["a"]) == [1, 2]


def test_to_df_empty_list():
    result = _to_df([])
    assert result.empty


def test_keys_constant():
    assert set(KEYS) == {"W", "A", "S", "D", "jump", "crouch", "walk", "reload", "fire", "scope"}


def test_pick_bool_prefers_derived():
    assert _pick_bool([True, False], [0, 0], 0, 0) is True
    assert _pick_bool([False, False], [1, 0], 0, 0) is False
    assert _pick_bool(None, [1, 0], 0, 0) is True


def test_scope_rightclick_not_scoped_while_aiming():
    scoped = [False, True, True, True, False]
    assert _scope_press_at(0, rightclick=False, scoped_b=scoped) is False
    assert _scope_press_at(1, rightclick=False, scoped_b=scoped) is True   # 开镜上升沿
    assert _scope_press_at(2, rightclick=False, scoped_b=scoped) is False  # 瞄准时不再亮
    assert _scope_press_at(4, rightclick=False, scoped_b=scoped) is False  # 关镜


def test_scope_ephemeral_map():
    pdf = pd.DataFrame({
        "tick": [100, 101, 102],
        "buttons": [1 << 11, 0, 0],
        "FIRE": [False, True, False],
        "RIGHTCLICK": [True, False, False],
        "is_scoped": [False, True, True],
    })
    ep = _build_ephemeral_map(
        pdf,
        c_mask="buttons",
        c_fire="FIRE",
        c_rightclick="RIGHTCLICK",
        c_scope="is_scoped",
    )
    assert ep[100]["scope"] is True   # 刀划右键
    assert ep[101]["scope"] is True   # 开镜上升沿
    assert ep[102]["scope"] is False  # 开镜中不常亮


def test_classify_grenade_throw_left_right_both():
    left = pd.Series({"user_FIRE": True, "user_RIGHTCLICK": False, "user_buttons": 1})
    right = pd.Series({"user_FIRE": False, "user_RIGHTCLICK": True, "user_buttons": 1 << 11})
    both = pd.Series({"user_FIRE": True, "user_RIGHTCLICK": True, "user_buttons": 2049})
    none = pd.Series({"user_FIRE": False, "user_RIGHTCLICK": False, "user_buttons": 0})
    kw = dict(c_fire="user_FIRE", c_rightclick="user_RIGHTCLICK", c_buttons="user_buttons")
    assert _classify_grenade_throw_row(left, **kw) == {"jump": False, "fire": True, "scope": False}
    assert _classify_grenade_throw_row(right, **kw) == {"jump": False, "fire": False, "scope": True}
    assert _classify_grenade_throw_row(both, **kw) == {"jump": False, "fire": True, "scope": True}
    assert _classify_grenade_throw_row(none, **kw) is None


def test_grenade_throw_flags_from_weapon_fire():
    fire_df = pd.DataFrame({
        "tick": [90, 100, 101, 102, 103],
        "user_name": ["p1", "p1", "p2", "p1", "p1"],
        "weapon": [
            "ak47", "weapon_hegrenade", "flashbang",
            "weapon_smokegrenade", "weapon_flashbang",
        ],
        "user_FIRE": [False, True, True, True, False],
        "user_RIGHTCLICK": [False, False, False, False, True],
        "user_buttons": [0, 1, 1, 1, 2048],
    })
    flags = _grenade_throw_flags_from_weapon_fire(
        fire_df,
        steamid=None,
        player_name="p1",
        start_tick=95,
        end_tick=105,
    )
    assert flags[100] == {"jump": False, "fire": True, "scope": False}
    assert flags[102] == {"jump": False, "fire": True, "scope": False}
    assert flags[103] == {"jump": False, "fire": False, "scope": True}


def test_grenade_throw_merged_into_fire_bucket():
    records = [{"tick": 100, "jump": False, "fire": False, "scope": False}]
    ephemeral = _ephemeral_flags_for_ticks({102}, fire=True)
    _merge_ephemeral_buckets(records, ephemeral, end_tick=103)
    assert records[0]["fire"] is True


def test_grenade_both_buttons_merged_into_bucket():
    records = [{"tick": 100, "jump": False, "fire": False, "scope": False}]
    ephemeral = {102: {"jump": False, "fire": True, "scope": True}}
    _merge_ephemeral_buckets(records, ephemeral, end_tick=103)
    assert records[0]["fire"] is True
    assert records[0]["scope"] is True


def test_merge_ephemeral_buckets_or_short_presses():
    records = [
        {"tick": 0, "jump": False, "fire": False, "scope": False},
        {"tick": 4, "jump": False, "fire": False, "scope": False},
    ]
    ephemeral = {
        2: {"jump": True, "fire": False, "scope": False},
        5: {"jump": False, "fire": True, "scope": False},
    }
    _merge_ephemeral_buckets(records, ephemeral, end_tick=7)
    assert records[0]["jump"] is True
    assert records[0]["fire"] is False
    assert records[1]["fire"] is True
