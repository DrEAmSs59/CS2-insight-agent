import asyncio
import hashlib
import io
import json
import sys
import threading
from pathlib import Path
from types import SimpleNamespace

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from app.demo_playback_compat import PATCH_ID, PATCH_REVISION, PlaybackDemoReport
from app.features.demo_analysis import api as demo_analysis_api
from app.features.demo_analysis import uploads


def _compat_result(*, cached: bool = False):
    return SimpleNamespace(
        cached=cached,
        report=PlaybackDemoReport(
            schema_version=1,
            outcome="clean",
            patch_id=PATCH_ID,
            patch_revision=PATCH_REVISION,
            removed_messages=0,
            changed_frames=0,
            first_tick=None,
            last_tick=None,
            max_per_frame=0,
            remaining_selected_messages=0,
        ),
    )


def _stub_analysis_registration(monkeypatch, demo_id: int = 73):
    registered: list[Path] = []

    async def fake_register(path: Path) -> int:
        registered.append(Path(path))
        return demo_id

    monkeypatch.setattr(demo_analysis_api, "_ensure_analysis_demo_row", fake_register)
    return registered


def test_decode_upload_source_paths_fails_closed():
    assert uploads.decode_upload_source_paths(None, 2) == [None, None]
    assert uploads.decode_upload_source_paths("not-json", 1) == [None]
    assert uploads.decode_upload_source_paths(json.dumps(["one.dem"]), 2) == [None, None]


def test_verified_upload_source_path_requires_identical_content(tmp_path: Path):
    uploaded = tmp_path / "cache.dem"
    uploaded.write_bytes(b"uploaded-demo")
    expected_md5 = hashlib.md5(uploaded.read_bytes()).hexdigest()

    original = tmp_path / "original.dem"
    original.write_bytes(uploaded.read_bytes())
    mismatch = tmp_path / "mismatch.dem"
    mismatch.write_bytes(b"different-demo")

    assert uploads.verified_upload_source_path(str(original), uploaded, expected_md5) == original
    assert uploads.verified_upload_source_path(str(mismatch), uploaded, expected_md5) == uploaded


def test_multiple_upload_returns_verified_original_path(monkeypatch, tmp_path: Path):
    upload_dir = tmp_path / "uploads"
    upload_dir.mkdir()
    original_dir = tmp_path / "originals"
    original_dir.mkdir()
    original = original_dir / "match.dem"
    original.write_bytes(b"same-demo-content")
    upload = demo_analysis_api.UploadFile(filename="match.dem", file=io.BytesIO(original.read_bytes()))
    ensure_options: list[bool] = []

    async def fake_meta(_path: Path):
        return [{"name": "player"}], {"map_name": "de_mirage"}, None

    monkeypatch.setattr(demo_analysis_api, "UPLOAD_DIR", upload_dir)
    monkeypatch.setattr(demo_analysis_api, "safe_upload_demo_meta", fake_meta)
    def fake_ensure(_path, *, allow_truncated_packet_tail=False):
        ensure_options.append(allow_truncated_packet_tail)
        return _compat_result()

    monkeypatch.setattr(demo_analysis_api, "ensure_demo_compatible", fake_ensure)
    registered = _stub_analysis_registration(monkeypatch)

    response = asyncio.run(demo_analysis_api.upload_demos([upload], json.dumps([str(original)])))

    item = response["uploads"][0]
    assert item["id"] == 73
    assert item["path"] == str(original.resolve())
    assert item["uploaded_path"] == str(upload_dir / "match.dem")
    assert Path(item["uploaded_path"]).read_bytes() == original.read_bytes()
    assert registered == [original.resolve()]
    assert ensure_options == [True]


