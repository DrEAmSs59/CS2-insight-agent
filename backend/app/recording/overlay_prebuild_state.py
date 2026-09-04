"""KillFX overlay 预构建进度共享状态。"""
from __future__ import annotations

_state: dict = {
    "active": False,   # 是否正在预构建
    "done": 0,         # 已完成的 segment 数
    "total": 0,        # 总 segment 数
    "message": "",     # 当前阶段描述
}


def reset() -> None:
    _state.update(active=False, done=0, total=0, message="")


def start(total: int) -> None:
    _state.update(active=True, done=0, total=total, message=f"预构建击杀特效数据 0/{total}")


def update(done: int, total: int) -> None:
    _state.update(done=done, total=total, message=f"预构建击杀特效数据 {done}/{total}")


def finish() -> None:
    t = _state["total"]
    _state.update(active=False, done=t, message=f"击杀特效数据预构建完成 {t}/{t}")


def get() -> dict:
    return dict(_state)
