import sys, os
sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))

import pandas as pd
from app.parser.input_track import (
    KEYS,
    _build_ephemeral_map,
    _merge_ephemeral_buckets,
    _pick_bool,
    _resolve_col,
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


def test_scope_combines_rightclick_and_scoped():
    pdf = pd.DataFrame({
        "tick": [100, 101, 102],
        "buttons": [1 << 11, 0, 0],
        "FIRE": [False, True, False],
        "RIGHTCLICK": [True, False, False],
        "is_scoped": [False, False, True],
    })
    ep = _build_ephemeral_map(
        pdf,
        c_mask="buttons",
        c_fire="FIRE",
        c_rightclick="RIGHTCLICK",
        c_scope="is_scoped",
    )
    assert ep[100]["scope"] is True   # 刀划右键
    assert ep[100]["fire"] is False
    assert ep[101]["fire"] is True
    assert ep[102]["scope"] is True   # 开镜


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