def test_multiple_upload_without_electron_path_uses_cache(monkeypatch, tmp_path: Path):
    upload = demo_analysis_api.UploadFile(filename="browser.dem", file=io.BytesIO(b"browser-demo"))
    ensure_options: list[bool] = []

    async def fake_meta(_path: Path):
        return [{"name": "player"}], {}, None

    monkeypatch.setattr(demo_analysis_api, "UPLOAD_DIR", tmp_path)
    monkeypatch.setattr(demo_analysis_api, "safe_upload_demo_meta", fake_meta)
    def fake_ensure(_path, *, allow_truncated_packet_tail=False):
        ensure_options.append(allow_truncated_packet_tail)
        return _compat_result()

    monkeypatch.setattr(demo_analysis_api, "ensure_demo_compatible", fake_ensure)
    _stub_analysis_registration(monkeypatch)

    response = asyncio.run(demo_analysis_api.upload_demos([upload], json.dumps([""])))

    item = response["uploads"][0]
    assert item["id"] == 73
    assert item["path"] == str(tmp_path / "browser.dem")
    assert item["uploaded_path"] == item["path"]
    assert ensure_options == [True]


def test_single_upload_rejects_non_dem_with_specific_error_code():
    upload = demo_analysis_api.UploadFile(filename="notes.txt", file=io.BytesIO(b"not-a-demo"))

    try:
        asyncio.run(demo_analysis_api.upload_demo(upload))
    except demo_analysis_api.HTTPException as exc:
        assert exc.status_code == 400
        assert exc.detail == {"code": "DEMO_INVALID_EXTENSION"}
    else:
        raise AssertionError("Expected invalid extension to be rejected")


def test_multiple_upload_skips_bad_demo_and_keeps_good_demo(monkeypatch, tmp_path: Path):
    bad = demo_analysis_api.UploadFile(filename="broken.dem", file=io.BytesIO(b"broken"))
    good = demo_analysis_api.UploadFile(filename="good.dem", file=io.BytesIO(b"good"))

    def fake_ensure(path, **_kwargs):
        if Path(path).name == "broken.dem":
            raise RuntimeError("parser implementation detail")
        return _compat_result()

    async def fake_meta(_path: Path):
        return [{"name": "player"}], {"map_name": "de_nuke"}, None

    monkeypatch.setattr(demo_analysis_api, "UPLOAD_DIR", tmp_path)
    monkeypatch.setattr(demo_analysis_api, "ensure_demo_compatible", fake_ensure)
    monkeypatch.setattr(demo_analysis_api, "safe_upload_demo_meta", fake_meta)
    _stub_analysis_registration(monkeypatch)

    response = asyncio.run(demo_analysis_api.upload_demos([bad, good], json.dumps(["", ""])))

    assert [item["filename"] for item in response["uploads"]] == ["good.dem"]
    assert response["failed"] == [{
        "filename": "broken.dem",
        "code": "DEMO_PREPARE_FAILED",
    }]


def test_save_uploaded_demo_overwrites_existing_via_partial(tmp_path: Path):
    dest = tmp_path / "existing.dem"
    dest.write_bytes(b"old-content-that-must-be-replaced")
    upload = demo_analysis_api.UploadFile(filename="existing.dem", file=io.BytesIO(b"new-demo-bytes"))

    digest = uploads.save_uploaded_demo(upload, dest)

    assert dest.read_bytes() == b"new-demo-bytes"
    assert digest == hashlib.md5(b"new-demo-bytes").hexdigest()
    assert not any(tmp_path.glob(".existing.dem.*.partial"))


