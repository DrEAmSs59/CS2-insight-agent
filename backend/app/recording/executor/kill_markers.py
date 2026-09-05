"""把击杀锚点从 demo tick 换算成成片文件内的秒数（击杀轴）。

分段录制复用同一个 OBS 输出文件（`PauseRecord` / `ResumeRecord` jump-cut），
所以成片时长等于各段实际录制时长之和，段与段之间的 demo 时间被丢掉了。
一个击杀在文件里的位置因此需要两部分：

  video_sec = 该段在文件中的起点（之前各段实际录制秒数之和）
            + 该段内从录制开始到击杀的 demo 秒数

第二项不能直接用 ``(anchor_tick - start_tick) / tick_rate``：spec 切换与控制台
注入都在 demo 播放状态下进行，耗时超出预留 pre-roll 时会把 demo 推过
``start_tick``，执行器用 ``record_overhead_sec`` 表示这段被吃掉的窗口，此处必须
扣除。回合段还可能被 GSI 提前停录，因此超出实际录制时长的锚点会被丢弃。
"""

from __future__ import annotations

import logging
from typing import Any, Iterable, Optional

logger = logging.getLogger(__name__)

# 锚点落在录制窗口边缘时的容差：换算基于墙钟估计，允许零点几秒的抖动。
_WINDOW_EPSILON_SEC: float = 0.35


def _coerce_int(value: Any) -> Optional[int]:
    try:
        return int(value)
    except (TypeError, ValueError):
        return None


def _enum_text(value: Any) -> str:
    return str(getattr(value, "value", value) or "")


