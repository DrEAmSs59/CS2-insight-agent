from __future__ import annotations

import asyncio
from pathlib import Path
from types import SimpleNamespace

import pytest

from app.features.lite_cut import api
from app.features.lite_cut.api import _resolve_lite_cut_encoder
from app.features.lite_cut.db import LiteCutDB
from app.features.lite_cut.dependencies import build_lite_cut_services
from app.features.lite_cut.models import SCHEMA_VERSION, empty_project
from app.features.lite_cut.project_file import (
    PROJECT_FILE_FORMAT,
    PROJECT_FILE_VERSION,
    LiteCutProjectFileError,
    build_linked_project_document,
    decode_linked_project_document,
    encode_linked_project_document,
    import_linked_project_document,
)


def test_lite_cut_router_exposes_linked_project_files_without_portable_package_routes():
    paths = {getattr(route, "path", "") for route in api.router.routes}

    assert "/api/lite-cut/assets/link" in paths
    assert "/api/lite-cut/assets/link-recording" in paths
    assert "/api/lite-cut/assets/generated" in paths
    assert "/api/lite-cut/projects/{project_id}/project-file/export" in paths
    assert "/api/lite-cut/projects/{project_id}/project-file" in paths
    assert "/api/lite-cut/projects/project-file/import" in paths
    assert "/api/lite-cut/proxy-cache" in paths
    assert "/api/lite-cut/proxy-cache/settings" in paths
    assert "/api/lite-cut/proxy-cache/regenerate" in paths
    assert "/api/lite-cut/proxy-cache/cleanup" in paths
    assert not any("portable-package" in path for path in paths)
    assert not any("portable/jobs" in path for path in paths)


def test_lite_cut_export_uses_project_encoder():
    body = {"output": {"encoder": "h264_nvenc"}}
    assert _resolve_lite_cut_encoder(body, "libx264") == "h264_nvenc"


def test_lite_cut_export_falls_back_to_valid_configured_encoder():
    assert _resolve_lite_cut_encoder({"output": {}}, "h264_qsv") == "h264_qsv"
    assert _resolve_lite_cut_encoder({"output": {"encoder": "bad"}}, "bad") == "auto"


def test_linked_project_file_converts_recording_video_and_audio_to_one_asset(tmp_path):
    source = tmp_path / "insight-recording.mp4"
    source.write_bytes(b"same-media-content")
    body = empty_project().model_dump(mode="json", by_alias=True)
    video_track = next(track for track in body["tracks"] if track["type"] == "video")
    audio_track = next(track for track in body["tracks"] if track["type"] == "audio")
    video_track["clips"] = [{
        "id": "video-1", "source_type": "recorded_clip", "source_id": 80,
        "file_path": str(source), "timeline_start": 0, "duration": 3,
        "trim_in": 0, "trim_out": 0, "meta": {"kind": "video"},
    }]
    audio_track["clips"] = [{
        "id": "audio-1", "source_type": "file", "source_id": 80,
        "file_path": str(source), "timeline_start": 0, "duration": 3,
        "trim_in": 0, "trim_out": 0, "meta": {"kind": "audio", "linked_from_video": "video-1"},
    }]
    project = {"id": 7, "name": "Linked", "body": body}
    recordings = {80: {
        "id": 80, "output_path": str(source), "player_name": "ACE",
        "map_name": "de_mirage", "category": "highlight",
    }}

    document = build_linked_project_document(project, [], recordings)
    clips = [clip for track in document["body"]["tracks"] for clip in track.get("clips", [])]

    assert document["format"] == PROJECT_FILE_FORMAT
    assert document["format_version"] == PROJECT_FILE_VERSION
    assert len(document["assets"]) == 1
    assert document["assets"][0]["source"]["origin_type"] == "insight_recording"
    assert document["assets"][0]["origin_metadata"]["player_name"] == "ACE"
    assert {clip["meta"]["asset_uid"] for clip in clips} == {document["assets"][0]["asset_uid"]}
    assert all(clip["source_type"] == "file" and clip["source_id"] is None for clip in clips)
    assert b"same-media-content" not in encode_linked_project_document(document)


