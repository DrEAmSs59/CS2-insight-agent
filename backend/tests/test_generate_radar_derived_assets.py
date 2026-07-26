from pathlib import Path

from PIL import Image

from app.radar.radar_derived_assets import estimate_content_rect, generate_utility_mask


def test_estimate_content_rect_and_mask(tmp_path: Path):
    img = Image.new("RGBA", (64, 64), (0, 0, 0, 255))
    for y in range(16, 48):
        for x in range(10, 50):
            img.putpixel((x, y), (120, 120, 120, 255))
    src = tmp_path / "radar.png"
    img.save(src)
    rect = estimate_content_rect(src, luminance_threshold=18, pad=0)
    assert rect["content_x"] == 10
    assert rect["content_y"] == 16
    assert rect["content_width"] == 40
    assert rect["content_height"] == 32
    out = tmp_path / "mask.png"
    generate_utility_mask(src, out, luminance_threshold=18)
    mask = Image.open(out).convert("L")
    assert mask.getpixel((0, 0)) == 0  # outer forced black
    assert mask.getpixel((30, 30)) == 255
