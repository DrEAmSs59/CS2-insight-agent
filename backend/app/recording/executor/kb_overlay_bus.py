import asyncio
import json
import logging
import time

logger = logging.getLogger(__name__)


class KbOverlayBus:
    def __init__(self) -> None:
        self._clients: set = set()
        self._lock = asyncio.Lock()
        self._last_load: dict | None = None
        # 运行时状态，用于晚连接客户端自动同步
        self._is_running: bool = False
        self._resume_mono: float | None = None   # monotonic time of last resume
        self._active_ms: float = 0               # ms accumulated before last resume

    async def register(self, ws) -> None:
        """新客户端连入：先推 load 快照，如果正在播放再推带时间偏移的 resume。"""
        async with self._lock:
            self._clients.add(ws)
            last = self._last_load
            is_running = self._is_running
            if is_running and self._resume_mono is not None:
                elapsed_ms = self._active_ms + (time.monotonic() - self._resume_mono) * 1000
            else:
                elapsed_ms = self._active_ms

        if last is not None:
            try:
                await ws.send_text(json.dumps(last))
            except Exception:
                pass
            if is_running:
                try:
                    await ws.send_text(json.dumps({"type": "resume", "elapsed_ms": elapsed_ms}))
                except Exception:
                    pass

    async def unregister(self, ws) -> None:
        async with self._lock:
            self._clients.discard(ws)

    async def broadcast(self, msg: dict) -> None:
        t = msg.get("type")
        if t == "load":
            logger.info("[KbOverlayBus] broadcast load: %d frames, clients=%d",
                        len(msg.get("frames") or []), len(self._clients))
        else:
            logger.info("[KbOverlayBus] broadcast %s: clients=%d", t, len(self._clients))
        async with self._lock:
            if t == "load":
                self._last_load = msg
                self._is_running = False
                self._active_ms = 0
                self._resume_mono = None
            elif t == "resume":
                self._is_running = True
                self._resume_mono = time.monotonic()
            elif t == "pause":
                if self._is_running and self._resume_mono is not None:
                    self._active_ms += (time.monotonic() - self._resume_mono) * 1000
                self._is_running = False
                self._resume_mono = None
            elif t == "end":
                self._is_running = False
                self._active_ms = 0
                self._resume_mono = None

            data = json.dumps(msg)
            dead = []
            for ws in self._clients:
                try:
                    await ws.send_text(data)
                except Exception:
                    dead.append(ws)
            for ws in dead:
                self._clients.discard(ws)


kb_overlay_bus = KbOverlayBus()
