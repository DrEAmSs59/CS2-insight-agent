"""LiteCut asset upload tests."""

import asyncio
import io
from pathlib import Path
import subprocess
import threading
from types import SimpleNamespace

import pytest
from fastapi import HTTPException, UploadFile

from app.features.lite_cut.assets import (
    _unlink_with_retry,
    _run_proxy_process,
    alpha_preview_proxy_command,
    alpha_preview_proxy_path_for_asset,
    audio_preview_command,
    asset_exceeds_direct_preview_limits,
    asset_kind_for_path,
    asset_needs_browser_proxy,
    asset_stream_path,
    delete_asset_row_bundle,
    delete_asset_file_bundle,
    create_browser_preview_proxy,
    create_audio_preview_proxy,
    preview_proxy_command,
    preview_proxy_remux_command,
    preview_proxy_path_for_asset,
    project_asset_directory_name,
    relocate_asset_file_bundle,
    save_uploaded_asset,
    stable_project_asset_directory,
    validate_stored_asset_path,
)
from app.features.lite_cut.models import empty_project
from app.features.lite_cut.media_policy import (
    SEGMENT_PREVIEW_ALPHA_SCHEMA,
    alpha_preview_segment_command,
    asset_needs_segmented_preview,
    probe_webp_container,
    preview_segment_command,
    webp_is_animated,
)
from app.features.lite_cut.proxy_executor import (
    audio_preview_cache_path,
    proxy_cache_inventory,
    preview_segment_cache_directory,
    preview_segment_path,
)


def test_audio_preview_command_preserves_aac_timestamps_and_skips_video(tmp_path):
    source = tmp_path / "large.mp4"
    output = tmp_path / "preview-audio-v1.m4a"
    command = audio_preview_command(
        ffmpeg_bin=tmp_path / "ffmpeg.exe",
        source=source,
        output=output,
        copy_audio=True,
    )

    assert command[command.index("-map") + 1] == "0:a:0"
    assert "-vn" in command
    assert command[command.index("-c:a") + 1] == "copy"
    assert "-avoid_negative_ts" not in command
    assert command[-1] == str(output)


def test_audio_preview_cache_is_scoped_to_project_and_asset_identity(tmp_path, monkeypatch):
    from app.features.lite_cut import assets as assets_mod

    storage = tmp_path / "assets"
    project = storage / "4_Project"
    project.mkdir(parents=True)
    monkeypatch.setattr(assets_mod, "lite_cut_assets_dir", lambda: storage)

    path = audio_preview_cache_path(
        {"id": 10, "fingerprint": "lc-content-v1:fa37838"},
        project,
    )

    assert path == project / ".preview" / "asset-10-lc-content-v1fa37838" / "preview-audio-v1.m4a"


def test_audio_preview_is_valid_cache_even_when_video_does_not_need_segments(tmp_path, monkeypatch):
    from app.features.lite_cut import assets as assets_mod

    storage = tmp_path / "assets"
    audio = storage / "4_Project" / ".preview" / "asset-10-fingerprint" / "preview-audio-v1.m4a"
    audio.parent.mkdir(parents=True)
    audio.write_bytes(b"audio proxy")
    monkeypatch.setattr(assets_mod, "lite_cut_assets_dir", lambda: storage)

    inventory = proxy_cache_inventory([{
        "id": 10,
        "kind": "video",
        "fingerprint": "fingerprint",
        "storage_mode": "link",
        "size_bytes": 1024,
        "codec_name": "h264",
        "duration_sec": 10,
        "fps": 30,
        "file_path": str(tmp_path / "small.mp4"),
    }])

    assert inventory["proxy_files"] == 1
    assert inventory["orphan_files"] == 0


def test_audio_preview_copy_falls_back_to_aac_transcode(tmp_path, monkeypatch):
    from app.features.lite_cut import assets as assets_mod

    source = tmp_path / "large.mp4"
    source.write_bytes(b"source")
    output = tmp_path / "preview-audio-v1.m4a"
    modes = []

    def fake_run(command, **_kwargs):
        mode = command[command.index("-c:a") + 1]
        modes.append(mode)
        if mode == "copy":
            return subprocess.CompletedProcess(command, 1, "", "copy failed")
        Path(command[-1]).write_bytes(b"audio proxy")
        return subprocess.CompletedProcess(command, 0, "", "")

    monkeypatch.setattr(assets_mod, "_run_proxy_process", fake_run)
    result = create_audio_preview_proxy(
        source,
        ffmpeg_bin=tmp_path / "ffmpeg.exe",
        output_path=output,
        audio_codec="aac",
    )

    assert modes == ["copy", "aac"]
    assert result == output.resolve()
    assert output.read_bytes() == b"audio proxy"


def test_asset_metadata_reports_resolution_fps_codec_and_duration(tmp_path, monkeypatch):
    from app.features.lite_cut import assets_api as api_mod
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

    monkeypatch.setattr(api_mod, "get_lite_cut_db", lambda: FakeDb())
    monkeypatch.setattr("app.features.lite_cut.assets.validate_stored_asset_path", lambda _path: source)
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
    from app.features.lite_cut import assets as assets_mod

    monkeypatch.setattr(assets_mod, "lite_cut_assets_dir", lambda: tmp_path)

    async def _run():
        upload = UploadFile(filename="sticker.png", file=io.BytesIO(b"\x89PNG\r\n\x1a\n"))
        return await save_uploaded_asset(upload)

    path, kind, _mime = asyncio.run(_run())
    assert path.is_file()
    assert kind == "image"
    assert asset_kind_for_path(path) == "image"


