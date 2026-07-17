import asyncio
from pathlib import Path
from types import SimpleNamespace

from app.lite_cut import api as api_mod
from app.lite_cut import assets as assets_mod
from app.lite_cut.db import LiteCutDB


def test_migrate_asset_storage_paths_updates_assets_projects_and_exports(tmp_path):
    async def run():
        db = LiteCutDB(tmp_path / "litecut.db")
        await db.init_tables()
        old_root = (tmp_path / "old").resolve()
        new_root = (tmp_path / "new").resolve()
        old_media = old_root / "Project" / "clip.mp4"
        old_export = old_root / "Project" / "exports" / "result.mp4"
        project_id = await db.create_project(
            name="Project",
            body={
                "tracks": [],
                "overlays": [],
                "audio": {"bgm": {"path": str(old_media)}},
            },
        )
        asset_id = await db.create_asset(
            name="clip.mp4",
            kind="video",
            file_path=str(old_media),
            project_id=project_id,
        )
        export_id = await db.create_export(
            project_id=project_id,
            body={"output": {"path": str(old_export)}},
        )
        await db.update_export(export_id, status="done", output_path=str(old_export))

        counts = await db.migrate_asset_storage_paths(old_root, new_root)

        asset = await db.get_asset(asset_id)
        project = await db.get_project(project_id)
        export = await db.get_export(export_id)
        assert asset["file_path"] == str(new_root / "Project" / "clip.mp4")
        assert project["body"]["audio"]["bgm"]["path"] == str(new_root / "Project" / "clip.mp4")
        assert export["output_path"] == str(new_root / "Project" / "exports" / "result.mp4")
        assert counts["assets"] == 1
        assert counts["projects"] == 1
        assert counts["exports"] == 1

    asyncio.run(run())


def test_migration_keeps_external_paths_unchanged(tmp_path):
    async def run():
        db = LiteCutDB(tmp_path / "litecut.db")
        await db.init_tables()
        external = (tmp_path / "external" / "clip.mp4").resolve()
        asset_id = await db.create_asset(name="clip.mp4", kind="video", file_path=str(external))
        counts = await db.migrate_asset_storage_paths(tmp_path / "old", tmp_path / "new")
        assert (await db.get_asset(asset_id))["file_path"] == str(external)
        assert counts["assets"] == 0

    asyncio.run(run())


def test_storage_endpoint_copies_files_switches_config_and_removes_old_tree(tmp_path, monkeypatch):
    async def run():
        db = LiteCutDB(tmp_path / "litecut.db")
        await db.init_tables()
        source = (tmp_path / "source").resolve()
        target = (tmp_path / "target").resolve()
        media = source / "Project" / "clip.mp4"
        media.parent.mkdir(parents=True)
        media.write_bytes(b"video")
        project_id = await db.create_project(name="Project", body={"tracks": [], "overlays": [], "audio": {}})
        asset_id = await db.create_asset(name="clip.mp4", kind="video", file_path=str(media), project_id=project_id)
        config = SimpleNamespace(lite_cut_assets_dir="")
        saved = []

        monkeypatch.setattr(api_mod, "_get_lite_cut_db", lambda: db)
        monkeypatch.setattr(assets_mod, "lite_cut_assets_dir", lambda: source)
        monkeypatch.setattr(api_mod, "load_config", lambda: config)
        monkeypatch.setattr(api_mod, "save_config", lambda value: saved.append(value.lite_cut_assets_dir))
        api_mod._export_jobs.clear()
        api_mod._preview_proxy_jobs.clear()
        api_mod._storage_migration_jobs.clear()

        result = await api_mod.migrate_lite_cut_storage(
            api_mod.LiteCutStorageMoveBody(destination=str(target)),
        )
        await api_mod._storage_migration_jobs[result["job_id"]].task
        result = await api_mod.get_lite_cut_storage_migration(result["job_id"])

        assert result["status"] == "done"
        assert result["progress"] == 1
        assert result["copied_files"] == 1
        assert (target / "Project" / "clip.mp4").read_bytes() == b"video"
        assert not source.exists()
        assert saved == [str(target)]
        assert (await db.get_asset(asset_id))["file_path"] == str(target / "Project" / "clip.mp4")

    asyncio.run(run())


def test_storage_migration_can_cancel_before_paths_are_switched(tmp_path):
    async def run():
        source = (tmp_path / "source").resolve()
        target = (tmp_path / "target").resolve()
        source.mkdir()
        (source / "large.mov").write_bytes(b"video")
        job = api_mod.LiteCutStorageMigrationJob(
            job_id="cancel-test",
            source=source,
            target=target,
            target_existed=False,
        )
        job.cancel_event.set()

        await api_mod._run_storage_migration(job)

        assert job.status == "cancelled"
        assert source.is_dir()
        assert not target.exists()

    asyncio.run(run())


def test_storage_migration_handles_a_large_nested_file_set_with_exact_progress(tmp_path):
    source = tmp_path / "source"
    target = tmp_path / "target"
    expected_bytes = 0
    for index in range(1024):
        payload = bytes([index % 251]) * (128 + index % 97)
        path = source / f"project-{index % 8}" / "media" / f"clip-{index}.bin"
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_bytes(payload)
        expected_bytes += len(payload)

    job = api_mod.LiteCutStorageMigrationJob(
        job_id="large-file-set",
        source=source,
        target=target,
        target_existed=False,
    )
    files = api_mod._copy_storage_tree_with_progress(job)
    api_mod._verify_storage_copy(job, files)

    assert job.total_files == 1024
    assert job.copied_files == 1024
    assert job.total_bytes == expected_bytes
    assert job.copied_bytes == expected_bytes
    assert job.failed_files == []
    assert len(list(target.rglob("*.bin"))) == 1024


def test_storage_migration_rejects_insufficient_space_before_copying_media(tmp_path, monkeypatch):
    source = tmp_path / "source"
    target = tmp_path / "target"
    source.mkdir()
    (source / "large.mov").write_bytes(b"0123456789")
    monkeypatch.setattr(api_mod.shutil, "disk_usage", lambda _path: SimpleNamespace(free=9))
    job = api_mod.LiteCutStorageMigrationJob(
        job_id="no-space",
        source=source,
        target=target,
        target_existed=False,
    )

    try:
        api_mod._copy_storage_tree_with_progress(job)
        raise AssertionError("expected insufficient disk space")
    except OSError as exc:
        assert "空间不足" in str(exc)

    assert (source / "large.mov").read_bytes() == b"0123456789"
    assert not (target / "large.mov").exists()


def test_storage_migration_reports_the_exact_file_that_failed_verification(tmp_path):
    source = tmp_path / "source"
    target = tmp_path / "target"
    source.mkdir()
    original = source / "locked.mov"
    original.write_bytes(b"video")
    copied = target / "locked.mov"
    copied.parent.mkdir(parents=True)
    copied.write_bytes(b"bad")
    job = api_mod.LiteCutStorageMigrationJob(
        job_id="verify-failure",
        source=source,
        target=target,
        target_existed=True,
    )

    try:
        api_mod._verify_storage_copy(job, [(original, copied, original.stat().st_size)])
        raise AssertionError("expected verification failure")
    except OSError:
        pass

    assert job.failed_files == [str(original)]
