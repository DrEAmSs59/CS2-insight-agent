from pathlib import Path

import pytest
from fastapi import HTTPException

from app import main


def test_resolve_demo_upload_path_accepts_file_inside_upload_dir(tmp_path, monkeypatch):
    demo = tmp_path / "match.dem"
    demo.write_bytes(b"demo")
    monkeypatch.setattr(main, "UPLOAD_DIR", tmp_path)

    assert main.resolve_demo_upload_path("match.dem") == demo.resolve()


@pytest.mark.parametrize("filename", ["../outside.dem", "nested/../../outside.dem"])
def test_resolve_demo_upload_path_rejects_parent_traversal(tmp_path, monkeypatch, filename):
    outside = tmp_path.parent / "outside.dem"
    outside.write_bytes(b"demo")
    monkeypatch.setattr(main, "UPLOAD_DIR", tmp_path)

    with pytest.raises(HTTPException) as exc_info:
        main.resolve_demo_upload_path(filename)

    assert exc_info.value.status_code == 400


def test_resolve_demo_upload_path_rejects_absolute_path(tmp_path, monkeypatch):
    outside = tmp_path.parent / "outside.dem"
    outside.write_bytes(b"demo")
    monkeypatch.setattr(main, "UPLOAD_DIR", tmp_path)

    with pytest.raises(HTTPException) as exc_info:
        main.resolve_demo_upload_path(str(Path(outside).resolve()))

    assert exc_info.value.status_code == 400