def test_save_uploaded_mp3(tmp_path, monkeypatch):
    from app.features.lite_cut import assets as assets_mod

    monkeypatch.setattr(assets_mod, "lite_cut_assets_dir", lambda: tmp_path)

    async def _run():
        upload = UploadFile(filename="bgm.mp3", file=io.BytesIO(b"ID3"))
        return await save_uploaded_asset(upload)

    path, kind, _mime = asyncio.run(_run())
    assert path.is_file()
    assert kind == "audio"
    assert asset_kind_for_path(path) == "audio"


def test_project_upload_is_saved_inside_project_named_directory(tmp_path, monkeypatch):
    from app.features.lite_cut import assets as assets_mod

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
    from app.features.lite_cut import assets as assets_mod

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
    from app.features.lite_cut import assets as assets_mod

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
    from app.features.lite_cut import assets as assets_mod

    monkeypatch.setattr(assets_mod, "lite_cut_assets_dir", lambda: tmp_path)

    async def _run():
        upload = UploadFile(filename=filename, file=io.BytesIO(b"video-container"))
        return await save_uploaded_asset(upload)

    path, kind, _mime = asyncio.run(_run())
    assert path.is_file()
    assert kind == "video"
    assert asset_kind_for_path(path) == "video"


def test_save_uploaded_audio_webm_is_audio_asset(tmp_path, monkeypatch):
    from app.features.lite_cut import assets as assets_mod

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
    from app.features.lite_cut import assets as assets_mod

    monkeypatch.setattr(assets_mod, "lite_cut_assets_dir", lambda: tmp_path)

    async def _run():
        upload = UploadFile(filename="bad.exe", file=io.BytesIO(b"MZ"))
        return await save_uploaded_asset(upload)

    with pytest.raises(HTTPException):
        asyncio.run(_run())


@pytest.mark.anyio
async def test_generated_asset_endpoint_rejects_external_video_uploads():
    from app.features.lite_cut import assets_api as api_mod

    upload = UploadFile(
        filename="external.mp4",
        file=io.BytesIO(b"video"),
        headers={"content-type": "video/mp4"},
    )

    with pytest.raises(HTTPException) as caught:
        await api_mod.create_lite_cut_generated_asset(
            file=upload,
            project_id=None,
            client_duration_sec=None,
        )

    assert caught.value.status_code == 400


def test_link_asset_registers_without_copy_and_delete_preserves_source(tmp_path, monkeypatch):
    from app.features.lite_cut import assets as assets_mod
    from app.features.lite_cut import assets_api as api_mod
    from app.features.lite_cut.db import LiteCutDB

    storage = tmp_path / "managed-assets"
    source = tmp_path / "external" / "frame.png"
    source.parent.mkdir()
    source.write_bytes(b"\x89PNG\r\n\x1a\n" + b"\x00" * 8 + (64).to_bytes(4, "big") + (32).to_bytes(4, "big"))
    db = LiteCutDB(tmp_path / "lite-cut.db")
    monkeypatch.setattr(assets_mod, "lite_cut_assets_dir", lambda: storage)
    monkeypatch.setattr(api_mod, "get_lite_cut_db", lambda: db)

    async def _run():
        await db.init_tables()
        result = await api_mod.link_lite_cut_assets(api_mod.LiteCutAssetLinkBody(paths=[str(source)]))
        item = result["items"][0]
        row = await db.get_asset(int(item["id"]))

        assert item["storage_mode"] == "link"
        assert item["source_status"] == "available"
        assert item["source_available"] is True
        assert row["original_path"] == str(source.resolve())
        assert row["managed_path"] is None
        assert row["size_bytes"] == source.stat().st_size
        assert row["fingerprint"]
        assert list(storage.rglob("frame.png")) == []

        normal_proxy, alpha_proxy = assets_mod.asset_preview_paths(row)
        assert normal_proxy.is_relative_to(storage)
        assert alpha_proxy.is_relative_to(storage)
        assert normal_proxy.parent != source.parent
        normal_proxy.parent.mkdir(parents=True, exist_ok=True)
        normal_proxy.write_bytes(b"derived proxy")

        await api_mod.delete_lite_cut_asset(int(item["id"]))
        assert source.is_file()
        assert not normal_proxy.exists()
        assert await db.get_asset(int(item["id"])) is None

    asyncio.run(_run())


