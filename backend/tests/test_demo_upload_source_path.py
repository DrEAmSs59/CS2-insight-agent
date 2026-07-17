import asyncio
import hashlib
import io
import json
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from app import main


def test_decode_upload_source_paths_fails_closed():
    assert main._decode_upload_source_paths(None, 2) == [None, None]
    assert main._decode_upload_source_paths("not-json", 1) == [None]
    assert main._decode_upload_source_paths(json.dumps(["one.dem"]), 2) == [None, None]


def test_verified_upload_source_path_requires_identical_content(tmp_path: Path):
    uploaded = tmp_path / "cache.dem"
    uploaded.write_bytes(b"uploaded-demo")
    expected_md5 = hashlib.md5(uploaded.read_bytes()).hexdigest()

    original = tmp_path / "original.dem"
    original.write_bytes(uploaded.read_bytes())
    mismatch = tmp_path / "mismatch.dem"
    mismatch.write_bytes(b"different-demo")

    assert main._verified_upload_source_path(str(original), uploaded, expected_md5) == original
    assert main._verified_upload_source_path(str(mismatch), uploaded, expected_md5) == uploaded


def test_multiple_upload_returns_verified_original_path(monkeypatch, tmp_path: Path):
    upload_dir = tmp_path / "uploads"
    upload_dir.mkdir()
    original_dir = tmp_path / "originals"
    original_dir.mkdir()
    original = original_dir / "match.dem"
    original.write_bytes(b"same-demo-content")
    upload = main.UploadFile(filename="match.dem", file=io.BytesIO(original.read_bytes()))

    async def fake_meta(_path: Path):
        return [{"name": "player"}], {"map_name": "de_mirage"}

    monkeypatch.setattr(main, "UPLOAD_DIR", upload_dir)
    monkeypatch.setattr(main, "_safe_upload_demo_meta", fake_meta)

    response = asyncio.run(main.upload_demos([upload], json.dumps([str(original)])))

    item = response["uploads"][0]
    assert item["path"] == str(original.resolve())
    assert item["uploaded_path"] == str(upload_dir / "match.dem")
    assert Path(item["uploaded_path"]).read_bytes() == original.read_bytes()


def test_multiple_upload_without_electron_path_uses_cache(monkeypatch, tmp_path: Path):
    upload = main.UploadFile(filename="browser.dem", file=io.BytesIO(b"browser-demo"))

    async def fake_meta(_path: Path):
        return [], {}

    monkeypatch.setattr(main, "UPLOAD_DIR", tmp_path)
    monkeypatch.setattr(main, "_safe_upload_demo_meta", fake_meta)

    response = asyncio.run(main.upload_demos([upload], json.dumps([""])))

    item = response["uploads"][0]
    assert item["path"] == str(tmp_path / "browser.dem")
    assert item["uploaded_path"] == item["path"]