class KillMarkerTimeline:
    """按录制顺序累计各段时长，产出成片内的击杀轴。

    用法与执行器的分段循环一一对应：``open_segment`` 在 OBS 真正开始/恢复录制后
    调用，``close_segment`` 在该段暂停/停止时调用并传入这段实际录制的秒数。
    只有正常收尾的段会贡献标记；seek / spec 失败的段直接 ``discard_segment``。
    """

    def __init__(self, tick_rate: float) -> None:
        self._tick_rate = float(tick_rate) if tick_rate else 0.0
        self._accumulated_sec: float = 0.0
        self._open: Optional[dict] = None
        self._markers: list[dict] = []

    @property
    def markers(self) -> list[dict]:
        """已完成段的击杀轴，按成片时间升序。"""
        return sorted(self._markers, key=lambda m: m["video_sec"])

    @property
    def accumulated_sec(self) -> float:
        return self._accumulated_sec

    def open_segment(
        self,
        segment: Any,
        *,
        overhead_sec: float = 0.0,
        lead_in_sec: float = 0.0,
    ) -> None:
        """标记该段开始录制。

        ``overhead_sec``: demo 已越过 ``start_tick`` 的秒数（spec 准备超时被吃掉的窗口）。
        ``lead_in_sec``: OBS 开始录制到 demo 恢复播放之间录进文件的静帧时长；恢复分支
        还包含淡入，忽略它会让标记整体偏早。
        """
        self._open = {
            "segment": segment,
            "video_start_sec": self._accumulated_sec,
            "overhead_sec": max(0.0, float(overhead_sec or 0.0)),
            "lead_in_sec": max(0.0, float(lead_in_sec or 0.0)),
        }

    def discard_segment(self) -> None:
        """放弃当前段：既不贡献标记，也不推进成片时间（该段没有进入成片）。"""
        self._open = None

    def close_segment(self, recorded_sec: float, *, keep_markers: bool = True) -> None:
        """收尾当前段并推进成片时间。

        ``keep_markers=False`` 用于该段确实录进了文件、但时序不可信的情况（例如中途
        异常）：仍然推进成片时间，避免后续段的标记整体前移，但不产出本段标记。
        """
        pending = self._open
        self._open = None
        if pending is None:
            return
        duration = max(0.0, float(recorded_sec or 0.0))
        if keep_markers and self._tick_rate > 0:
            self._markers.extend(
                self._build_markers(
                    pending["segment"],
                    video_start_sec=pending["video_start_sec"],
                    overhead_sec=pending["overhead_sec"],
                    lead_in_sec=pending["lead_in_sec"],
                    recorded_sec=duration,
                )
            )
        self._accumulated_sec += duration

    def _video_sec(
        self,
        tick: int,
        *,
        start_tick: int,
        video_start_sec: float,
        overhead_sec: float,
        lead_in_sec: float,
        recorded_sec: float,
    ) -> Optional[float]:
        """某个 demo tick 在成片文件里的秒数；落在录制窗口外返回 None。"""
        offset_sec = lead_in_sec + (tick - start_tick) / self._tick_rate - overhead_sec
        if offset_sec < -_WINDOW_EPSILON_SEC:
            return None
        if offset_sec > recorded_sec + _WINDOW_EPSILON_SEC:
            # 回合段被 GSI 提前停录时，尾部锚点没有进入成片。
            return None
        return round(max(0.0, min(offset_sec, recorded_sec)) + video_start_sec, 3)

    def _build_markers(
        self,
        segment: Any,
        *,
        video_start_sec: float,
        overhead_sec: float,
        lead_in_sec: float,
        recorded_sec: float,
    ) -> Iterable[dict]:
        anchors = getattr(segment, "anchor_ticks", None) or []
        start_tick = _coerce_int(getattr(segment, "start_tick", None))
        if not anchors or start_tick is None:
            return []

        source_type = _enum_text(getattr(segment, "source_type", ""))
        perspective = _enum_text(getattr(segment, "perspective", ""))
        # 受害者 POV 段回放的是同一次击杀，但镜头在被杀方——单独标注，避免击杀轴
        # 把同一个击杀在成片里出现两次误读成两次击杀。
        kind = "death" if source_type == "death" else "kill"
        segment_index = _coerce_int(getattr(segment, "segment_index", None))
        round_number = _coerce_int(getattr(segment, "round", None))

        out: list[dict] = []
        for raw_anchor in anchors:
            anchor = _coerce_int(raw_anchor)
            if anchor is None:
                continue
            video_sec = self._video_sec(
                anchor,
                start_tick=start_tick,
                video_start_sec=video_start_sec,
                overhead_sec=overhead_sec,
                lead_in_sec=lead_in_sec,
                recorded_sec=recorded_sec,
            )
            if video_sec is None:
                continue
            marker: dict = {
                "video_sec": video_sec,
                "tick": anchor,
                "kind": kind,
                "perspective": perspective,
            }
            if segment_index is not None:
                marker["segment_index"] = segment_index
            if round_number is not None:
                marker["round"] = round_number
            out.append(marker)
        return out


def enrich_markers_with_events(markers: list[dict], events: Iterable[Any]) -> list[dict]:
    """用 DTO 的 EventInfo 按 tick 补全受害者 / 武器 / 爆头 / 标签。

    解析阶段的击杀元数据本来就随请求一起送到后端，按 tick 对齐即可给击杀轴配上
    可读标签，不需要为此重新解析 demo。
    """
    if not markers:
        return []
    by_tick: dict[int, Any] = {}
    for event in events or []:
        tick = _coerce_int(getattr(event, "tick", None))
        if tick is not None:
            by_tick.setdefault(tick, event)

    out: list[dict] = []
    for marker in markers:
        merged = dict(marker)
        event = by_tick.get(_coerce_int(merged.get("tick")))
        if event is not None:
            victim = getattr(getattr(event, "victim", None), "name", "") or ""
            if victim and not merged.get("victim"):
                merged["victim"] = victim
            weapon = getattr(event, "weapon", "") or ""
            if weapon and not merged.get("weapon"):
                merged["weapon"] = weapon
            if getattr(event, "headshot", False) and "headshot" not in merged:
                merged["headshot"] = True
            tags = [str(t) for t in (getattr(event, "tags", None) or []) if str(t).strip()]
            if tags and not merged.get("tags"):
                merged["tags"] = tags[:6]
            if merged.get("round") is None:
                round_number = _coerce_int(getattr(event, "round", None))
                if round_number is not None:
                    merged["round"] = round_number
        out.append(merged)
    return out