def test_link_asset_reports_missing_and_can_relink_in_place(tmp_path, monkeypatch):
    from app.features.lite_cut import assets as assets_mod
    from app.features.lite_cut import assets_api as api_mod
    from app.features.lite_cut.db import LiteCutDB

    storage = tmp_path / "managed-assets"
    first = tmp_path / "external" / "first.png"
    second = tmp_path / "external" / "second.png"
    wrong = tmp_path / "external" / "wrong.png"
    first.parent.mkdir()
    first.write_bytes(b"\x89PNG\r\n\x1a\n" + b"\x00" * 24)
    second.write_bytes(first.read_bytes())
    wrong.write_bytes(b"\x89PNG\r\n\x1a\n" + b"\x01" * 24)
    db = LiteCutDB(tmp_path / "lite-cut.db")
    monkeypatch.setattr(assets_mod, "lite_cut_assets_dir", lambda: storage)
    monkeypatch.setattr(api_mod, "get_lite_cut_db", lambda: db)

    async def _run():
        await db.init_tables()
        linked = await api_mod.link_lite_cut_assets(api_mod.LiteCutAssetLinkBody(paths=[str(first)]))
        asset_id = int(linked["items"][0]["id"])
        first.unlink()

        listed = await api_mod.list_lite_cut_assets(project_id=None, limit=500, offset=0)
        assert listed["items"][0]["source_status"] == "missing"
        assert listed["items"][0]["source_available"] is False

        with pytest.raises(HTTPException) as caught:
            await api_mod.relink_lite_cut_asset(
                asset_id,
                api_mod.LiteCutAssetRelinkBody(path=str(wrong)),
            )
        assert caught.value.status_code == 409
        assert caught.value.detail["code"] == "LITECUT_ASSET_IDENTITY_MISMATCH"

        relinked = await api_mod.relink_lite_cut_asset(
            asset_id,
            api_mod.LiteCutAssetRelinkBody(path=str(second)),
        )
        assert relinked["id"] == asset_id
        assert relinked["source_status"] == "available"
        assert relinked["file_path"] == str(second.resolve())
        assert (await db.get_asset(asset_id))["original_path"] == str(second.resolve())

        second.write_bytes(second.read_bytes() + b"changed")
        changed = await api_mod.list_lite_cut_assets(project_id=None, limit=500, offset=0)
        assert changed["items"][0]["source_status"] == "changed"
        assert changed["items"][0]["source_available"] is False

    asyncio.run(_run())


def test_rejects_oversized_upload_without_leaving_a_partial_file(tmp_path, monkeypatch):
    from app.features.lite_cut import assets as assets_mod

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
    from app.features.lite_cut import assets as assets_mod

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


def test_legacy_browser_proxy_never_replaces_stream_source(tmp_path):
    source = tmp_path / "match.mkv"
    source.write_bytes(b"source")
    proxy = preview_proxy_path_for_asset(source)
    assert asset_stream_path(source) == source
    proxy.write_bytes(b"proxy")
    assert asset_stream_path(source) == source


def test_relocate_and_delete_asset_bundle_includes_preview_proxies(tmp_path, monkeypatch):
    from app.features.lite_cut import assets as assets_mod

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
    monkeypatch.setattr("app.features.lite_cut.assets.time.sleep", lambda _delay: None)

    _unlink_with_retry(locked_path, attempts=3)

    assert locked_path.calls == 3


def test_proxy_process_can_be_cancelled_before_ffmpeg_starts():
    cancelled = threading.Event()
    cancelled.set()

    result = _run_proxy_process(["ffmpeg-does-not-need-to-exist"], cancel_event=cancelled)

    assert result.returncode == 130
    assert result.stderr == "cancelled"


def test_preview_state_selects_segmented_mode_without_eagerly_queuing_proxy(tmp_path):
    from app.features.lite_cut import proxy_api as api_mod
    from app.features.lite_cut.runtime import preview_proxy_jobs

    source = tmp_path / "large.mov"
    source.write_bytes(b"source")
    proxy = preview_proxy_path_for_asset(source)
    proxy.write_bytes(b"legacy proxy")
    row = {"id": 991, "name": source.name, "kind": "video", "file_path": str(source), "duration_sec": 10.0}

    preview_proxy_jobs.pop(991, None)
    state = api_mod._decorate_asset_preview_state(dict(row), has_alpha=False)

    assert state["preview_proxy_required"] is True
    assert state["preview_proxy_status"] == "idle"
    assert state["preview_proxy_mode"] == "segmented"
    assert state["preview_segment_step_sec"] == 4.0
    assert preview_proxy_jobs.get(991) is None


@pytest.mark.anyio
async def test_preview_stream_returns_original_source_even_if_legacy_proxy_exists(tmp_path, monkeypatch):
    from app.features.lite_cut import assets as assets_mod
    from app.features.lite_cut import assets_api as api_mod

    source = tmp_path / "large.mov"
    source.write_bytes(b"source")
    preview_proxy_path_for_asset(source).write_bytes(b"legacy proxy")

    class FakeDb:
        async def get_asset(self, asset_id):
            assert asset_id == 991
            return {"id": 991, "name": source.name, "kind": "video", "file_path": str(source)}

    monkeypatch.setattr(api_mod, "get_lite_cut_db", lambda: FakeDb())
    monkeypatch.setattr(assets_mod, "validate_stored_asset_path", lambda _path: source)

    response = await api_mod.stream_lite_cut_asset(991, SimpleNamespace())

    assert Path(response.path) == source


@pytest.mark.anyio
async def test_full_audio_preview_stream_uses_project_owned_cache(tmp_path, monkeypatch):
    from app import video_composer
    from app.features.lite_cut import assets as assets_mod
    from app.features.lite_cut import assets_api as api_mod

    source = tmp_path / "large.mp4"
    source.write_bytes(b"source")
    asset_cache = tmp_path / "4_Project" / ".preview" / "asset-10-fingerprint"
    segment_cache = asset_cache / "segments-v4-720p"
    expected_audio = asset_cache / "preview-audio-v1.m4a"

    class FakeDb:
        async def get_asset(self, asset_id):
            assert asset_id == 10
            return {
                "id": 10,
                "project_id": 4,
                "name": source.name,
                "kind": "video",
                "file_path": str(source),
                "original_path": str(source),
                "storage_mode": "link",
                "codec_name": "h264",
                "audio_codec_name": "aac",
                "has_alpha": False,
            }

    async def fake_context(_row):
        return segment_cache, 720

    def fake_create(source_path, *, output_path, audio_codec, **_kwargs):
        assert source_path == source.resolve()
        assert output_path == expected_audio
        assert audio_codec == "aac"
        output_path.parent.mkdir(parents=True, exist_ok=True)
        output_path.write_bytes(b"audio proxy")
        return output_path

    monkeypatch.setattr(api_mod, "get_lite_cut_db", lambda: FakeDb())
    monkeypatch.setattr(api_mod, "_segment_preview_context", fake_context)
    monkeypatch.setattr(video_composer, "resolve_ffmpeg_binary", lambda _path: tmp_path / "ffmpeg.exe")
    monkeypatch.setattr(assets_mod, "create_audio_preview_proxy", fake_create)

    response = await api_mod.stream_lite_cut_audio_preview(10, SimpleNamespace())

    assert Path(response.path) == expected_audio
    assert response.media_type == "audio/mp4"
    assert response.headers["accept-ranges"] == "bytes"


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


