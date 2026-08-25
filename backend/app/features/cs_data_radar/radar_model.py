"""cs数据图 维度模型 — 与 Rock-Radar-main 的六维雷达图配置对齐。

Rock-Radar 使用 DIM_NAMES / BASE_MAX_SCORES / MIN_SCORES / USE_PERCENTAGE
逐维度控制绘制基准。这里把六个维度抽成元数据，并基于 CS2-insight-agent
对局解析工作台（match_workspace）产出的玩家数据自动推导各维度取值：

    KPR         每回合击杀    (kills / rounds)
    Surviving   存活率        (survival_rate)
    ADR         每回合伤害    (adr)
    KAST        不白给率      (kast)
    Multi-kill  多杀回合      (2 杀以上回合数 / rounds)
    Rating      评级          0.3591*kpr - 0.5329*dpr + 0.2372*impact
                              + 0.0032*adr + 0.1587（impact 仅供公式内部使用）
"""

from __future__ import annotations

from typing import Any, Optional

# 六维元数据（顺序即雷达图顶点顺序，顺时针从正上方开始）
# max_score = 雷达图最外圈（蓝色最高刻度）对应的满分基准线：
#   KPR 0.85 · 生存率 44% · ADR 85 · KAST 78% · Multi-kill 20% · Rating 1.3
RADAR_DIMENSIONS: list[dict[str, Any]] = [
    {
        "key": "kpr",
        "name": "KPR",
        "label_zh": "回合击杀",
        "max_score": 0.85,
        "min_score": 0.0,
        "percentage": False,
    },
    {
        "key": "survival_rate",
        "name": "Surviving",
        "label_zh": "存活率",
        "max_score": 0.44,
        "min_score": 0.0,
        "percentage": True,
    },
    {
        "key": "adr",
        "name": "ADR",
        "label_zh": "回合伤害",
        "max_score": 85.0,
        "min_score": 0.0,
        "percentage": False,
    },
    {
        "key": "kast",
        "name": "KAST",
        "label_zh": "不白给率",
        "max_score": 0.78,
        "min_score": 0.0,
        "percentage": True,
    },
    {
        "key": "multi_kill",
        "name": "Multi-kill",
        "label_zh": "多杀回合",
        "max_score": 0.2,
        "min_score": 0.0,
        "percentage": True,
    },
    {
        "key": "rating",
        "name": "Rating",
        "label_zh": "评级",
        "max_score": 1.3,
        "min_score": 0.0,
        "percentage": False,
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


def derive_radar_stats(stats: Optional[dict[str, Any]]) -> dict[str, float]:
    """从对局解析的玩家数据推导六个雷达维度取值（自动读取解析后的数据）。

    支持 match_workspace 的 ``players`` 行结构；缺失字段时按 0 兜底，
    保证六维齐全、绘制不越界。
    """
    s = stats if isinstance(stats, dict) else {}
    kills = _num(s.get("kills"))
    deaths = _num(s.get("deaths"))
    assists = _num(s.get("assists"))
    kpr = _num(s.get("kpr"))
    dpr = _num(s.get("dpr"))
    adr = _num(s.get("adr"))

    # 回合数优先用解析侧字段，否则用 kills/kpr 反推，避免除零
    rounds = _num(s.get("rounds") or s.get("total_rounds"))
    if rounds <= 0 and kpr > 0:
        rounds = kills / kpr
    rounds = max(1.0, rounds)
    if kpr <= 0 and rounds > 0:
        kpr = kills / rounds
    if dpr <= 0 and rounds > 0:
        dpr = deaths / rounds

    # KAST / 生存率：解析侧存的是百分数（0-100），统一转 0-1
    kast_raw = _num(s.get("kast"), default=0.0)
    kast = kast_raw / 100.0 if kast_raw > 1.0 else kast_raw
    surv_raw = _num(s.get("survival_rate"), default=0.0)
    survival = surv_raw / 100.0 if surv_raw > 1.0 else surv_raw

    apr = assists / rounds  # 每回合助攻（Rating 公式内部使用）

    # Multi-kill（多杀回合）：2 杀及以上回合数 ÷ 总回合数
    multi_kill_rounds = sum(
        _num(s.get(key)) for key in ("two_kill_rounds", "three_kill_rounds", "four_kill_rounds", "five_kill_rounds")
    )
    multi_kill = min(1.0, multi_kill_rounds / rounds)

    impact = 2.13 * kpr + 0.42 * apr - 0.41  # 仅用于 Rating 公式，不作为展示维度
    rating = 0.3591 * kpr - 0.5329 * dpr + 0.2372 * impact + 0.0032 * adr + 0.1587

    # 无任何实际数据时（例如空对局），Rating 公式里的常数项会让 0 数据
    # 显示成 0.16，这里统一归零，避免空数据画出一个非零的评分。
    has_data = (kills > 0 or deaths > 0 or assists > 0 or kpr > 0 or dpr > 0 or adr > 0)
    if not has_data:
        rating = 0.0

    out: dict[str, float] = {}
    for dim in RADAR_DIMENSIONS:
        key = dim["key"]
        if key == "kpr":
            out[key] = _round(kpr, 2)
        elif key == "survival_rate":
            out[key] = _round(survival, 2)
        elif key == "adr":
            out[key] = _round(adr, 1)
        elif key == "kast":
            out[key] = _round(kast, 2)
        elif key == "multi_kill":
            out[key] = _round(multi_kill, 2)
        elif key == "rating":
            out[key] = _round(rating, 2)
        else:
            out[key] = 0.0
    return out


# 归一化上限：超过满分刻度的数据允许溢出到蓝色外圈之外（如 Multi-kill 25% > 满分 20%），
# 上限 1.6 防止极端值画出画布；画布几何（中心/半径）按此上限留出空间。
NORMALIZE_CEILING = 1.6


def normalize_radar_values(radar: dict[str, Any]) -> list[float]:
    """把六个维度取值相对各自满分刻度归一化，用于绘制顶点。

    大于满分的数值会超出最外圈（蓝色最高刻度），不再封顶在圈上；
    仅限制上限 1.6 防止极端值跑出画布。
    """
    values: list[float] = []
    for dim in RADAR_DIMENSIONS:
        key = dim["key"]
        raw = _num(radar.get(key) if isinstance(radar, dict) else 0.0)
        max_score = _num(dim["max_score"])
        min_score = _num(dim["min_score"])
        span = max(0.0001, max_score - min_score)
        values.append(max(0.0, min(NORMALIZE_CEILING, (raw - min_score) / span)))
    return values


def average_radar_value(radar: dict[str, Any]) -> float:
    """六个维度归一化值的平均值 —— 中心红色六边形（个人均值兜底）的半径比例。"""
    values = normalize_radar_values(radar)
    return round(sum(values) / max(1, len(values)), 3)


def compute_match_avg_radar(players_stats: list[dict[str, Any]]) -> dict[str, float]:
    """本场全部玩家的六维平均值（红色“全场均值基准线”）。

    每个维度取所有玩家派生值（derive_radar_stats）的算术平均，
    供雷达图绘制一条可对比的全场平均参考线。
    """
    players_list = [p for p in (players_stats or []) if isinstance(p, dict)]
    if not players_list:
        return {dim["key"]: 0.0 for dim in RADAR_DIMENSIONS}
    acc: dict[str, list[float]] = {dim["key"]: [] for dim in RADAR_DIMENSIONS}
    for stats in players_list:
        radar = derive_radar_stats(stats)
        for key in DIMENSION_KEYS:
            acc[key].append(_num(radar.get(key)))
    return {
        key: round(sum(values) / max(1, len(values)), 2)
        for key, values in acc.items()
    }


def format_radar_value(key: str, value: float) -> str:
    """按维度配置格式化展示文本（百分数 / 小数）。"""
    dim = next((d for d in RADAR_DIMENSIONS if d["key"] == key), None)
    v = _num(value)
    if dim is None:
        return f"{v:.2f}"
    if dim["percentage"]:
        return f"{int(round(v * 100))}%"
    digits = 2 if key in {"kpr", "rating"} else (1 if key == "adr" else 0)
    return f"{v:.{digits}f}"
