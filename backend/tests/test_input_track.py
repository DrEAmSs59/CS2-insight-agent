import sys, os
sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))

import pandas as pd
from app.parser.input_track import _resolve_col, _to_df, KEYS

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