def test_segmented_preview_policy_covers_large_links_and_incompatible_containers(tmp_path):
    small_mp4 = tmp_path / "small.mp4"
    small_mp4.write_bytes(b"h264")
    mov = tmp_path / "camera.mov"
    mov.write_bytes(b"video")

    assert asset_needs_segmented_preview(
        small_mp4,
        kind="video",
        storage_mode="link",
        size_bytes=256 * 1024 * 1024,
        video_codec="h264",
        duration_sec=600,
        fps=60,
    ) is True
    assert asset_needs_segmented_preview(
        mov,
        kind="video",
        storage_mode="link",
        size_bytes=5,
        duration_sec=10,
    ) is True
    assert asset_needs_segmented_preview(
        small_mp4,
        kind="video",
        storage_mode="link",
        size_bytes=5,
        video_codec="h264",
        duration_sec=10,
        fps=60,
    ) is False


def test_animated_webp_container_is_routed_to_segmented_video_preview(tmp_path):
    source = tmp_path / "sticker.webp"
    vp8x = bytes([0x12, 0, 0, 0, 63, 0, 0, 31, 0, 0])
    anim = bytes(6)
    anmf = bytes(12) + (240).to_bytes(3, "little") + bytes(1)
    chunks = b"".join((
        b"VP8X" + len(vp8x).to_bytes(4, "little") + vp8x,
        b"ANIM" + len(anim).to_bytes(4, "little") + anim,
        b"ANMF" + len(anmf).to_bytes(4, "little") + anmf,
    ))
    source.write_bytes(b"RIFF" + (len(chunks) + 4).to_bytes(4, "little") + b"WEBP" + chunks)

    facts = probe_webp_container(source)

    assert facts == {
        "animated": True,
        "has_alpha": True,
        "duration_sec": 0.24,
        "width": 64,
        "height": 32,
    }
    assert webp_is_animated(source) is True
    assert asset_needs_segmented_preview(source, kind="video", size_bytes=source.stat().st_size) is True


def test_preview_segment_command_fast_seeks_and_outputs_independent_mp4(tmp_path):
    source = tmp_path / "match.mkv"
    output = tmp_path / "segment.mp4"
    command = preview_segment_command(
        ffmpeg_bin=tmp_path / "ffmpeg.exe",
        source=source,
        output=output,
        start_sec=36,
        duration_sec=4.5,
        video_encode_quality=["-c:v", "libx264", "-crf", "23"],
        max_edge=720,
    )

    assert command.index("-ss") < command.index("-i")
    assert command[command.index("-ss") + 1] == "36.000000"
    assert command[command.index("-t") + 1] == "4.500000"
    assert "min(720,iw)" in command[command.index("-vf") + 1]
    assert command[command.index("-c:a") + 1] == "aac"
    assert command[command.index("-movflags") + 1] == "+faststart"
    assert command[-1] == str(output)


def test_alpha_preview_segment_command_preserves_alpha_in_short_webm(tmp_path):
    source = tmp_path / "lower-third.mov"
    output = tmp_path / "segment.webm"
    command = alpha_preview_segment_command(
        ffmpeg_bin=tmp_path / "ffmpeg.exe",
        source=source,
        output=output,
        start_sec=8,
        duration_sec=4.5,
        max_edge=720,
    )

    assert command.index("-ss") < command.index("-i")
    assert command[command.index("-ss") + 1] == "8.000000"
    assert "libvpx-vp9" in command
    assert "yuva420p" in command
    assert "alpha_mode=1" in command
    assert command[command.index("-auto-alt-ref") + 1] == "0"
    assert command[command.index("-c:a") + 1] == "libopus"
    assert command[-1] == str(output)


def test_animated_webp_segment_uses_output_seek_for_ffmpeg_9_demuxer(tmp_path):
    source = tmp_path / "animated.webp"
    output = tmp_path / "segment.webm"
    command = alpha_preview_segment_command(
        ffmpeg_bin=tmp_path / "ffmpeg.exe",
        source=source,
        output=output,
        start_sec=4,
        duration_sec=1,
    )

    assert command.index("-i") < command.index("-ss")
    assert command[command.index("-ss") + 1] == "4.000000"
    assert command[command.index("-abort_on") + 1] == "empty_output"


