"""LiteCut asset upload tests."""

import asyncio
import io
import threading
from types import SimpleNamespace

import pytest
from fastapi import HTTPException, UploadFile

from app.lite_cut.assets import (
    _unlink_with_retry,
    _run_proxy_process,
    alpha_preview_proxy_command,
    alpha_preview_proxy_path_for_asset,
    asset_kind_for_path,
    asset_needs_browser_proxy,
    asset_stream_path,
    delete_asset_file_bundle,
    preview_proxy_command,
    preview_proxy_path_for_asset,
    project_asset_directory_name,
    relocate_asset_file_bundle,
    save_uploaded_asset,
    stable_project_asset_directory,
    validate_stored_asset_path,
)
from app.lite_cut.models import empty_project


def test_asset_metadata_reports_resolution_fps_codec_and_duration(tmp_path, monkeypatch):
    from app.lite_cut import api as api_mod
    from app import video_composer
    from app import env_utils

    source = tmp_path / "debug3.mp4"
    source.write_bytes(b"video")

    class FakeDb:
        async def get_asset(self, asset_id):
            assert asset_id == 7
            return {
                "id": 7,
                "name": source.name,
                "kind": "video",
                "mime_type": "video/mp4",
                "file_path": str(source),
                "duration_sec": 24.18,
                "width": 1920,
                "height": 1080,
            }

    monkeypatch.setattr(api_mod, "_get_lite_cut_db", lambda: FakeDb())
    monkeypatch.setattr("app.lite_cut.assets.validate_stored_asset_path", lambda _path: source)
    monkeypatch.setattr(env_utils, "load_config", lambda: SimpleNamespace(ffmpeg_path=None))
    monkeypatch.setattr(video_composer, "resolve_ffmpeg_binary", lambda _path: tmp_path / "ffmpeg.exe")
    monkeypatch.setattr(video_composer, "resolve_ffprobe_binary", lambda _path: tmp_path / "ffprobe.exe")
    monkeypatch.setattr(video_composer, "probe_video_audio_summary", lambda _path, _ffprobe: {
        "width": 1920,
        "height": 1080,
        "fps": 59.94,
        "duration": 24.18,
        "codec_name": "h264",
        "has_audio": True,
    })

    result = asyncio.run(api_mod.get_lite_cut_asset_metadata(7))

    assert result["width"] == 1920
    assert result["height"] == 1080
    assert result["fps"] == 59.94
    assert result["codec_name"] == "h264"
    assert result["duration_sec"] == 24.18
    assert result["extension"] == "MP4"


def test_save_uploaded_png(tmp_path, monkeypatch):
    from app.lite_cut import assets as assets_mod

    monkeypatch.setattr(assets_mod, "lite_cut_assets_dir", lambda: tmp_path)

    async def _run():
        upload = UploadFile(filename="sticker.png", file=io.BytesIO(b"\x89PNG\r\n\x1a\n"))
        return await save_uploaded_asset(upload)

    path, kind, _mime = asyncio.run(_run())
    assert path.is_file()
    assert kind == "image"
    assert asset_kind_for_path(path) == "image"


def test_save_uploaded_mp3(tmp_path, monkeypatch):
    from app.lite_cut import assets as assets_mod

    monkeypatch.setattr(assets_mod, "lite_cut_assets_dir", lambda: tmp_path)

    async def _run():
        upload = UploadFile(filename="bgm.mp3", file=io.BytesIO(b"ID3"))
        return await save_uploaded_asset(upload)

    path, kind, _mime = asyncio.run(_run())
    assert path.is_file()
    assert kind == "audio"
    assert asset_kind_for_path(path) == "audio"


def test_project_upload_is_saved_inside_project_named_directory(tmp_path, monkeypatch):
    from app.lite_cut import assets as assets_mod

    monkeypatch.setattr(assets_mod, "lite_cut_assets_dir", lambda: tmp_path)

    async def _run():
        upload = UploadFile(filename="clip.mp4", file=io.BytesIO(b"video"))
        return await save_uploaded_asset(upload, project_name="未命名工程 (2)")

    path, kind, _mime = asyncio.run(_run())
    assert path.parent == tmp_path / "未命名工程 (2)"
    assert path.is_file()
    assert kind == "video"


