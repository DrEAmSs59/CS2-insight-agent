from __future__ import annotations

import asyncio

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