def test_preview_segments_live_under_the_current_project_directory(tmp_path, monkeypatch):
    from app.features.lite_cut import assets as assets_mod

    monkeypatch.setattr(assets_mod, "lite_cut_assets_dir", lambda: tmp_path)
    project_directory = tmp_path / "4_My-project"
    project_directory.mkdir()
    row = {"id": 12, "fingerprint": "abc:def/123"}

    directory = preview_segment_cache_directory(row, project_directory, max_edge=720)

    assert directory == project_directory / ".preview" / "asset-12-abcdef123" / "segment-v1-720p"
    assert preview_segment_path(directory, 9).name == "segment-00000009.mp4"


def test_alpha_preview_segments_use_separate_schema_and_webm_extension(tmp_path, monkeypatch):
    from app.features.lite_cut import assets as assets_mod

    monkeypatch.setattr(assets_mod, "lite_cut_assets_dir", lambda: tmp_path)
    project_directory = tmp_path / "4_My-project"
    project_directory.mkdir()
    row = {"id": 12, "fingerprint": "alpha", "has_alpha": True}

    directory = preview_segment_cache_directory(row, project_directory, max_edge=720)

    assert directory.name == f"{SEGMENT_PREVIEW_ALPHA_SCHEMA}-720p"
    assert preview_segment_path(directory, 9).name == "segment-00000009.webm"


def test_proxy_cache_inventory_tracks_current_segments_and_marks_old_cache_reclaimable(tmp_path, monkeypatch):
    from app.features.lite_cut import assets as assets_mod
    from app.features.lite_cut.proxy_executor import (
        cleanup_orphan_preview_files,
        proxy_cache_inventory,
    )

    storage = tmp_path / "assets"
    storage.mkdir()
    monkeypatch.setattr(assets_mod, "lite_cut_assets_dir", lambda: storage)
    source = tmp_path / "large-linked.mp4"
    source.write_bytes(b"source")
    row = {
        "id": 12,
        "kind": "video",
        "storage_mode": "link",
        "original_path": str(source),
        "file_path": str(source),
        "size_bytes": 256 * 1024 * 1024,
        "duration_sec": 120,
        "fps": 60,
        "codec_name": "h264",
        "fingerprint": "abc:def/123",
        "source_status": "available",
        "has_alpha": False,
    }
    cache_root = storage / "12_Project" / ".preview" / "asset-12-abcdef123"
    current = cache_root / "segment-v1-720p" / "segment-00000000.mp4"
    stale_resolution = cache_root / "segment-v1-1080p" / "segment-00000000.mp4"
    legacy = storage / ".derived" / "asset-12-abcdef123" / "preview60-v3.mp4"
    for path, content in ((current, b"current"), (stale_resolution, b"stale-cache"), (legacy, b"legacy-cache")):
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_bytes(content)

    inventory = proxy_cache_inventory([row], max_edge=720)

    assert inventory == {
        "proxy_bytes": len(b"current"),
        "proxy_files": 1,
        "ready_assets": 1,
        "asset_count": 1,
        "proxy_required_assets": 1,
        "orphan_bytes": len(b"stale-cache") + len(b"legacy-cache"),
        "orphan_files": 2,
    }

    removed = cleanup_orphan_preview_files([row], max_edge=720)

    assert removed == {
        "removed_files": 2,
        "removed_bytes": len(b"stale-cache") + len(b"legacy-cache"),
    }
    assert current.is_file()
    assert not stale_resolution.exists()
    assert not legacy.exists()


@pytest.mark.anyio
async def test_regenerate_proxy_cache_invalidates_segments_without_building_legacy_full_file(monkeypatch):
    from app.features.lite_cut import proxy_api as api_mod

    row = {"id": 12, "file_path": "unused.mp4"}
    stopped = []
    legacy_removed = []

    async def all_rows():
        return [row]

    async def stop(asset_id):
        stopped.append(asset_id)

    monkeypatch.setattr(api_mod, "_all_asset_rows", all_rows)
    monkeypatch.setattr(api_mod, "_row_needs_segmented_preview", lambda _row: True)
    monkeypatch.setattr(api_mod, "_stop_preview_proxy_job", stop)
    monkeypatch.setattr(
        api_mod,
        "remove_segment_preview_files",
        lambda _row: {"removed_files": 3, "removed_bytes": 99},
    )
    monkeypatch.setattr(api_mod, "remove_asset_preview_files", lambda item: legacy_removed.append(item["id"]))
    monkeypatch.setattr(
        api_mod,
        "_start_preview_proxy_job",
        lambda *_args, **_kwargs: pytest.fail("legacy full-file proxy must not be regenerated"),
    )

    result = await api_mod.regenerate_lite_cut_proxies(api_mod.LiteCutProxyRegenerateBody())

    assert result == {
        "queued": 0,
        "invalidated": 1,
        "removed_files": 3,
        "removed_bytes": 99,
        "asset_ids": [12],
        "mode": "segmented_on_demand",
    }
    assert stopped == [12]
    assert legacy_removed == [12]


@pytest.mark.anyio
async def test_proxy_resolution_change_invalidates_existing_segment_directories(monkeypatch):
    from app.features.lite_cut import proxy_api as api_mod

    config = SimpleNamespace(lite_cut_proxy_resolution=720)
    rows = [{"id": 3}, {"id": 4}]
    stopped = []
    saved = []

    async def all_rows():
        return rows

    async def stop(asset_id):
        stopped.append(asset_id)

    monkeypatch.setattr(api_mod, "load_config", lambda: config)
    monkeypatch.setattr(api_mod, "save_config", lambda value: saved.append(value.lite_cut_proxy_resolution))
    monkeypatch.setattr(api_mod, "_all_asset_rows", all_rows)
    monkeypatch.setattr(api_mod, "_stop_preview_proxy_job", stop)
    monkeypatch.setattr(
        api_mod,
        "remove_segment_preview_files",
        lambda row: {"removed_files": row["id"], "removed_bytes": row["id"] * 10},
    )

    result = await api_mod.patch_lite_cut_proxy_settings(api_mod.LiteCutProxySettingsBody(resolution=1080))

    assert result == {
        "resolution": 1080,
        "invalidated": 2,
        "removed_files": 7,
        "removed_bytes": 70,
    }
    assert saved == [1080]
    assert stopped == [3, 4]


