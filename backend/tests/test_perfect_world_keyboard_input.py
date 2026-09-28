import asyncio
import sys
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import AsyncMock

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from app.features.demo_library import ingestion


def test_perfect_world_overrides_a_positive_keyboard_probe():
    assert ingestion.demo_lacks_player_keyboard_input("9217429104654498188_0.dem", "完美世界竞技平台")
    assert ingestion.resolve_player_keyboard_input_flag(
        "9217429104654498188_0.dem",
        "完美世界竞技平台",
        True,
    ) is False
    assert ingestion.resolve_player_keyboard_input_flag("pvp_final.dem", None, None) is False
    assert ingestion.resolve_player_keyboard_input_flag("g161-match.dem", "5E", True) is True
    assert ingestion.server_name_from_match_meta(
        {"match_meta": {"server_name": " 完美世界 "}},
    ) == "完美世界"


def test_enqueue_perfect_world_filename_marks_keyboard_missing(tmp_path: Path, monkeypatch):
    demo_path = tmp_path / "pvp_match.dem"
    demo_path.write_bytes(b"demo")
    fake_db = SimpleNamespace(
        ingest_md5_supported=True,
        content_md5_exists=AsyncMock(return_value=False),
        add_demo=AsyncMock(return_value=(1, True)),
        update_demo_content_md5_if_absent=AsyncMock(),
        update_status=AsyncMock(),
        mark_player_keyboard_input_missing=AsyncMock(),
    )
    notify = AsyncMock()

    monkeypatch.setattr(ingestion, "demo_db", fake_db)
    monkeypatch.setattr(ingestion, "_demo_ingest_md5_enabled", lambda: False)
    monkeypatch.setattr(ingestion, "demo_library_hub", SimpleNamespace(notify=notify))
    monkeypatch.setattr(ingestion.application_state, "demo_watcher", None)
    monkeypatch.setattr(ingestion, "_enqueue_striped_locks", [])

    asyncio.run(ingestion.enqueue_demo_path(demo_path))

    fake_db.mark_player_keyboard_input_missing.assert_awaited_once_with(str(demo_path.resolve()))
    notify.assert_awaited_once_with("enqueue")
