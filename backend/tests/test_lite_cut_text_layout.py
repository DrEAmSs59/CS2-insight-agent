import pytest

from app.features.lite_cut.text_layout import (
    builtin_text_font_path,
    canonical_text_font_family,
    drawtext_line_spacing,
    font_natural_line_advance,
    normalize_text_layout,
    resolve_builtin_text_font_face,
    text_style_drawtext_options,
)


def test_text_layout_normalizes_against_the_shared_contract():
    assert normalize_text_layout({
        "font_family": "Rajdhani Bold",
        "font_size": 5000,
        "font_weight": 50,
        "line_height": 9,
        "letter_spacing": 99,
        "align": "invalid",
    }) == {
        "font_family": "微软雅黑",
        "font_size": 1000,
        "font_weight": 100,
        "line_height": 4.0,
        "letter_spacing": 0.0,
        "align": "center",
        "preset_id": "plain",
        "fill_color": None,
    }


def test_builtin_font_resolution_uses_the_same_weight_faces_as_preview():
    assert resolve_builtin_text_font_face("微软雅黑", 300)["file"] == "msyhl.ttc"
    assert resolve_builtin_text_font_face("微软雅黑", 500)["file"] == "msyh.ttc"
    assert resolve_builtin_text_font_face("微软雅黑", 700)["file"] == "msyhbd.ttc"
    assert resolve_builtin_text_font_face("Noto Sans SC", 500)["file"] == "NotoSansSC-Medium.ttf"
    assert resolve_builtin_text_font_face("Noto Sans SC", 700)["file"] == "NotoSansSC-Bold.ttf"
    assert canonical_text_font_family("sans-serif") == "微软雅黑"


def test_drawtext_line_spacing_translates_contract_baseline_advance():
    font = builtin_text_font_path("Noto Sans SC", 700)
    natural = font_natural_line_advance(font, 64)
    assert natural == 93
    assert drawtext_line_spacing(font, 64, 1.2) == 77 - natural


def test_drawtext_style_is_contract_derived_and_has_no_private_decorations():
    assert text_style_drawtext_options("clutch") == [
        "fontcolor=0x67e8f9",
        "borderw=3",
        "bordercolor=0x000000@0.72",
    ]
    bubble = text_style_drawtext_options("bubble")
    assert bubble[0] == "fontcolor=0xffffff"
    assert all(not option.startswith("box=") for option in bubble)


def test_existing_font_with_unreadable_metrics_is_rejected_instead_of_exporting_inaccurately(tmp_path):
    invalid_font = tmp_path / "invalid.woff2"
    invalid_font.write_bytes(b"not-a-font")
    with pytest.raises(ValueError, match="cannot read line metrics"):
        drawtext_line_spacing(invalid_font, 64, 1.2)
