from pathlib import Path

from app import main
from app.api import config as config_api


def test_log_directory_is_reported_and_can_be_opened(tmp_path: Path, monkeypatch):
    opened: list[str] = []
    monkeypatch.setattr(main, "get_data_dir", lambda: tmp_path)
    monkeypatch.setattr(config_api.sys, "platform", "win32")
    monkeypatch.setattr(config_api.os, "startfile", opened.append)

    info = main.get_data_dir_info()
    result = main.open_log_directory()

    expected = str((tmp_path / "logs").resolve())
    assert info["logs_path"] == expected
    assert result == {"ok": True, "path": expected}
    assert opened == [expected]
    assert (tmp_path / "logs").is_dir()