def test_project_directory_name_replaces_windows_invalid_characters():
    assert project_asset_directory_name('Dust2: A/B?') == "Dust2_ A_B_"
    assert project_asset_directory_name("CON") == "_CON"


def test_stable_project_directory_keeps_the_original_folder_after_rename(tmp_path, monkeypatch):
    from app.lite_cut import assets as assets_mod

    monkeypatch.setattr(assets_mod, "lite_cut_assets_dir", lambda: tmp_path)
    original = stable_project_asset_directory(24, "First name")
    renamed = stable_project_asset_directory(24, "Renamed project")
    legacy_file = tmp_path / "Legacy project" / "clip.mp4"
    legacy_file.parent.mkdir()
    legacy_file.write_bytes(b"video")

    assert original == renamed
    assert original.name == "24_First name"
    assert stable_project_asset_directory(25, "Renamed legacy", [str(legacy_file)]) == legacy_file.parent


def test_save_uploaded_gif_is_seekable_video_media(tmp_path, monkeypatch):
    from app.lite_cut import assets as assets_mod

    monkeypatch.setattr(assets_mod, "lite_cut_assets_dir", lambda: tmp_path)

    async def _run():
        upload = UploadFile(filename="animated.gif", file=io.BytesIO(b"GIF89a"))
        return await save_uploaded_asset(upload)

    path, kind, _mime = asyncio.run(_run())
    assert path.is_file()
    assert kind == "video"
    assert asset_kind_for_path(path) == "video"


@pytest.mark.parametrize("filename", ["match.mkv", "capture.m4v", "legacy.avi"])
def test_save_uploaded_container_video(tmp_path, monkeypatch, filename):
    from app.lite_cut import assets as assets_mod

    monkeypatch.setattr(assets_mod, "lite_cut_assets_dir", lambda: tmp_path)

    async def _run():
        upload = UploadFile(filename=filename, file=io.BytesIO(b"video-container"))
        return await save_uploaded_asset(upload)

    path, kind, _mime = asyncio.run(_run())
    assert path.is_file()
    assert kind == "video"
    assert asset_kind_for_path(path) == "video"


def test_save_uploaded_audio_webm_is_audio_asset(tmp_path, monkeypatch):
    from app.lite_cut import assets as assets_mod

    monkeypatch.setattr(assets_mod, "lite_cut_assets_dir", lambda: tmp_path)

    async def _run():
        upload = UploadFile(
            filename="voiceover.webm",
            file=io.BytesIO(b"webm-audio"),
            headers={"content-type": "audio/webm"},
        )
        return await save_uploaded_asset(upload)

    _path, kind, mime = asyncio.run(_run())
    assert kind == "audio"
    assert mime == "audio/webm"


def test_reject_unsupported_ext(tmp_path, monkeypatch):
    from app.lite_cut import assets as assets_mod

    monkeypatch.setattr(assets_mod, "lite_cut_assets_dir", lambda: tmp_path)

    async def _run():
        upload = UploadFile(filename="bad.exe", file=io.BytesIO(b"MZ"))
        return await save_uploaded_asset(upload)

    with pytest.raises(HTTPException):
        asyncio.run(_run())


def test_rejects_oversized_upload_without_leaving_a_partial_file(tmp_path, monkeypatch):
    from app.lite_cut import assets as assets_mod

    monkeypatch.setattr(assets_mod, "lite_cut_assets_dir", lambda: tmp_path)
    monkeypatch.setattr(assets_mod, "_ASSET_MAX_BYTES", 4)

    async def _run():
        upload = UploadFile(filename="large.mp4", file=io.BytesIO(b"12345"))
        return await save_uploaded_asset(upload)

    with pytest.raises(HTTPException) as exc:
        asyncio.run(_run())
    assert exc.value.status_code == 400
    assert list(tmp_path.iterdir()) == []


