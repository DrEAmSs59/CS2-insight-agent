"""Demo 库变更通知：供 SSE 推给前端，触发列表自动刷新。"""

from __future__ import annotations

import asyncio
import logging
import os
from typing import Optional

logger = logging.getLogger(__name__)


def _debounce_seconds() -> float:
    raw = (os.environ.get("CS2_INSIGHT_LIBRARY_SSE_DEBOUNCE_SEC") or "").strip()
    try:
        v = float(raw)
    except ValueError:
        v = 0.0
    if v <= 0:
        v = 0.55
    return min(max(v, 0.05), 5.0)


class DemoLibraryHub:
    """内存 pub/sub；notify 在服务端防抖，避免批量入库时 SSE 洪泛。"""

    __slots__ = ("_lock", "_subs", "_deb_lock", "_deb_gen", "_flush_task")

    def __init__(self) -> None:
        self._lock = asyncio.Lock()
        self._subs: list[asyncio.Queue[str]] = []
        self._deb_lock = asyncio.Lock()
        self._deb_gen = 0
        self._flush_task: Optional[asyncio.Task[None]] = None

    async def subscribe(self) -> asyncio.Queue[str]:
        q: asyncio.Queue[str] = asyncio.Queue(maxsize=64)
        async with self._lock:
            self._subs.append(q)
        return q

    async def unsubscribe(self, q: asyncio.Queue[str]) -> None:
        async with self._lock:
            try:
                self._subs.remove(q)
            except ValueError:
                pass

    async def notify(self, reason: str = "changed") -> None:
        """合并短时间内的多次通知，静默期结束后只向客户端推一条（reason 恒为 changed）。"""
        _ = reason  # 保留参数供调用方标注语义；推送负载统一为 changed，减少前端分支
        try:
            loop = asyncio.get_running_loop()
        except RuntimeError:
            return
        async with self._deb_lock:
            self._deb_gen += 1
            gen = self._deb_gen
            old = self._flush_task
            if old is not None and not old.done():
                old.cancel()
            self._flush_task = loop.create_task(self._sleep_and_emit(gen))

    async def _sleep_and_emit(self, gen: int) -> None:
        try:
            await asyncio.sleep(_debounce_seconds())
        except asyncio.CancelledError:
            return
        async with self._deb_lock:
            if gen != self._deb_gen:
                return
        await self._emit_one()

    async def _emit_one(self) -> None:
        try:
            async with self._lock:
                targets = list(self._subs)
            msg = "changed"
            for q in targets:
                try:
                    q.put_nowait(msg)
                except asyncio.QueueFull:
                    try:
                        while True:
                            q.get_nowait()
                    except asyncio.QueueEmpty:
                        break
                    try:
                        q.put_nowait(msg)
                    except asyncio.QueueFull:
                        pass
        except Exception as e:  # noqa: BLE001
            logger.warning("demo library hub emit failed: %s", e)


demo_library_hub = DemoLibraryHub()