def test_upload_demo_saves_file_off_the_event_loop_thread(monkeypatch, tmp_path: Path):
    upload = demo_analysis_api.UploadFile(filename="threaded.dem", file=io.BytesIO(b"demo"))
    caller_thread = threading.get_ident()
    save_threads: list[int] = []
    ensure_threads: list[int] = []

    def fake_save(file, destination: Path) -> str:
        save_threads.append(threading.get_ident())
        destination.write_bytes(file.file.read())
        return hashlib.md5(b"demo").hexdigest()

    async def fake_meta(_path: Path):
        return [{"name": "player"}], {}, None

    def fake_ensure(_path: Path, **_kwargs):
        ensure_threads.append(threading.get_ident())
        return _compat_result()

    monkeypatch.setattr(demo_analysis_api, "UPLOAD_DIR", tmp_path)
    monkeypatch.setattr(demo_analysis_api, "save_uploaded_demo", fake_save)
    monkeypatch.setattr(demo_analysis_api, "safe_upload_demo_meta", fake_meta)
    monkeypatch.setattr(demo_analysis_api, "ensure_demo_compatible", fake_ensure)
    _stub_analysis_registration(monkeypatch)

    response = asyncio.run(demo_analysis_api.upload_demo(upload))

    assert response["id"] == 73
    assert response["path"] == str(tmp_path / "threaded.dem")
    assert save_threads and save_threads[0] != caller_thread
    assert ensure_threads and ensure_threads[0] != caller_thread


def test_open_local_repairs_and_returns_the_real_source(monkeypatch, tmp_path: Path):
    original = tmp_path / "manual.dem"
    original.write_bytes(b"manual-demo")
    ensured: list[Path] = []
    inspected: list[Path] = []

    def fake_ensure(path):
        ensured.append(Path(path))
        return _compat_result(cached=False)

    async def fake_meta(path: Path):
        inspected.append(path)
        return [{"name": "player"}], {"map_name": "de_nuke"}, None

    monkeypatch.setattr(demo_analysis_api, "ensure_demo_compatible", fake_ensure)
    monkeypatch.setattr(demo_analysis_api, "safe_upload_demo_meta", fake_meta)
    registered = _stub_analysis_registration(monkeypatch)

    response = asyncio.run(demo_analysis_api.open_local_demos(demo_analysis_api.OpenLocalDemosBody(paths=[str(original)])))

    item = response["uploads"][0]
    assert item["id"] == 73
    assert item["path"] == str(original.resolve())
    assert item["uploaded_path"] is None
    assert item["compatibility"]["cached"] is False
    assert ensured == [original.resolve()]
    assert inspected == [original.resolve()]
    assert registered == [original.resolve()]


def test_open_local_reports_non_dem_as_invalid_extension(tmp_path: Path):
    invalid = tmp_path / "manual.zip"
    invalid.write_bytes(b"not-a-demo")

    response = asyncio.run(demo_analysis_api.open_local_demos(demo_analysis_api.OpenLocalDemosBody(paths=[str(invalid)])))

    assert response["uploads"] == []
    assert response["failed"] == [{
        "filename": "manual.zip",
        "code": "DEMO_INVALID_EXTENSION",
    }]


def test_analysis_demo_registration_creates_and_reuses_stable_id(monkeypatch, tmp_path: Path):
    demo = tmp_path / "analysis.dem"
    demo.write_bytes(b"analysis-demo")

    class FakeDemoDB:
        def __init__(self):
            self.row = None
            self.add_calls = []

        async def get_demo_by_path(self, path):
            return self.row

        async def add_demo(self, path, **kwargs):
            self.add_calls.append((path, kwargs))
            self.row = {"id": 91, "path": path}
            return 91, True

    fake_db = FakeDemoDB()
    notifications = []

    async def fake_notify(event):
        notifications.append(event)

    monkeypatch.setattr(demo_analysis_api, "demo_db", fake_db)
    monkeypatch.setattr(demo_analysis_api, "demo_library_hub", SimpleNamespace(notify=fake_notify))

    first = asyncio.run(demo_analysis_api._ensure_analysis_demo_row(demo))
    second = asyncio.run(demo_analysis_api._ensure_analysis_demo_row(demo))

    assert first == second == 91
    assert len(fake_db.add_calls) == 1
    assert fake_db.add_calls[0][0] == str(demo.resolve())
    assert fake_db.add_calls[0][1]["status"] == "pending"
    assert fake_db.add_calls[0][1]["file_size"] == len(b"analysis-demo")
    assert notifications == ["enqueue"]