def test_validate_stored_asset_path_rejects_sibling_prefix(tmp_path, monkeypatch):
    from app.lite_cut import assets as assets_mod

    root = tmp_path / "lite_cut_assets"
    root.mkdir()
    sibling = tmp_path / "lite_cut_assets_old"
    sibling.mkdir()
    inside = root / "ok.png"
    outside = sibling / "bad.png"
    inside.write_bytes(b"ok")
    outside.write_bytes(b"bad")
    monkeypatch.setattr(assets_mod, "lite_cut_assets_dir", lambda: root)

    assert validate_stored_asset_path(str(inside)) == inside.resolve()
    with pytest.raises(HTTPException) as exc:
        validate_stored_asset_path(str(outside))
    assert exc.value.status_code == 403


def test_browser_proxy_replaces_only_stream_source(tmp_path):
    source = tmp_path / "match.mkv"
    source.write_bytes(b"source")
    proxy = preview_proxy_path_for_asset(source)
    assert asset_stream_path(source) == source
    proxy.write_bytes(b"proxy")
    assert asset_stream_path(source) == proxy


def test_relocate_and_delete_asset_bundle_includes_preview_proxies(tmp_path, monkeypatch):
    from app.lite_cut import assets as assets_mod

    monkeypatch.setattr(assets_mod, "lite_cut_assets_dir", lambda: tmp_path)
    source = tmp_path / "clip.mov"
    source.write_bytes(b"source")
    preview_proxy_path_for_asset(source).write_bytes(b"preview")
    alpha_preview_proxy_path_for_asset(source).write_bytes(b"alpha")

    moved = relocate_asset_file_bundle(source, "Project A")

    assert moved.parent == tmp_path / "Project A"
    assert moved.is_file()
    assert preview_proxy_path_for_asset(moved).is_file()
    assert alpha_preview_proxy_path_for_asset(moved).is_file()
    assert not source.exists()

    delete_asset_file_bundle(moved)
    assert not moved.exists()
    assert not preview_proxy_path_for_asset(moved).exists()
    assert not alpha_preview_proxy_path_for_asset(moved).exists()
    assert not moved.parent.exists()


def test_unlink_retries_temporary_windows_file_lock(monkeypatch):
    class TemporarilyLockedPath:
        def __init__(self):
            self.calls = 0

        def unlink(self, *, missing_ok):
            assert missing_ok is True
            self.calls += 1
            if self.calls < 3:
                raise PermissionError("file is in use")

    locked_path = TemporarilyLockedPath()
    monkeypatch.setattr("app.lite_cut.assets.time.sleep", lambda _delay: None)

    _unlink_with_retry(locked_path, attempts=3)

    assert locked_path.calls == 3


def test_proxy_process_can_be_cancelled_before_ffmpeg_starts():
    cancelled = threading.Event()
    cancelled.set()

    result = _run_proxy_process(["ffmpeg-does-not-need-to-exist"], cancel_event=cancelled)

    assert result.returncode == 130
    assert result.stderr == "cancelled"


def test_preview_proxy_state_moves_from_queue_to_ready_in_background(tmp_path, monkeypatch):
    from app.lite_cut import api as api_mod

    source = tmp_path / "large.mov"
    source.write_bytes(b"source")
    proxy = preview_proxy_path_for_asset(source)
    row = {"id": 991, "name": source.name, "kind": "video", "file_path": str(source), "duration_sec": 10.0}

    def fake_create(job, _row):
        proxy.write_bytes(b"proxy")
        return proxy, False

    monkeypatch.setattr(api_mod, "_create_preview_proxy_sync", fake_create)
    api_mod._preview_proxy_jobs.pop(991, None)

    async def _run():
        queued = api_mod._decorate_asset_preview_state(dict(row), has_alpha=False)
        assert queued["preview_proxy_status"] in {"queued", "running"}
        await api_mod._preview_proxy_jobs[991].task
        ready = api_mod._decorate_asset_preview_state(dict(row), schedule=False)
        assert ready["preview_proxy_status"] == "ready"
        assert ready["preview_proxy_required"] is True

    asyncio.run(_run())
    api_mod._preview_proxy_jobs.pop(991, None)


