import io
import json
import zipfile

import pytest
from fastapi import HTTPException, UploadFile

from app.lite_cut import api, portable_api
from app.lite_cut.api import _resolve_lite_cut_encoder


def test_lite_cut_export_uses_project_encoder():
    body = {"output": {"encoder": "h264_nvenc"}}
    assert _resolve_lite_cut_encoder(body, "libx264") == "h264_nvenc"


def test_lite_cut_export_falls_back_to_valid_configured_encoder():
    assert _resolve_lite_cut_encoder({"output": {}}, "h264_qsv") == "h264_qsv"
    assert _resolve_lite_cut_encoder({"output": {"encoder": "bad"}}, "bad") == "auto"


def test_portable_package_excludes_demo_paths_from_project_metadata(monkeypatch, tmp_path):
    clip = tmp_path / "clip.mp4"
    demo = tmp_path / "match.dem"
    clip.write_bytes(b"video")
    demo.write_bytes(b"demo")
    monkeypatch.setattr(portable_api, "get_data_dir", lambda: tmp_path)

    package = portable_api._portable_package_path(
        {
            "name": "demo-safe",
            "body": {
                "tracks": [{"clips": [{"file_path": str(clip)}]}],
                "source_demo_path": str(demo),
                "metadata": {"original_demo": str(demo)},
            },
        },
        [{"id": 7, "name": clip.name, "kind": "video", "file_path": str(clip)}],
    )

    with zipfile.ZipFile(package) as archive:
        manifest = json.loads(archive.read("project.json"))
        packaged_names = archive.namelist()

    assert len(manifest["files"]) == 1
    assert manifest["files"][0]["original_path"] == str(clip.resolve())
    assert all(not name.endswith(".dem") for name in packaged_names)


def test_portable_import_links_bundled_recordings_and_file_clips():
    bundled = "C:/LiteCut/recording.mp4"
    body = {
        "tracks": [{
            "clips": [
                {"source_type": "recorded_clip", "source_id": 80, "meta": {"output_path": bundled}},
                {"source_type": "file", "file_path": bundled, "meta": {"output_path": bundled}},
            ],
        }],
    }

    linked = portable_api._link_portable_clip_assets(body, {bundled: 412})
    recorded, file_clip = body["tracks"][0]["clips"]

    assert linked == 2
    assert recorded["source_type"] == "file"
    assert recorded["source_id"] is None
    assert recorded["file_path"] == bundled
    assert recorded["meta"]["asset_id"] == 412
    assert file_clip["meta"]["asset_id"] == 412


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

    monkeypatch.setattr(portable_api, "get_lite_cut_db", lambda: db)
    monkeypatch.setattr(portable_api, "get_data_dir", lambda: tmp_path)
    monkeypatch.setattr(portable_api, "_delete_project_asset_files", no_asset_records)
    monkeypatch.setattr(
        "app.lite_cut.assets.stable_project_asset_directory",
        lambda *_args, **_kwargs: destination,
    )

    upload = UploadFile(filename="broken.zip", file=io.BytesIO(payload.getvalue()))
    with pytest.raises(HTTPException) as exc_info:
        await portable_api.import_lite_cut_portable_package(upload)

    assert exc_info.value.status_code == 400
    assert db.deleted == [42]
    assert not destination.exists()
