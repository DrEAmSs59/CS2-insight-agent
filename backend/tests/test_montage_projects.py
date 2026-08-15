import asyncio

from app.montage_db import MontageDB


def test_lists_opens_and_deletes_montage_projects(tmp_path):
    async def run():
        db = MontageDB(tmp_path / "montage-projects.db")
        await db.init_tables()
        first_id = await db.save_project(
            name="First draft",
            body={"recorded_clip_ids": [1], "output_filename": "first.mp4"},
        )
        second_id = await db.save_project(
            name="Second draft",
            body={
                "recorded_clip_ids": [2, 3],
                "output_filename": "second.mp4",
                "bgm_path": r"D:\Music\bgm.mp3",
            },
        )

        items, total = await db.list_projects(limit=10, offset=0)
        assert total == 2
        assert [item["id"] for item in items] == [second_id, first_id]
        assert items[0]["clip_count"] == 2
        assert items[0]["output_filename"] == "second.mp4"
        assert items[0]["has_bgm"] is True

        opened = await db.get_project(second_id)
        assert opened is not None
        assert opened["name"] == "Second draft"
        assert opened["body"]["recorded_clip_ids"] == [2, 3]

        assert await db.delete_project(second_id) is True
        assert await db.get_project(second_id) is None
        assert await db.delete_project(second_id) is False

    asyncio.run(run())
