import io
import json
import zipfile

import pytest
from fastapi import HTTPException, UploadFile

from app.lite_cut import api
from app.lite_cut.api import _resolve_lite_cut_encoder


def test_lite_cut_export_uses_project_encoder():
    body = {"output": {"encoder": "h264_nvenc"}}
    assert _resolve_lite_cut_encoder(body, "libx264") == "h264_nvenc"


def test_lite_cut_export_falls_back_to_valid_configured_encoder():
    assert _resolve_lite_cut_encoder({"output": {}}, "h264_qsv") == "h264_qsv"
    assert _resolve_lite_cut_encoder({"output": {"encoder": "bad"}}, "bad") == "auto"


@pytest.mark.anyio
async def test_portable_import_rolls_back_project_and_directory_on_invalid_asset(monkeypatch, tmp_path):
    class FakeDb:
        def __init__(self):
            self.deleted: list[int] = []

        async def create_project(self, **_kwargs):
            return 42

        async def get_project(self, project_id):
            return {"id": project_id, "name": "Broken import", "body": {}}

        async def delete_project(self, project_id):
            self.deleted.append(project_id)
            return True

    payload = io.BytesIO()
    with zipfile.ZipFile(payload, "w") as archive:
        archive.writestr("assets/invalid.exe", b"not media")
        archive.writestr("project.json", json.dumps({
            "format": "litecut-portable-project",
            "body": {"tracks": []},
            "files": [{"archive_path": "assets/invalid.exe", "name": "invalid.exe"}],
        }))
    payload.seek(0)

    db = FakeDb()
    destination = tmp_path / "lite_cut_assets" / "42_Broken-import"
    destination.mkdir(parents=True)

    async def no_asset_records(_project_id):
        return None

    monkeypatch.setattr(api, "_get_lite_cut_db", lambda: db)
    monkeypatch.setattr(api, "get_data_dir", lambda: tmp_path)
    monkeypatch.setattr(api, "_delete_project_asset_files", no_asset_records)
    monkeypatch.setattr(
        "app.lite_cut.assets.stable_project_asset_directory",
        lambda *_args, **_kwargs: destination,
    )

    upload = UploadFile(filename="broken.zip", file=io.BytesIO(payload.getvalue()))
    with pytest.raises(HTTPException) as exc_info:
        await api.import_lite_cut_portable_package(upload)

    assert exc_info.value.status_code == 400
    assert db.deleted == [42]
    assert not destination.exists()
