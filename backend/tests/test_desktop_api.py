from __future__ import annotations

import asyncio

import pytest
from fastapi import HTTPException

from app.api import desktop


def test_file_picker_supports_multiple_lite_cut_assets(monkeypatch):
    expected = [r"C:\media\one.mp4", r"D:\clips\two.wav"]

    def fake_picker(file_filter: str, multiple: bool) -> list[str]:
        assert "*.mp4" in file_filter
        assert "*.wav" in file_filter
        assert multiple is True
        return expected

    monkeypatch.setattr(desktop.sys, "platform", "win32")
    monkeypatch.setattr(desktop, "_run_windows_file_picker", fake_picker)

    result = asyncio.run(desktop.file_picker(desktop.FilePickerBody(
        file_type="lite_cut_asset",
        multiple=True,
    )))

    assert result == {"path": expected[0], "paths": expected}


def test_file_picker_returns_empty_paths_when_selection_is_cancelled(monkeypatch):
    monkeypatch.setattr(desktop.sys, "platform", "win32")
    monkeypatch.setattr(desktop, "_run_windows_file_picker", lambda *_args: [])

    result = asyncio.run(desktop.file_picker(desktop.FilePickerBody()))

    assert result == {"path": None, "paths": []}


def test_launch_cs2_inspect_delegates_validated_url_to_host(monkeypatch):
    delivered: list[str] = []

    async def fake_deliver(payload: str) -> dict[str, bool]:
        delivered.append(payload)
        return {"already_running": False, "dispatched": True}

    monkeypatch.setattr(desktop, "_launch_and_deliver_cs2_inspect", fake_deliver)

    result = asyncio.run(desktop.launch_cs2_inspect(desktop.Cs2InspectBody(hex="00aBcD123456")))

    assert result == {"ok": True, "already_running": False, "dispatched": True}
    assert delivered == ["00ABCD123456"]


@pytest.mark.parametrize("payload", ["0011223344556", "001122XX3344"])
def test_launch_cs2_inspect_rejects_malformed_payload(payload):
    with pytest.raises(HTTPException) as exc_info:
        asyncio.run(desktop.launch_cs2_inspect(desktop.Cs2InspectBody(hex=payload)))

    assert exc_info.value.status_code == 422


def test_cold_cs2_launch_waits_then_dispatches_canonical_inspect_uri(monkeypatch):
    opened: list[str] = []

    monkeypatch.setattr(desktop, "find_cs2_hwnd", lambda: 0)
    monkeypatch.setattr(desktop, "_launch_cs2_inspect_url", opened.append)

    async def fake_wait(_timeout: float = 75.0) -> bool:
        return True

    async def fake_sleep(_seconds: float) -> None:
        return None

    monkeypatch.setattr(desktop, "_wait_for_cs2_window", fake_wait)
    monkeypatch.setattr(desktop.asyncio, "sleep", fake_sleep)

    result = asyncio.run(desktop._launch_and_deliver_cs2_inspect("00AABBCCDDEE"))

    assert result == {"already_running": False, "dispatched": True}
    assert opened == [
        "steam://run/730",
        "steam://rungame/730/76561202255233023/"
        "+csgo_econ_action_preview%2000AABBCCDDEE",
    ]


def test_running_cs2_receives_self_contained_steam_preview_without_console_bind(monkeypatch):
    opened: list[str] = []

    monkeypatch.setattr(desktop, "find_cs2_hwnd", lambda: 123)
    monkeypatch.setattr(desktop, "_launch_cs2_inspect_url", opened.append)

    result = asyncio.run(desktop._launch_and_deliver_cs2_inspect("00AABBCCDDEE"))

    assert result == {"already_running": True, "dispatched": True}
    assert opened == [
        "steam://rungame/730/76561202255233023/"
        "+csgo_econ_action_preview%2000AABBCCDDEE"
    ]
