"""cs数据图 维度模型 — 与 Rock-Radar-main 的六维雷达图配置对齐。

Rock-Radar 使用 DIM_NAMES / BASE_MAX_SCORES / MIN_SCORES / USE_PERCENTAGE
逐维度控制绘制基准。这里把六个维度抽成元数据，并基于 CS2-insight-agent
对局解析工作台（match_workspace）产出的玩家数据自动推导各维度取值：

    KPR         场均击杀      (kills / rounds)
    Surviving   生存率        (survival_rate)
    ADR         场均伤害      (adr)
    KAST        团队贡献      (kast)
    Multi-kill  多杀回合      (2 杀以上回合数，直接计数)
    Rating      综合评分      手填；Valve 未公开算法，未填则雷达少一维
"""

from __future__ import annotations

from typing import Any, Optional

# 六维元数据（顺序即雷达图顶点顺序，顺时针从正上方开始）
# max_score = 雷达图最外圈（蓝色最高刻度）对应的满分基准线：
#   KPR 0.85 · 生存率 44% · ADR 85 · KAST 78% · Multi-kill 8 回合 · Rating 1.3
RADAR_DIMENSIONS: list[dict[str, Any]] = [
    {
        "key": "kpr",
        "name": "KPR",
        "label_zh": "场均击杀",
        "max_score": 0.85,
        "min_score": 0.0,
        "percentage": False,
        "integer": False,
    },
    {
        "key": "survival_rate",
        "name": "Surviving",
        "label_zh": "生存率",
        "max_score": 0.44,
        "min_score": 0.0,
        "percentage": True,
        "integer": False,
    },
    {
        "key": "adr",
        "name": "ADR",
        "label_zh": "场均伤害",
        "max_score": 85.0,
        "min_score": 0.0,
        "percentage": False,
        "integer": False,
    },
    {
        "key": "kast",
        "name": "KAST",
        "label_zh": "团队贡献",
        "max_score": 0.78,
        "min_score": 0.0,
        "percentage": True,
        "integer": False,
    },
    {
        "key": "multi_kill",
        "name": "Multi-kill",
        "label_zh": "多杀回合",
        "max_score": 8.0,
        "min_score": 0.0,
        "percentage": False,
        "integer": True,
    },
    {
        "key": "rating",
        "name": "Rating",
        "label_zh": "综合评分",
        "max_score": 1.3,
        "min_score": 0.0,
        "percentage": False,
        "integer": False,
    },
]

DIMENSION_KEYS: list[str] = [dim["key"] for dim in RADAR_DIMENSIONS]


def _num(value: Any, default: float = 0.0) -> float:
    try:
        n = float(value)
    except (TypeError, ValueError):
        return default
    return n if n == n and n != float("inf") and n != float("-inf") else default  # NaN guard


def _round(value: float, digits: int = 2) -> float:
    return round(max(0.0, float(value)), digits)


def derive_radar_stats(
    stats: Optional[dict[str, Any]],
    rating: Optional[float] = None,
) -> dict[str, float]:
    """从对局解析的玩家数据推导自动维度；Rating 仅在显式传入时写入。"""
    s = stats if isinstance(stats, dict) else {}
    kills = _num(s.get("kills"))
    deaths = _num(s.get("deaths"))
    assists = _num(s.get("assists"))
    kpr = _num(s.get("kpr"))
    dpr = _num(s.get("dpr"))
    adr = _num(s.get("adr"))

    rounds = _num(s.get("rounds") or s.get("total_rounds"))
    if rounds <= 0 and kpr > 0:
        rounds = kills / kpr
    rounds = max(1.0, rounds)
    if kpr <= 0 and rounds > 0:
        kpr = kills / rounds
    if dpr <= 0 and rounds > 0:
        dpr = deaths / rounds

    kast_raw = _num(s.get("kast"), default=0.0)
    kast = kast_raw / 100.0 if kast_raw > 1.0 else kast_raw
    surv_raw = _num(s.get("survival_rate"), default=0.0)
    survival = surv_raw / 100.0 if surv_raw > 1.0 else surv_raw

    multi_kill_rounds = sum(
        _num(s.get(key)) for key in ("two_kill_rounds", "three_kill_rounds", "four_kill_rounds", "five_kill_rounds")
    )

    out: dict[str, float] = {
        "kpr": _round(kpr, 2),
        "survival_rate": _round(survival, 2),
        "adr": _round(adr, 1),
        "kast": _round(kast, 2),
        "multi_kill": _round(multi_kill_rounds, 0),
    }
    if rating is not None and str(rating).strip() != "":
        out["rating"] = _round(_num(rating), 2)
    return out


