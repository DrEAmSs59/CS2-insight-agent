"""速度类击杀 tag（大拉/跑打/上去就是干）回归：

demoparser2 0.41.2 不暴露 vel_x/vel_y（静默丢列），速度必须用 X/Y 位置差估算。
这些测试用合成的 spatial_cache（dict[tick][name] -> row dict）验证位置差路径。
"""

from app.parser.spatial_analysis import enrich_kill_action_tags_spatial


def _row(x: float, y: float, yaw: float = 0.0) -> dict:
    return {"X": x, "Y": y, "Z": 0.0, "yaw": yaw, "name": "Hero", "is_alive": True, "team_num": 2}


def test_da_la_from_position_delta():
    # 主角 yaw=0（朝 +X），但沿 +Y 横向高速移动 → 一个大拉
    kt = 10000
    cache = {
        kt:      {"Hero": _row(100.0, 60.0)},
        kt - 2:  {"Hero": _row(100.0, 55.0)},
        kt - 8:  {"Hero": _row(100.0, 40.0)},
        kt - 16: {"Hero": _row(100.0, 0.0)},
    }
    round_kills = {1: [{"tick": kt, "victim": "Foe", "weapon": "ak47", "tags": []}]}
    enrich_kill_action_tags_spatial(round_kills, cache, "Hero")
    assert "🎿 一个大拉" in round_kills[1][0]["tags"]


def test_rush_from_position_delta():
    # 沿 +X 朝向方向高速直冲 → 上去就是干（vxy = hypot(60,0)*8 = 480 > 220）
    kt = 10000
    cache = {
        kt:     {"Hero": _row(160.0, 0.0)},
        kt - 8: {"Hero": _row(100.0, 0.0)},
    }
    round_kills = {1: [{"tick": kt, "victim": "Foe", "weapon": "ak47", "tags": []}]}
    enrich_kill_action_tags_spatial(round_kills, cache, "Hero")
    assert "🚀 上去就是干" in round_kills[1][0]["tags"]


def test_static_kill_has_no_velocity_tags():
    # 静止击杀：无位移 → 不应有任何速度类 tag
    kt = 10000
    cache = {
        kt:      {"Hero": _row(100.0, 0.0)},
        kt - 2:  {"Hero": _row(100.0, 0.0)},
        kt - 8:  {"Hero": _row(100.0, 0.0)},
        kt - 16: {"Hero": _row(100.0, 0.0)},
    }
    round_kills = {1: [{"tick": kt, "victim": "Foe", "weapon": "ak47", "tags": []}]}
    enrich_kill_action_tags_spatial(round_kills, cache, "Hero")
    tags = round_kills[1][0]["tags"]
    assert "🎿 一个大拉" not in tags
    assert "🚀 上去就是干" not in tags
    assert "🏃‍♂️ 跑打" not in tags