def test_linked_project_decoder_rejects_old_json_and_portable_formats():
    for payload in (
        b'{"format":"litecut-project","schema_version":3,"body":{}}',
        b'{"format":"litecut-portable-project","body":{},"files":[]}',
    ):
        with pytest.raises(LiteCutProjectFileError):
            decode_linked_project_document(payload)


def test_linked_project_import_opens_with_offline_assets(tmp_path):
    missing = tmp_path / "other-computer" / "clip.mp4"
    body = empty_project().model_dump(mode="json", by_alias=True)
    document = {
        "format": PROJECT_FILE_FORMAT,
        "format_version": PROJECT_FILE_VERSION,
        "project_schema_version": SCHEMA_VERSION,
        "name": "Offline import",
        "body": body,
        "assets": [{
            "asset_uid": "asset-fixture",
            "name": "clip.mp4",
            "kind": "video",
            "mime_type": "video/mp4",
            "source": {"origin_type": "insight_recording", "origin_ref": "42", "original_path": str(missing)},
            "identity": {"content_fingerprint": "lc-content-v1:abc", "size_bytes": 99, "source_mtime_ns": 1},
            "media": {"duration_sec": 3.0, "width": 1920, "height": 1080},
            "origin_metadata": {"player_name": "ACE", "map_name": "de_mirage"},
        }],
    }

    class Projects:
        def __init__(self):
            self.project = None

        async def create(self, *, name, body):
            self.project = {"id": 9, "name": name, "body": body}
            return 9

        async def update(self, project_id, *, name=None, body=None):
            assert project_id == 9
            if body is not None:
                self.project["body"] = body

        async def get(self, project_id):
            return self.project if project_id == 9 else None

        async def delete(self, project_id):
            self.project = None

    class Assets:
        def __init__(self):
            self.items = []

        async def create(self, **values):
            item = {"id": len(self.items) + 1, **values}
            self.items.append(item)
            return item

    services = SimpleNamespace(projects=Projects(), assets=Assets())
    result = asyncio.run(import_linked_project_document(document, services))

    assert result["id"] == 9
    assert result["offline_asset_count"] == 1
    assert services.assets.items[0]["source_status"] == "missing"
    assert services.assets.items[0]["origin_type"] == "insight_recording"
    assert services.assets.items[0]["origin_metadata"]["player_name"] == "ACE"


def test_linked_project_import_persists_asset_binding_in_real_database(tmp_path):
    missing = tmp_path / "missing" / "clip.mp4"
    body = empty_project().model_dump(mode="json", by_alias=True)
    video_track = next(track for track in body["tracks"] if track["type"] == "video")
    video_track["clips"] = [{
        "id": "clip-1", "source_type": "file", "source_id": None,
        "file_path": str(missing), "timeline_start": 0, "trim_in": 0, "trim_out": 3,
        "meta": {"kind": "video", "asset_uid": "asset-real-db"},
    }]
    document = {
        "format": PROJECT_FILE_FORMAT,
        "format_version": PROJECT_FILE_VERSION,
        "project_schema_version": SCHEMA_VERSION,
        "name": "Real DB import",
        "body": body,
        "assets": [{
            "asset_uid": "asset-real-db", "name": "clip.mp4", "kind": "video", "mime_type": "video/mp4",
            "source": {"origin_type": "local_file", "origin_ref": "", "original_path": str(missing)},
            "identity": {"content_fingerprint": "lc-content-v1:abc", "size_bytes": 99, "source_mtime_ns": 1},
            "media": {"duration_sec": 3.0, "width": 1920, "height": 1080},
            "origin_metadata": {},
        }],
    }

    async def scenario():
        db = LiteCutDB(tmp_path / "litecut.db")
        await db.init_tables()
        result = await import_linked_project_document(document, build_lite_cut_services(db))
        project = await db.get_project(int(result["id"]))
        assets = await db.list_project_assets(int(result["id"]))
        clip = next(track for track in project["body"]["tracks"] if track["type"] == "video")["clips"][0]
        return result, assets, clip

    result, assets, clip = asyncio.run(scenario())
    assert result["offline_asset_count"] == 1
    assert assets[0]["asset_uid"] == "asset-real-db"
    assert clip["meta"]["asset_id"] == assets[0]["id"]
    assert clip["file_path"] == str(missing)
