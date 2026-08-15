import asyncio
import sys
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import AsyncMock, Mock

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from app.features.demo_library import ingestion


def _fake_db(*, inserted: bool = True):
    return SimpleNamespace(
        ingest_md5_supported=True,
        content_md5_exists=AsyncMock(return_value=False),
        add_demo=AsyncMock(return_value=(1, inserted)),
        update_demo_content_md5_if_absent=AsyncMock(),
        update_status=AsyncMock(),
    )


def test_enqueue_with_md5_disabled_never_hashes_or_rewrites_pending_row(tmp_path: Path, monkeypatch):
    demo_path = tmp_path / "match.dem"
    demo_path.write_bytes(b"demo")
    fake_db = _fake_db()
    hash_mock = Mock(side_effect=AssertionError("MD5 must stay disabled"))
    notify = AsyncMock()

    monkeypatch.setattr(ingestion, "demo_db", fake_db)
    monkeypatch.setattr(ingestion, "_demo_ingest_md5_enabled", lambda: False)
    monkeypatch.setattr(ingestion, "file_md5_hex", hash_mock)
    monkeypatch.setattr(ingestion, "demo_library_hub", SimpleNamespace(notify=notify))
    monkeypatch.setattr(ingestion.application_state, "demo_watcher", None)
    monkeypatch.setattr(ingestion, "_enqueue_striped_locks", [])

    asyncio.run(ingestion.enqueue_demo_path(demo_path))

    hash_mock.assert_not_called()
    assert fake_db.add_demo.await_args.kwargs["content_md5"] is None
    fake_db.update_status.assert_not_awaited()
    fake_db.update_demo_content_md5_if_absent.assert_not_awaited()
    notify.assert_awaited_once_with("enqueue")


def test_existing_row_reuses_the_single_computed_md5(tmp_path: Path, monkeypatch):
    demo_path = tmp_path / "match.dem"
    demo_path.write_bytes(b"demo")
    fake_db = _fake_db(inserted=False)
    hash_mock = Mock(return_value="abc123")

    monkeypatch.setattr(ingestion, "demo_db", fake_db)
    monkeypatch.setattr(ingestion, "_demo_ingest_md5_enabled", lambda: True)
    monkeypatch.setattr(ingestion, "file_md5_hex", hash_mock)
    monkeypatch.setattr(ingestion.application_state, "demo_watcher", None)
    monkeypatch.setattr(ingestion, "_enqueue_striped_locks", [])

    asyncio.run(ingestion.enqueue_demo_path(demo_path, "archive.zip"))

    hash_mock.assert_called_once_with(demo_path)
    fake_db.update_demo_content_md5_if_absent.assert_awaited_once_with(
        str(demo_path.resolve()),
        "abc123",
        "archive.zip",
    )
    fake_db.update_status.assert_not_awaited()
