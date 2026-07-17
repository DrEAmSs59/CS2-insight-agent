from pathlib import Path


ASSET_NAMES = {
    "air_noscope.webm",
    "collateral.webm",
    "one_tap.webm",
    "humiliation.webm",
    "revenge.webm",
    "first_blood.webm",
    "wallbang.webm",
    "no_scope.webm",
    "smoke_kill.webm",
    "double.webm",
    "triple.webm",
    "quad.webm",
    "ace.webm",
    "clutch_1v5_to_1v4.webm",
    "clutch_1v4_to_1v3.webm",
    "clutch_1v3_to_1v2.webm",
    "clutch_1v2_to_1v1.webm",
}


def test_killfx_page_references_every_packaged_video():
    overlay_dir = Path(__file__).parents[1] / "app" / "recording" / "executor" / "overlay"
    html = (overlay_dir / "killfx.html").read_text(encoding="utf-8")
    asset_dir = overlay_dir / "tag-videos"

    assert {path.name for path in asset_dir.glob("*.webm")} == ASSET_NAMES
    for name in ASSET_NAMES:
        assert f"tag-videos/{name}" in html
        assert (asset_dir / name).read_bytes()[:4] == b"\x1aE\xdf\xa3"


def test_killfx_page_uses_one_main_player_and_compact_badges():
    overlay_dir = Path(__file__).parents[1] / "app" / "recording" / "executor" / "overlay"
    html = (overlay_dir / "killfx.html").read_text(encoding="utf-8")

    assert 'id="fx-main-stage"' in html
    assert 'id="fx-badge-rack"' in html
    assert 'id="fx-icon-stage"' not in html
    assert 'id="fx-banner-stage"' not in html
    assert "const MAX_BADGES = 3" in html
    assert "const BADGE_BASE_DELAY_MS = 300" in html
    assert "const BADGE_STAGGER_MS = 130" in html
    assert "fx-badge-line-ignite" in html
    assert "fx-badge-panel-wipe" in html
    assert "fx-badge-text-wipe" in html
    assert 'font-family: "Bahnschrift SemiCondensed"' in html
    assert "font-weight: 600" in html
    assert 'wallbang: { label: "WALLBANG"' in html
    assert "video.muted = false" in html
    assert "Number.isFinite(msg.kill_fx_offset_ticks)" in html
    assert ": (msg.offset_ticks || 0)" in html


def test_executor_broadcasts_independent_overlay_offsets():
    executor = Path(__file__).parents[1] / "app" / "recording" / "executor" / "recording_executor.py"
    source = executor.read_text(encoding="utf-8")

    assert '"offset_ticks": _kb_tick_off' in source
    assert '"kill_fx_offset_ticks": _fx_tick_off' in source
    assert '"kill_fx_extra_offset_ticks"' not in source