# 绘制时外圈 = 本局平均值。超过平均值的数据允许溢出到圈外，上限 1.6。
NORMALIZE_CEILING = 1.6


def has_manual_rating(radar: Optional[dict[str, Any]]) -> bool:
    if not isinstance(radar, dict) or "rating" not in radar:
        return False
    value = radar.get("rating")
    if value is None or value == "":
        return False
    try:
        float(value)
    except (TypeError, ValueError):
        return False
    return True


def active_radar_dimensions(radar: Optional[dict[str, Any]] = None) -> list[dict[str, Any]]:
    if has_manual_rating(radar):
        return list(RADAR_DIMENSIONS)
    return [dim for dim in RADAR_DIMENSIONS if dim["key"] != "rating"]


def normalize_radar_values(radar: dict[str, Any]) -> list[float]:
    """兼容旧接口：相对各自满分刻度归一化。绘制请用 normalize_radar_values_by_median。"""
    values: list[float] = []
    for dim in active_radar_dimensions(radar if isinstance(radar, dict) else None):
        key = dim["key"]
        raw = _num(radar.get(key) if isinstance(radar, dict) else 0.0)
        max_score = _num(dim["max_score"])
        min_score = _num(dim["min_score"])
        span = max(0.0001, max_score - min_score)
        values.append(max(0.0, min(NORMALIZE_CEILING, (raw - min_score) / span)))
    return values


def normalize_radar_values_by_median(
    radar: dict[str, Any],
    median_radar: Optional[dict[str, Any]] = None,
) -> list[float]:
    """玩家数据相对本局平均值归一化：平均值 = 外圈 1.0。缺平均值的维回退到原满分。"""
    src = median_radar if isinstance(median_radar, dict) else {}
    values: list[float] = []
    for dim in active_radar_dimensions(radar if isinstance(radar, dict) else None):
        key = dim["key"]
        raw = _num(radar.get(key) if isinstance(radar, dict) else 0.0)
        ref = _num(src.get(key)) if key in src else 0.0
        span = ref if ref > 1e-9 else _num(dim["max_score"])
        span = max(0.0001, span)
        values.append(max(0.0, min(NORMALIZE_CEILING, raw / span)))
    return values


def average_radar_value(radar: dict[str, Any]) -> float:
    """六个维度归一化值的平均值 —— 中心红色六边形（个人均值兜底）的半径比例。"""
    values = normalize_radar_values(radar)
    return round(sum(values) / max(1, len(values)), 3)


def _median(values: list[float]) -> float:
    ordered = sorted(values)
    n = len(ordered)
    if n <= 0:
        return 0.0
    mid = n // 2
    if n % 2:
        return float(ordered[mid])
    return (float(ordered[mid - 1]) + float(ordered[mid])) / 2.0


def compute_match_avg_radar(
    players_stats: list[dict[str, Any]],
    *,
    rating_avg: Optional[float] = None,
) -> dict[str, float]:
    """本场全部玩家自动维度的算术平均；Rating 平均值仅在手填时写入。"""
    auto_keys = [dim["key"] for dim in RADAR_DIMENSIONS if dim["key"] != "rating"]
    players_list = [p for p in (players_stats or []) if isinstance(p, dict)]
    acc: dict[str, list[float]] = {key: [] for key in auto_keys}
    for stats in players_list:
        radar = derive_radar_stats(stats)
        for key in auto_keys:
            acc[key].append(_num(radar.get(key)))
    out: dict[str, float] = {}
    for key in auto_keys:
        digits = 0 if key == "multi_kill" else (1 if key == "adr" else 2)
        values = acc[key]
        out[key] = _round(sum(values) / max(1, len(values)), digits) if values else 0.0
    if rating_avg is not None and str(rating_avg).strip() != "":
        out["rating"] = _round(_num(rating_avg), 2)
    return out


def compute_match_median_radar(
    players_stats: list[dict[str, Any]],
    *,
    rating_median: Optional[float] = None,
) -> dict[str, float]:
    """兼容旧名：现在返回本局平均值。"""
    return compute_match_avg_radar(players_stats, rating_avg=rating_median)


def format_radar_value(key: str, value: float) -> str:
    """按维度配置格式化展示文本（百分数 / 小数 / 整数）。"""
    dim = next((d for d in RADAR_DIMENSIONS if d["key"] == key), None)
    v = _num(value)
    if dim is None:
        return f"{v:.2f}"
    if dim.get("percentage"):
        return f"{int(round(v * 100))}%"
    if dim.get("integer"):
        return f"{int(round(v))}"
    digits = 2 if key in {"kpr", "rating"} else (1 if key == "adr" else 0)
    return f"{v:.{digits}f}"
