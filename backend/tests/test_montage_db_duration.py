import asyncio

from app.montage_db import MontageDB


def test_updates_recorded_clip_duration_from_measured_media(tmp_path):
    async def run():
        db = MontageDB(tmp_path / "montage.db")
        await db.init_tables()
        clip_id = await db.insert_recorded_clip(
            clip_id="source-1",
            demo_path="match.dem",
            demo_filename="match.dem",
            player_name="player",
            output_path="clip.mp4",
            duration_sec=16,
        )
        assert await db.update_recorded_clip_duration(clip_id, 8.02) is True
        row = (await db.get_recorded_clips_by_ids([clip_id]))[clip_id]
        assert row["duration_sec"] == 8.02
        assert await db.update_recorded_clip_duration(9999, 3) is False

    asyncio.run(run())
