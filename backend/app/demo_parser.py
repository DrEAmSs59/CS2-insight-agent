"""向后兼容 shim — 实现已迁移到 app/parser/ 包。请勿在新代码中从此文件导入新符号。"""
# ruff: noqa: F401, F403
from .parser import *
from .parser import (
    # round_timeline.py 使用 `import demo_parser as dp` 后访问的属性
    _dedup_context_tags,
    _normalize_item,
    WEAPON_TRANSLATION_MAP,
    _bool,
    _int,
    _round_end_winner_team_num,
    # radar_data_extractor.py
    _to_pandas_df,
    # obs_director.py
    BUFFER_SECONDS_BEFORE,
    BUFFER_SECONDS_AFTER,
    TICK_RATE,
    compute_spec_player_slot_one_based,
    get_demo_spec_calibration_tick,
    get_player_list,
    spec_player_extra_offset_for_gsi_failure,
    # parse_worker.py
    DemoAnalyzer,
    get_demo_match_summary,
    inspect_demo,
    # ai_reviewer.py
    Clip,
    meme_series_badges_for_kd,
)
