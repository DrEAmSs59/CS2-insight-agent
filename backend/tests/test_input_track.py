import sys, os
from concurrent.futures import ThreadPoolExecutor
sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))

import pandas as pd
from app.parser import input_track as input_track_module
from app.parser.input_track import (
    KEYS,
    _build_ephemeral_map,
    _classify_grenade_throw_row,
    _ephemeral_flags_for_ticks,
    _grenade_throw_flags_from_weapon_fire,
    _merge_ephemeral_buckets,
    _pick_bool,
    _resolve_col,
    _resolve_button_mask_col,
    _event_ticks_for_player,
    _infer_movement_from_motion,
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


def test_resolve_button_mask_supports_new_usercmd_layout():
    df = pd.DataFrame({"usercmd_buttonstate_1": [8]})
    assert _resolve_button_mask_col(df) == "usercmd_buttonstate_1"


def test_motion_inference_uses_player_view_space():
    pdf = pd.DataFrame({
        "tick": [10, 11, 12],
        "X": [0.0, 1.0, 1.0],
        "Y": [0.0, 0.0, -1.0],
        "yaw": [0.0, 0.0, 0.0],
    })
    movement = _infer_movement_from_motion(pdf, min_units_per_tick=0.1)
    assert movement["W"] == [True, False, False]
    assert movement["D"] == [False, True, True]
    assert movement["A"] == [False, False, False]


def test_event_ticks_for_player_filters_identity_and_range():
    events = pd.DataFrame({
        "tick": [99, 100, 101, 102],
        "user_steamid": ["1", "1", "2", "1"],
        "user_name": ["p1", "p1", "p2", "p1"],
    })
    assert _event_ticks_for_player(
        events,
        steamid="1",
        player_name=None,
        start_tick=100,
        end_tick=101,
    ) == {100}


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


def test_overlapping_segments_share_one_tick_and_event_parse(monkeypatch):
    parse_tick_calls = 0
    parse_event_calls = 0

    class FakeParser:
        def __init__(self, _path):
            pass

        def parse_ticks(self, _props, *, ticks):
            nonlocal parse_tick_calls
            parse_tick_calls += 1
            rows = []
            for tick in ticks:
                rows.append({"tick": tick, "buttons": 1 << 3, "name": "p1", "steamid": "1"})
                rows.append({"tick": tick, "buttons": 1 << 9, "name": "p2", "steamid": "2"})
            return pd.DataFrame(rows)

        def parse_event(self, _event_name, **_kwargs):
            nonlocal parse_event_calls
            parse_event_calls += 1
            return pd.DataFrame(columns=["tick", "user_name", "user_steamid", "weapon"])

    monkeypatch.setattr(input_track_module, "DemoParser", FakeParser)
    with input_track_module._CACHE_LOCK:
        input_track_module._tick_table_cache.clear()
        input_track_module._event_table_cache.clear()

    def extract(player, steamid, start, end):
        return input_track_module.extract_input_track(
            "shared.dem",
            player_name=player,
            steamid=steamid,
            start_tick=start,
            end_tick=end,
            shared_start_tick=100,
            shared_end_tick=105,
        )

    with ThreadPoolExecutor(max_workers=2) as pool:
        first = pool.submit(extract, "p1", "1", 100, 102)
        second = pool.submit(extract, "p2", "2", 103, 105)
        p1_track = first.result()
        p2_track = second.result()

    assert parse_tick_calls == 1
    assert parse_event_calls == 1
    assert [row["tick"] for row in p1_track] == [100, 101, 102]
    assert [row["tick"] for row in p2_track] == [103, 104, 105]
    assert all(row["W"] and not row["A"] for row in p1_track)
    assert all(row["A"] and not row["W"] for row in p2_track)


def test_prepared_batch_shares_distant_segments_without_losing_density(monkeypatch):
    parser_constructs = 0
    parse_tick_calls = 0
    parse_events_calls = 0
    parse_event_calls = 0

    class FakeParser:
        def __init__(self, _path):
            nonlocal parser_constructs
            parser_constructs += 1

        def parse_ticks(self, _props, *, ticks):
            nonlocal parse_tick_calls
            parse_tick_calls += 1
            rows = []
            for tick in ticks:
                rows.append({"tick": tick, "buttons": 1 << 3, "name": "p1", "steamid": "1"})
                rows.append({"tick": tick, "buttons": 1 << 9, "name": "p2", "steamid": "2"})
            return pd.DataFrame(rows)

        def parse_events(self, event_names, **_kwargs):
            nonlocal parse_events_calls
            parse_events_calls += 1
            return [
                (
                    event_name,
                    pd.DataFrame(columns=["tick", "user_name", "user_steamid", "weapon"]),
                )
                for event_name in reversed(event_names)
            ]

        def parse_event(self, _event_name, **_kwargs):
            nonlocal parse_event_calls
            parse_event_calls += 1
            raise AssertionError("prepared batch must not fall back to per-event parsing")

    monkeypatch.setattr(input_track_module, "DemoParser", FakeParser)
    windows = [(100, 102), (10_000, 10_002)]
    prepared = input_track_module.prepare_input_track_batch("shared.dem", windows)

    with ThreadPoolExecutor(max_workers=2) as pool:
        first = pool.submit(
            input_track_module.extract_input_track,
            "shared.dem",
            player_name="p1",
            steamid="1",
            start_tick=100,
            end_tick=102,
            prepared=prepared,
        )
        second = pool.submit(
            input_track_module.extract_input_track,
            "shared.dem",
            player_name="p2",
            steamid="2",
            start_tick=10_000,
            end_tick=10_002,
            prepared=prepared,
        )
        p1_track = first.result()
        p2_track = second.result()

    assert parser_constructs == 2
    assert parse_tick_calls == 1
    assert parse_events_calls == 1
    assert parse_event_calls == 0
    assert [row["tick"] for row in p1_track] == [100, 101, 102]
    assert [row["tick"] for row in p2_track] == [10_000, 10_001, 10_002]


def test_prepared_batch_reuses_dense_short_press_table(monkeypatch):
    parse_tick_calls = 0

    class FakeParser:
        def __init__(self, _path):
            pass

        def parse_ticks(self, _props, *, ticks):
            nonlocal parse_tick_calls
            parse_tick_calls += 1
            return pd.DataFrame({
                "tick": ticks,
                "buttons": [1 << 3 for _ in ticks],
                "name": ["p1" for _ in ticks],
                "steamid": ["1" for _ in ticks],
            })

        def parse_events(self, event_names, **_kwargs):
            return [
                (
                    event_name,
                    pd.DataFrame(columns=["tick", "user_name", "user_steamid", "weapon"]),
                )
                for event_name in event_names
            ]

    monkeypatch.setattr(input_track_module, "DemoParser", FakeParser)
    prepared = input_track_module.prepare_input_track_batch(
        "long.dem",
        [(100, 3_100), (10_000, 13_000)],
    )
    first = input_track_module.extract_input_track(
        "long.dem",
        player_name="p1",
        steamid="1",
        start_tick=100,
        end_tick=3_100,
        prepared=prepared,
    )
    second = input_track_module.extract_input_track(
        "long.dem",
        player_name="p1",
        steamid="1",
        start_tick=10_000,
        end_tick=13_000,
        prepared=prepared,
    )

    # One union parse for regular frames and one for dense short-press frames,
    # regardless of the number or distance of the segments.
    assert parse_tick_calls == 2
    assert len(first) == 1_501
    assert len(second) == 1_501
    assert first[0]["tick"] == 100 and first[-1]["tick"] == 3_100
    assert second[0]["tick"] == 10_000 and second[-1]["tick"] == 13_000


def test_prepared_batch_skips_dense_parse_for_usercmd_fallback(monkeypatch):
    parse_tick_calls = 0

    class FakeParser:
        def __init__(self, _path):
            pass

        def parse_ticks(self, _props, *, ticks):
            nonlocal parse_tick_calls
            parse_tick_calls += 1
            return pd.DataFrame({
                "tick": ticks,
                "usercmd_buttonstate_1": [0 for _ in ticks],
                "name": ["p1" for _ in ticks],
                "steamid": ["1" for _ in ticks],
            })

        def parse_events(self, event_names, **_kwargs):
            return [
                (
                    event_name,
                    pd.DataFrame(columns=["tick", "user_name", "user_steamid", "weapon"]),
                )
                for event_name in event_names
            ]

    monkeypatch.setattr(input_track_module, "DemoParser", FakeParser)
    prepared = input_track_module.prepare_input_track_batch(
        "new-format.dem",
        [(100, 3_100), (10_000, 13_000)],
    )
    track = input_track_module.extract_input_track(
        "new-format.dem",
        player_name="p1",
        steamid="1",
        start_tick=100,
        end_tick=3_100,
        prepared=prepared,
    )

    assert parse_tick_calls == 1
    assert len(track) == 1_501
