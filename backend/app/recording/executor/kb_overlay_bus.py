import asyncio
import json
import logging

logger = logging.getLogger(__name__)


class KbOverlayBus:
    def __init__(self) -> None:
        self._clients: set = set()
        self._lock = asyncio.Lock()
        self._last_load: dict | None = None

    async def register(self, ws) -> None:
        async with self._lock:
            self._clients.add(ws)
            last = self._last_load
        if last is not None:
            try:
                await ws.send_text(json.dumps(last))
            except Exception:
                pass

    async def unregister(self, ws) -> None:
        async with self._lock:
            self._clients.discard(ws)

    async def broadcast(self, msg: dict) -> None:
        data = json.dumps(msg)
        async with self._lock:
            if msg.get("type") == "load":
                self._last_load = msg
            dead = []
            for ws in self._clients:
                try:
                    await ws.send_text(data)
                except Exception:
                    dead.append(ws)
            for ws in dead:
                self._clients.discard(ws)


kb_overlay_bus = KbOverlayBus()