def test_deleting_legacy_managed_video_also_removes_segment_cache(tmp_path, monkeypatch):
    from app.features.lite_cut import assets as assets_mod

    monkeypatch.setattr(assets_mod, "lite_cut_assets_dir", lambda: tmp_path)
    project = tmp_path / "4_Project"
    source = project / "legacy.mov"
    source.parent.mkdir()
    source.write_bytes(b"managed source")
    segment = project / ".preview" / "asset-44-fixture" / "segment-v1-720p" / "segment-00000000.mp4"
    segment.parent.mkdir(parents=True)
    segment.write_bytes(b"derived segment")

    delete_asset_row_bundle({
        "id": 44,
        "storage_mode": "managed",
        "managed_path": str(source),
        "file_path": str(source),
    })

    assert not source.exists()
    assert not segment.exists()


@pytest.mark.anyio
async def test_far_playhead_seek_preempts_lower_priority_prefetch(tmp_path, monkeypatch):
    from app.features.lite_cut import proxy_api as api_mod
    from app.features.lite_cut.runtime import segment_preview_jobs

    release = asyncio.Event()

    async def hold_job(*_args, **_kwargs):
        await release.wait()

    monkeypatch.setattr(api_mod, "_run_segment_preview_job", hold_job)
    row = {"id": 812, "duration_sec": 120}
    segment_preview_jobs.pop(812, None)
    first = api_mod._start_segment_preview_job(
        row,
        requested_time_sec=0,
        look_ahead_sec=12,
        cache_directory=tmp_path,
        max_edge=720,
        priority="prefetch",
    )
    await asyncio.sleep(0)
    first.active_segment = 1

    urgent = api_mod._start_segment_preview_job(
        row,
        requested_time_sec=12,
        look_ahead_sec=12,
        cache_directory=tmp_path,
        max_edge=720,
    )

    assert first.cancel_event.is_set()
    assert urgent is not first
    assert urgent.segment_indexes[0] == 3
    assert urgent.priority == "interactive"
    release.set()
    await asyncio.gather(first.task, urgent.task)
    segment_preview_jobs.pop(812, None)


@pytest.mark.anyio
async def test_background_cache_waits_for_active_playhead_window(tmp_path, monkeypatch):
    from app.features.lite_cut import proxy_api as api_mod
    from app.features.lite_cut.runtime import segment_preview_jobs

    release = asyncio.Event()

    async def hold_job(*_args, **_kwargs):
        await release.wait()

    monkeypatch.setattr(api_mod, "_run_segment_preview_job", hold_job)
    row = {"id": 814, "duration_sec": 120}
    segment_preview_jobs.pop(814, None)
    foreground = api_mod._start_segment_preview_job(
        row,
        requested_time_sec=8,
        look_ahead_sec=12,
        cache_directory=tmp_path,
        max_edge=720,
        priority="interactive",
    )
    await asyncio.sleep(0)

    background = api_mod._start_segment_preview_job(
        row,
        requested_time_sec=80,
        look_ahead_sec=0,
        cache_directory=tmp_path,
        max_edge=720,
        priority="prefetch",
    )

    assert background is foreground
    assert not foreground.cancel_event.is_set()
    release.set()
    await foreground.task
    segment_preview_jobs.pop(814, None)


def test_segment_snapshot_never_marks_an_unrelated_job_segment_ready(tmp_path):
    from app.features.lite_cut import proxy_api as api_mod
    from app.features.lite_cut.runtime import LiteCutSegmentPreviewJob

    job = LiteCutSegmentPreviewJob(
        asset_id=815,
        request_id="foreground",
        segment_indexes=(2, 3, 4, 5),
        cache_directory=tmp_path,
        status="ready",
    )

    snapshot = api_mod._segment_preview_snapshot(job, requested_index=20, cache_directory=tmp_path)

    assert snapshot["status"] == "idle"
    assert snapshot["requested_segment"] == 20


@pytest.mark.anyio
async def test_failed_segment_job_is_reported_without_tight_retry_loop(tmp_path, monkeypatch):
    from app.features.lite_cut import proxy_api as api_mod
    from app.features.lite_cut.runtime import segment_preview_jobs

    async def fail_job(job, *_args, **_kwargs):
        job.status = "failed"
        job.error = "fixture failure"

    monkeypatch.setattr(api_mod, "_run_segment_preview_job", fail_job)
    row = {"id": 813, "duration_sec": 120}
    segment_preview_jobs.pop(813, None)
    failed = api_mod._start_segment_preview_job(
        row,
        requested_time_sec=8,
        look_ahead_sec=12,
        cache_directory=tmp_path,
        max_edge=720,
    )
    await failed.task

    polled = api_mod._start_segment_preview_job(
        row,
        requested_time_sec=8,
        look_ahead_sec=12,
        cache_directory=tmp_path,
        max_edge=720,
    )

    assert polled is failed
    assert polled.status == "failed"
    retried = api_mod._start_segment_preview_job(
        row,
        requested_time_sec=8,
        look_ahead_sec=12,
        cache_directory=tmp_path,
        max_edge=720,
        force=True,
    )
    assert retried is not failed
    await retried.task
    segment_preview_jobs.pop(813, None)


