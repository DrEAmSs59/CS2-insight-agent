import pytest

from app.lite_cut.db import LiteCutDB
from app.lite_cut.models import empty_project


def test_track_custom_name_survives_project_body_round_trip():
    body = empty_project()
    body.tracks[0].name = "Main camera"

    restored = type(body).model_validate(body.model_dump(mode="json"))

    assert restored.tracks[0].label == "V1"
    assert restored.tracks[0].name == "Main camera"


@pytest.mark.anyio
async def test_list_exports_filters_project_and_orders_updated(tmp_path):
    db = LiteCutDB(tmp_path / "lite_cut.db")
    await db.init_tables()
    body = empty_project().model_dump(mode="json")

    first = await db.create_export(project_id=1, body=body, status="done", output_path="C:/out/first.mp4")
    other = await db.create_export(project_id=2, body=body, status="done", output_path="C:/out/other.mp4")
    second = await db.create_export(project_id=1, body=body, status="error", error_msg="MONTAGE_EXPORT_FAILED")
    await db.update_export(first, status="done", output_path="C:/out/first-updated.mp4")

    all_rows = await db.list_exports(limit=10)
    assert {row["id"] for row in all_rows} == {first, other, second}

    project_rows = await db.list_exports(project_id=1, limit=10)
    assert [row["id"] for row in project_rows] == [first, second]
    assert project_rows[0]["output_path"] == "C:/out/first-updated.mp4"
    assert project_rows[1]["error_msg"] == "MONTAGE_EXPORT_FAILED"


@pytest.mark.anyio
async def test_batch_delete_projects_is_atomic_and_reports_existing_ids(tmp_path):
    db = LiteCutDB(tmp_path / "lite_cut.db")
    await db.init_tables()
    body = empty_project().model_dump(mode="json")
    first = await db.create_project(name="One", body=body)
    second = await db.create_project(name="Two", body=body)
    third = await db.create_project(name="Three", body=body)

    deleted = await db.delete_projects([second, first, second, 999999])

    assert deleted == [first, second]
    assert await db.get_project(first) is None
    assert await db.get_project(second) is None
    assert await db.get_project(third) is not None


@pytest.mark.anyio
async def test_duplicate_project_names_receive_numeric_suffixes(tmp_path):
    db = LiteCutDB(tmp_path / "lite_cut.db")
    await db.init_tables()
    body = empty_project().model_dump(mode="json")

    first = await db.create_project(name="未命名工程", body=body)
    second = await db.create_project(name="未命名工程", body=body)
    third = await db.create_project(name="未命名工程", body=body)

    assert (await db.get_project(first))["name"] == "未命名工程"
    assert (await db.get_project(second))["name"] == "未命名工程 (1)"
    assert (await db.get_project(third))["name"] == "未命名工程 (2)"


@pytest.mark.anyio
async def test_project_rename_is_made_unique_and_delete_removes_asset_rows(tmp_path):
    db = LiteCutDB(tmp_path / "lite_cut.db")
    await db.init_tables()
    body = empty_project().model_dump(mode="json")
    first = await db.create_project(name="Project", body=body)
    second = await db.create_project(name="Other", body=body)
    await db.update_project(second, name="Project")
    await db.create_asset(name="clip.mp4", kind="video", file_path="C:/clip.mp4", project_id=second)

    assert (await db.get_project(second))["name"] == "Project (1)"
    assert len(await db.list_project_assets(second)) == 1
    assert await db.delete_project(second) is True
    assert await db.list_project_assets(second) == []
    assert await db.get_project(first) is not None