def test_preview_proxy_command_keeps_original_video_and_optional_audio(tmp_path):
    source = tmp_path / "match.avi"
    output = preview_proxy_path_for_asset(source)
    command = preview_proxy_command(
        ffmpeg_bin=tmp_path / "ffmpeg.exe",
        source=source,
        output=output,
        video_encode_quality=["-c:v", "libx264", "-crf", "20"],
    )
    assert command[command.index("-i") + 1] == str(source)
    assert ["-map", "0:v:0", "-map", "0:a?"] == command[command.index("-map") : command.index("-map") + 4]
    assert "fps=" not in command[command.index("-vf") + 1]
    assert command[command.index("-fpsmax") + 1] == "60"
    assert command[command.index("-g") + 1] == "30"
    assert command[command.index("-force_key_frames") + 1] == "expr:gte(t,n_forced*0.5)"
    assert command[-1] == str(output)


def test_large_mp4_uses_preview_proxy(tmp_path):
    small = tmp_path / "small.mp4"
    large = tmp_path / "large.mp4"
    small.write_bytes(b"video")
    with large.open("wb") as output:
        output.truncate(256 * 1024 * 1024)
    assert asset_needs_browser_proxy(small) is False
    assert asset_needs_browser_proxy(large) is True


def test_mov_always_uses_an_audio_compatible_browser_proxy(tmp_path):
    source = tmp_path / "clip.mov"
    source.write_bytes(b"video")
    assert asset_needs_browser_proxy(source) is True


def test_alpha_preview_proxy_command_preserves_alpha_channel(tmp_path):
    source = tmp_path / "lower-third.mov"
    output = alpha_preview_proxy_path_for_asset(source)
    command = alpha_preview_proxy_command(
        ffmpeg_bin=tmp_path / "ffmpeg.exe",
        source=source,
        output=output,
        duration_sec=12.5,
    )

    assert output.name == "lower-third.preview-alpha-v3.webm"
    assert "libvpx-vp9" in command
    assert "yuva420p" in command
    assert "alpha_mode=1" in command
    assert "-an" not in command
    assert command[command.index("-map") + 1] == "0:v:0"
    assert "0:a:0?" in command
    assert "libopus" in command
    assert "128k" in command
    assert "-fpsmax" in command
    assert "30" in command
    assert any("min(1280,iw)" in value for value in command)


def test_gif_preview_proxy_is_limited_to_one_animation_cycle(tmp_path):
    source = tmp_path / "sticker.gif"
    output = preview_proxy_path_for_asset(source)
    command = preview_proxy_command(
        ffmpeg_bin=tmp_path / "ffmpeg.exe",
        source=source,
        output=output,
        video_encode_quality=["-c:v", "libx264"],
        duration_sec=1.25,
    )
    assert command[command.index("-t") + 1] == "1.250000"


@pytest.mark.anyio
async def test_asset_validation_lists_missing_uploaded_and_recorded_sources(monkeypatch, tmp_path):
    from app.lite_cut import api as api_mod

    class FakeMontageDB:
        async def get_recorded_clips_by_ids(self, ids):
            assert ids == [42]
            return {42: {"output_path": str(tmp_path / "missing-recording.mp4")}}

    monkeypatch.setattr(api_mod, "_get_montage_db", lambda: FakeMontageDB())
    body = empty_project().model_dump(mode="json")
    body["tracks"][0]["clips"] = [{"id": "rec", "source_id": 42, "source_type": "recorded_clip"}]
    body["tracks"][1]["clips"] = [
        {
            "id": "music",
            "source_type": "file",
            "file_path": str(tmp_path / "missing-track.mp3"),
            "meta": {"kind": "audio"},
        }
    ]

    result = await api_mod.validate_lite_cut_assets(api_mod.LiteCutAssetValidationBody(body=body))

    assert result["items"] == [
        {"kind": "audio", "name": "missing-track.mp3", "path": str(tmp_path / "missing-track.mp3")},
        {"kind": "recording", "name": "missing-recording.mp4", "path": str(tmp_path / "missing-recording.mp4"), "source_id": 42},
    ]
