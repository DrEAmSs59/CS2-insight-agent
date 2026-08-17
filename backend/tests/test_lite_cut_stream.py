import asyncio

from app.features.lite_cut.stream import stream_file_with_range


def test_media_stream_is_inline_and_range_capable(tmp_path):
    media_path = tmp_path / "preview.mp4"
    media_path.write_bytes(b"test-media")

    response = asyncio.run(stream_file_with_range(media_path, None))

    assert response.media_type == "video/mp4"
    assert response.headers["accept-ranges"] == "bytes"
    assert "content-disposition" not in response.headers
