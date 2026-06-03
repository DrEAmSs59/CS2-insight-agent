import sys, os
sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))

import asyncio
import json
from unittest.mock import AsyncMock, MagicMock

# --- helpers ---
def run(coro):
    return asyncio.get_event_loop().run_until_complete(coro)

def make_ws():
    ws = MagicMock()
    ws.send_text = AsyncMock()
    return ws


def get_fresh_bus():
    """Import a fresh KbOverlayBus class (avoids module-level singleton state)."""
    import importlib
    import app.recording.executor.kb_overlay_bus as m
    importlib.reload(m)
    return m.KbOverlayBus()


def test_register_and_broadcast():
    bus = get_fresh_bus()
    ws = make_ws()
    run(bus.register(ws))
    run(bus.broadcast({"type": "resume"}))
    ws.send_text.assert_called_once_with('{"type": "resume"}')


def test_unregister_stops_messages():
    bus = get_fresh_bus()
    ws = make_ws()
    run(bus.register(ws))
    run(bus.unregister(ws))
    run(bus.broadcast({"type": "resume"}))
    ws.send_text.assert_not_called()


def test_load_replayed_on_reconnect():
    bus = get_fresh_bus()
    ws1 = make_ws()
    run(bus.register(ws1))
    load_msg = {"type": "load", "frames": [], "start_tick": 100, "end_tick": 200,
                "tick_rate": 64, "offset_ticks": 0}
    run(bus.broadcast(load_msg))

    ws2 = make_ws()
    run(bus.register(ws2))
    # ws2 should receive the replayed load immediately on register
    ws2.send_text.assert_called_once()
    sent = json.loads(ws2.send_text.call_args[0][0])
    assert sent["type"] == "load"
    assert sent["start_tick"] == 100


def test_dead_client_dropped_on_broadcast():
    bus = get_fresh_bus()
    ws_dead = make_ws()
    ws_dead.send_text = AsyncMock(side_effect=Exception("disconnected"))
    ws_live = make_ws()
    run(bus.register(ws_dead))
    run(bus.register(ws_live))
    run(bus.broadcast({"type": "pause"}))
    # live client received it; dead client silently removed
    ws_live.send_text.assert_called_once()
    # dead client no longer in bus (broadcast again — only live gets it)
    ws_live.send_text.reset_mock()
    run(bus.broadcast({"type": "end"}))
    ws_live.send_text.assert_called_once()