@pytest.mark.anyio
async def test_preview_request_publishes_first_ready_segment_from_project_cache(tmp_path, monkeypatch):
    from app.features.lite_cut import assets as assets_mod
    from app.features.lite_cut import assets_api as api_mod
    from app.features.lite_cut import proxy_api as proxy_mod
    from app.features.lite_cut.db import LiteCutDB
    from app.features.lite_cut.runtime import segment_preview_jobs
    from app import env_utils

    storage = tmp_path / "managed-assets"
    source = tmp_path / "external" / "large.mp4"
    source.parent.mkdir()
    source.write_bytes(b"linked source")
    stat = source.stat()
    db = LiteCutDB(tmp_path / "lite-cut.db")
    monkeypatch.setattr(assets_mod, "lite_cut_assets_dir", lambda: storage)
    monkeypatch.setattr(api_mod, "get_lite_cut_db", lambda: db)
    monkeypatch.setattr(env_utils, "load_config", lambda: SimpleNamespace(lite_cut_proxy_resolution=720))

    async def create_segment(job, _row, *, max_edge):
        assert max_edge == 720
        job.status = "running"
        index = job.segment_indexes[0]
        output = preview_segment_path(job.cache_directory, index)
        output.parent.mkdir(parents=True, exist_ok=True)
        output.write_bytes(b"short h264 mp4")
        job.ready_segments.append(index)
        job.status = "ready"

    monkeypatch.setattr(proxy_mod, "_run_segment_preview_job", create_segment)
    await db.init_tables()
    project_id = await db.create_project(name="Segment Project", body=empty_project().model_dump(mode="json"))
    asset_id = await db.create_asset(
        project_id=project_id,
        name=source.name,
        kind="video",
        mime_type="video/mp4",
        file_path=str(source),
        storage_mode="link",
        original_path=str(source),
        size_bytes=stat.st_size,
        mtime_ns=stat.st_mtime_ns,
        fingerprint="fixture-fingerprint",
        duration_sec=120,
    )
    segment_preview_jobs.pop(asset_id, None)

    body = api_mod.LiteCutPreviewRequestBody(time_sec=37.25, look_ahead_sec=12, priority="interactive")
    queued = await api_mod.request_lite_cut_asset_preview(asset_id, body)
    assert queued["requested_segment"] == 9
    assert queued["segment_url"] is None
    await asyncio.sleep(0)
    ready = await api_mod.request_lite_cut_asset_preview(asset_id, body)

    expected = (
        storage
        / f"{project_id}_Segment Project"
        / ".preview"
        / f"asset-{asset_id}-fixture-fingerprint"
        / "segment-v1-720p"
        / "segment-00000009.mp4"
    )
    assert expected.is_file()
    assert ready["status"] == "ready"
    assert ready["segment_start_sec"] == 36
    assert ready["segment_end_sec"] == 40.5
    assert ready["segment_url"].startswith(f"/api/lite-cut/assets/{asset_id}/preview/segments/9")
    assert "?v=" in ready["segment_url"]
    assert "request=" not in ready["segment_url"]
    response = await api_mod.stream_lite_cut_preview_segment(asset_id, 9)
    assert Path(response.path) == expected
    await asyncio.sleep(0)
    segment_preview_jobs.pop(asset_id, None)


def test_native_h264_mp4_stays_direct_when_average_bitrate_is_light(tmp_path):
    small = tmp_path / "small.mp4"
    large = tmp_path / "large.mp4"
    small.write_bytes(b"video")
    with large.open("wb") as output:
        output.truncate(256 * 1024 * 1024)
    assert asset_needs_browser_proxy(small, duration_sec=1) is False
    assert asset_needs_browser_proxy(large, duration_sec=600) is False


def test_high_bitrate_or_high_fps_h264_mp4_requires_smooth_preview_proxy(tmp_path):
    source = tmp_path / "high-load.mp4"
    with source.open("wb") as output:
        output.truncate(6 * 1024 * 1024)

    assert asset_exceeds_direct_preview_limits(source, duration_sec=1) is True
    assert asset_needs_browser_proxy(source, video_codec="h264", duration_sec=1) is True
    assert asset_needs_browser_proxy(source, video_codec="h264", duration_sec=60, fps=240) is True


def test_high_load_mp4_stream_ignores_ready_legacy_proxy(tmp_path):
    source = tmp_path / "high-load.mp4"
    with source.open("wb") as output:
        output.truncate(6 * 1024 * 1024)
    proxy = preview_proxy_path_for_asset(source)
    proxy.write_bytes(b"proxy")

    assert asset_stream_path(source, duration_sec=1) == source


def test_ready_high_fps_legacy_proxy_is_not_selected(tmp_path):
    source = tmp_path / "high-fps-light-bitrate.mp4"
    source.write_bytes(b"source")
    proxy = preview_proxy_path_for_asset(source)
    proxy.write_bytes(b"proxy")

    assert asset_stream_path(source, duration_sec=60) == source

    from app.features.lite_cut.proxy_api import (
        _decorate_asset_preview_state,
        _row_requires_or_has_preview_proxy,
    )

    row = {
        "id": 91,
        "file_path": str(source),
        "duration_sec": 60,
    }
    assert _row_requires_or_has_preview_proxy(row) is True
    state = _decorate_asset_preview_state(dict(row), schedule=False)
    assert state["preview_proxy_required"] is False
    assert state["preview_proxy_status"] == "not_needed"


