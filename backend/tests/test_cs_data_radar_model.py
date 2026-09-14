"""cs数据图 维度模型测试。"""

import math

from app.features.cs_data_radar.radar_model import (
    RADAR_DIMENSIONS,
    average_radar_value,
    compute_match_avg_radar,
    derive_radar_stats,
    format_radar_value,
    normalize_radar_values,
)


def test_dimensions_shape():
    assert len(RADAR_DIMENSIONS) == 6
    keys = [dim["key"] for dim in RADAR_DIMENSIONS]
    assert keys == ["kpr", "survival_rate", "adr", "kast", "multi_kill", "rating"]
    for dim in RADAR_DIMENSIONS:
        assert dim["max_score"] > 0
        assert dim["min_score"] >= 0
        assert dim["name"]


def test_derive_radar_stats_full():
    stats = {
        "kills": 28,
        "deaths": 12,
        "assists": 7,
        "kpr": 0.99,
        "dpr": 0.42,
        "adr": 101.4,
        "kast": 78.2,
        "survival_rate": 34.0,
        "two_kill_rounds": 6,
        "three_kill_rounds": 2,
        "rounds": 30,
    }
    radar = derive_radar_stats(stats)
    assert radar["kpr"] == 0.99
    assert radar["survival_rate"] == 0.34  # 百分数 → 0-1
    assert radar["adr"] == 101.4
    assert radar["kast"] == 0.78  # 百分数 → 0-1
    assert radar["multi_kill"] == round((6 + 2) / 30, 2)  # 多杀回合 = 2 杀以上回合数 / 回合数
    assert radar["rating"] > 0
    assert all(v >= 0 for v in radar.values())


def test_derive_radar_stats_empty():
    radar = derive_radar_stats({})
    assert set(radar.keys()) == {"kpr", "survival_rate", "adr", "kast", "multi_kill", "rating"}
    assert all(v == 0 for v in radar.values())


def test_derive_radar_stats_none():
    radar = derive_radar_stats(None)
    assert all(v == 0 for v in radar.values())


def test_derive_radar_stats_kpr_fallback():
    # 无 kpr 字段时用 kills/rounds 反推
    radar = derive_radar_stats({"kills": 20, "deaths": 10, "assists": 4, "rounds": 25})
    assert abs(radar["kpr"] - 0.8) < 1e-9
    assert radar["rating"] > 0  # 有实际数据时才给出非零评分


def test_normalize_radar_values():
    # 各维度取“满分刻度的一半”，归一化都应为 0.5
    radar = {
        "kpr": 0.425,        # 0.85 * 0.5
        "survival_rate": 0.22,   # 0.44 * 0.5
        "adr": 42.5,         # 85 * 0.5
        "kast": 0.39,        # 0.78 * 0.5
        "multi_kill": 0.1,   # 0.2 * 0.5
        "rating": 0.65,      # 1.3 * 0.5
    }
    norm = normalize_radar_values(radar)
    assert len(norm) == 6
    assert all(abs(v - 0.5) < 1e-9 for v in norm)


def test_normalize_radar_values_overflow_beyond_ring():
    # 超过满分刻度的数值允许溢出到蓝色外圈之外（>1.0），上限 1.6 防画出画布
    radar = {
        "kpr": 1.5,          # 1.5/0.85 ≈ 1.76 → 封顶 1.6
        "survival_rate": 0.8,   # 0.8/0.44 ≈ 1.82 → 封顶 1.6
        "adr": 220.0,        # 220/85 ≈ 2.59 → 封顶 1.6
        "kast": 1.0,         # 1.0/0.78 ≈ 1.28
        "multi_kill": 3.0,   # 3.0/0.2 = 15 → 封顶 1.6
        "rating": 2.5,       # 2.5/1.3 ≈ 1.92 → 封顶 1.6
    }
    norm = normalize_radar_values(radar)
    assert all(v > 1.0 for v in norm)  # 全部溢出到外圈之外
    assert max(norm) <= 1.6
    assert abs(norm[0] - 1.6) < 1e-9
    assert abs(norm[3] - 1.0 / 0.78) < 1e-9


def test_average_radar_value():
    radar = {
        "kpr": 0.425,
        "survival_rate": 0.22,
        "adr": 42.5,
        "kast": 0.39,
        "multi_kill": 0.1,
        "rating": 0.65,
    }
    avg = average_radar_value(radar)
    assert abs(avg - 0.5) < 1e-3


def test_format_radar_value():
    assert format_radar_value("kpr", 0.99) == "0.99"
    assert format_radar_value("survival_rate", 0.34) == "34%"
    assert format_radar_value("kast", 0.78) == "78%"
    assert format_radar_value("adr", 101.4) == "101.4"
    assert format_radar_value("rating", 1.04) == "1.04"


def test_compute_match_avg_radar():
    players = [
        {"kills": 28, "deaths": 12, "assists": 7, "kpr": 0.99, "dpr": 0.42, "adr": 101.4, "kast": 78.2, "survival_rate": 34.0},
        {"kills": 20, "deaths": 15, "assists": 9, "kpr": 0.71, "dpr": 0.53, "adr": 88.1, "kast": 71.5, "survival_rate": 40.0},
    ]
    avg = compute_match_avg_radar(players)
    assert set(avg.keys()) == {"kpr", "survival_rate", "adr", "kast", "multi_kill", "rating"}
    assert abs(avg["kpr"] - (0.99 + 0.71) / 2) < 1e-9
    assert abs(avg["adr"] - (101.4 + 88.1) / 2) < 1e-9
    assert avg["multi_kill"] == 0  # 样例无多杀回合字段
    assert avg["rating"] > 0
    # 空列表 → 全部为 0
    assert all(v == 0 for v in compute_match_avg_radar([]).values())


def test_animation_easing_curves():
    """两阶段缓动：慢入 → 快出 → 定格；全程单调递增、绝不超过 1.0（无过冲无回弹无第三阶段）。"""
    from app.features.cs_data_radar.radar_animation import (
        P1_END,
        P2_END,
        _flash_energy,
        _mesh_alpha,
        _scale_at,
    )

    # 慢入：0.30 → 0.55，斜率极小（积蓄能量）
    assert abs(_scale_at(0.0) - 0.30) < 1e-9
    assert abs(_scale_at(0.1) - _scale_at(0.0)) < 0.1  # 起步平缓
    assert _scale_at(P1_END - 1e-6) < 0.56
    # 全程单调递增，且绝不超过最终位置 1.0（无过冲、无回弹、无振荡）
    prev = -1.0
    for t in [i / 300 for i in range(0, 301)]:
        v = _scale_at(t)
        assert v >= prev - 1e-9, f"非单调 at t={t}"
        assert v <= 1.0 + 1e-9, f"超过 1.0 at t={t}"
        prev = v
    # 快出：P2 中段已明显扩张
    mid = (P1_END + P2_END) / 2
    assert _scale_at(mid) > 0.75
    # 无第三阶段：快出结束（P2_END）后直接定格在 1.0
    assert abs(_scale_at(P2_END) - 1.0) < 1e-9
    assert abs(_scale_at(0.9) - 1.0) < 1e-9
    assert abs(_scale_at(1.0) - 1.0) < 1e-9
    # 闪光：拍点（爆发开始）即峰值，随后衰减；慢入/定格阶段为 0
    assert abs(_flash_energy(P1_END) - 1.0) < 1e-6
    assert _flash_energy(0.1) == 0.0
    assert _flash_energy(0.9) == 0.0
    # 金色网格只在慢入阶段呼吸
    assert _mesh_alpha(0.15) > 0.2
    assert _mesh_alpha(0.8) == 0.0