def test_hevc_mp4_requires_browser_preview_proxy(tmp_path):
    source = tmp_path / "high-fps-hevc.mp4"
    source.write_bytes(b"\x00\x00\x00\x18ftypisom....hvc1....hvcC")

    assert asset_needs_browser_proxy(source) is True
    assert asset_needs_browser_proxy(source, video_codec="hevc") is True


def test_native_mp4_ignores_an_old_size_based_proxy(tmp_path):
    source = tmp_path / "large.mp4"
    source.write_bytes(b"source")
    source.with_name(f"{source.stem}.preview60.mp4").write_bytes(b"stale proxy")

    assert asset_stream_path(source) == source


def test_h264_remux_command_copies_video_without_scale_or_video_encoder(tmp_path):
    source = tmp_path / "match.mkv"
    output = preview_proxy_path_for_asset(source)
    command = preview_proxy_remux_command(
        ffmpeg_bin=tmp_path / "ffmpeg.exe",
        source=source,
        output=output,
        duration_sec=12.5,
        copy_audio=True,
    )

    assert command[command.index("-c:v") + 1] == "copy"
    assert command[command.index("-c:a") + 1] == "copy"
    assert "-b:a" not in command
    assert "-vf" not in command
    assert command[command.index("-t") + 1] == "12.500000"
    assert command[-1] == str(output)


def test_successful_remux_does_not_resolve_a_transcode_encoder(tmp_path, monkeypatch):
    from app.features.lite_cut import assets as assets_mod

    source = tmp_path / "match.mkv"
    source.write_bytes(b"source")

    def fake_run(command, **_kwargs):
        Path(command[-1]).write_bytes(b"proxy")
        return subprocess.CompletedProcess(command, 0, "", "")

    monkeypatch.setattr(assets_mod, "_run_proxy_process", fake_run)
    proxy = create_browser_preview_proxy(
        source,
        ffmpeg_bin=tmp_path / "ffmpeg.exe",
        video_encode_quality=lambda: pytest.fail("transcode encoder must stay lazy"),
        copy_video=True,
    )

    assert proxy == preview_proxy_path_for_asset(source)
    assert proxy.read_bytes() == b"proxy"


def test_failed_remux_falls_back_to_transcode(tmp_path, monkeypatch):
    from app.features.lite_cut import assets as assets_mod

    source = tmp_path / "match.mkv"
    source.write_bytes(b"source")
    modes = []

    def fake_run(command, **_kwargs):
        if command[command.index("-c:v") + 1] == "copy":
            return subprocess.CompletedProcess(command, 1, "", "unsupported stream copy")
        Path(command[-1]).write_bytes(b"transcoded proxy")
        return subprocess.CompletedProcess(command, 0, "", "")

    monkeypatch.setattr(assets_mod, "_run_proxy_process", fake_run)
    proxy = create_browser_preview_proxy(
        source,
        ffmpeg_bin=tmp_path / "ffmpeg.exe",
        video_encode_quality=["-c:v", "libx264"],
        copy_video=True,
        on_mode_change=modes.append,
    )

    assert modes == ["remux", "transcode"]
    assert proxy == preview_proxy_path_for_asset(source)
    assert proxy.read_bytes() == b"transcoded proxy"


def test_high_fps_h264_proxy_job_transcodes_instead_of_remuxing(tmp_path, monkeypatch):
    from app import env_utils
    from app.features.lite_cut import assets as assets_mod
    from app.features.lite_cut import proxy_api as api_mod
    from app.features.lite_cut import proxy_executor as proxy_executor_mod
    from app.features.lite_cut.runtime import LiteCutPreviewProxyJob

    source = tmp_path / "240fps.mp4"
    source.write_bytes(b"source")
    output = preview_proxy_path_for_asset(source)
    captured = {}

    monkeypatch.setattr(env_utils, "load_config", lambda: SimpleNamespace(ffmpeg_path=None, lite_cut_proxy_resolution=720))
    monkeypatch.setattr(proxy_executor_mod, "resolve_ffmpeg_binary", lambda _path: tmp_path / "ffmpeg.exe")

    def fake_create(source_path, **kwargs):
        captured.update(kwargs)
        output.write_bytes(b"proxy")
        assert source_path == source
        return output

    monkeypatch.setattr(assets_mod, "create_browser_preview_proxy", fake_create)
    job = LiteCutPreviewProxyJob(
        asset_id=42,
        has_alpha=False,
        video_codec="h264",
        audio_codec="aac",
        pixel_format="yuv420p",
        source_fps=240,
    )

    proxy, has_alpha = api_mod._create_preview_proxy_sync(
        job,
        {"file_path": str(source), "duration_sec": 60},
    )

    assert proxy == output
    assert has_alpha is False
    assert captured["copy_video"] is False
    assert captured["force"] is True


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
    from app.features.lite_cut import assets_api as api_mod

    class FakeMontageDB:
        async def get_recorded_clips_by_ids(self, ids):
            assert ids == [42]
            return {42: {"output_path": str(tmp_path / "missing-recording.mp4")}}

    monkeypatch.setattr(api_mod, "get_montage_db", lambda: FakeMontageDB())
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
