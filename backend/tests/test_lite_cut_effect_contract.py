from pathlib import Path

import pytest

from app.features.lite_cut.composer import (
    _FILTER_PRESET_VF,
    _MAIN_VIDEO_EXT,
    _build_color_vf,
    _clip_canvas_transform_graph,
)
from app.features.lite_cut.effect_contract import load_effect_contract
from app.features.lite_cut.project_boundaries import (
    AUDIO_BGM_GAIN_DEFAULT,
    AUDIO_CLIP_GAIN_DEFAULT,
    AUDIO_FADE_DURATION_MAX,
    AUDIO_MASTER_GAIN_DEFAULT,
    AUDIO_TRACK_GAIN_DEFAULT,
    TIMELINE_DURATION_DEFAULT,
    TIMELINE_TIME_MAX,
)
from app.features.lite_cut.scene_transform import normalize_scene_transform
from app.features.lite_cut.transition_events import TRANSITION_DURATION_DEFAULT
from app.features.lite_cut.visual_material import (
    VISUAL_COLOR_DEFAULT,
    VISUAL_FREEZE_DEFAULT_SEC,
    VISUAL_SPEED_DEFAULT,
    normalized_visual_material_project,
)


def test_effect_contract_is_the_exporter_filter_source_of_truth():
    contract = load_effect_contract()
    expected = {
        item["id"]: item["ffmpeg"]
        for item in contract["filter_presets"]
        if item["id"] != "none"
    }
    assert _FILTER_PRESET_VF == expected


@pytest.mark.parametrize(
    "raw,expected",
    [
        ({"x": -5, "y": 5, "width": 9, "height": 0, "scale": 10, "rotation": 999, "opacity": -2},
         {"x": -5, "y": 5, "width": 9, "height": 0.0001, "scale": 10, "rotation": 999, "opacity": 0}),
        ({}, {"x": 0.5, "y": 0.5, "width": 1, "height": 1, "scale": 1, "rotation": 0, "opacity": 1}),
    ],
)
def test_scene_transform_uses_contract_bounds(raw, expected):
    assert normalize_scene_transform(raw) == expected


def test_shared_defaults_and_timing_boundaries_come_from_contracts():
    contract = load_effect_contract()
    assert {
        "clip": AUDIO_CLIP_GAIN_DEFAULT,
        "track": AUDIO_TRACK_GAIN_DEFAULT,
        "master": AUDIO_MASTER_GAIN_DEFAULT,
        "bgm": AUDIO_BGM_GAIN_DEFAULT,
    } == contract["audio_mix"]["gain_defaults"]
    assert AUDIO_FADE_DURATION_MAX == contract["audio_mix"]["fade_duration_sec"]["max"]
    assert TRANSITION_DURATION_DEFAULT == contract["transition_model"]["limits"]["duration_default"]
    assert VISUAL_SPEED_DEFAULT == contract["visual_material"]["defaults"]["speed"]
    assert VISUAL_FREEZE_DEFAULT_SEC == contract["visual_material"]["defaults"]["freeze_frame_sec"]
    assert VISUAL_COLOR_DEFAULT == contract["visual_material"]["defaults"]["color_adjustment"]
    assert TIMELINE_TIME_MAX == 86400
    assert TIMELINE_DURATION_DEFAULT == 3


def test_visual_crop_normalization_uses_the_shared_minimum_size():
    body, changed = normalized_visual_material_project({
        "tracks": [{"type": "video", "clips": [{"crop": {"x": 1, "y": -1, "width": 0, "height": 0}}]}],
        "overlays": [],
    })
    assert changed is True
    assert body["tracks"][0]["clips"][0]["crop"] == {"x": 0.95, "y": 0.0, "width": 0.05, "height": 0.05}


def test_all_filter_canvas_and_media_combinations_have_an_export_contract():
    contract = load_effect_contract()
    combinations = 0
    for canvas in contract["canvas_presets"]:
        for preset in contract["filter_presets"]:
            for extension in contract["media_extensions"]:
                combinations += 1
                if extension not in {"png", "jpg", "jpeg", "webp", "gif"}:
                    assert f".{extension}" in _MAIN_VIDEO_EXT or extension == "webm"
                vf = _build_color_vf({"filter_preset": preset["id"]})
                assert vf == preset["ffmpeg"]
                graph = _clip_canvas_transform_graph(
                    "[in]",
                    "[out]",
                    clip={"transform": {"width": 1.2, "height": 0.8}},
                    source_filter="format=rgba",
                    content_fit="fill",
                    width=canvas["width"],
                    height=canvas["height"],
                    fps=60,
                    duration=1,
                    background_color="black",
                )
                assert f"s={canvas['width']}x{canvas['height']}" in graph
    assert combinations == len(contract["canvas_presets"]) * len(contract["filter_presets"]) * len(contract["media_extensions"])


def test_transition_contract_is_one_nine_effect_event_model():
    transition = load_effect_contract()["transition_model"]
    assert transition["storage"] == "independent_events"
    assert transition["time_alignment"] == {
        "paired": "centered_on_cut",
        "single_enter": "inside_node_head",
        "single_exit": "inside_node_tail",
    }
    assert [item["id"] for item in transition["types"]] == [
        "cut", "fade", "flash", "dip", "zoom", "wipe_l", "wipe_r", "slide_up", "slide_down",
    ]


def test_text_contract_defines_one_layout_style_and_font_source_of_truth():
    contract = load_effect_contract()
    layout = contract["text_layout"]
    assert layout["coordinate_space"] == "authored_box_output_pixels"
    assert layout["horizontal_alignment"] == "block_and_each_explicit_line"
    assert layout["line_height"]["meaning"] == "baseline_advance"
    assert layout["letter_spacing"]["supported_values"] == [0]
    assert layout["style_capabilities"] == ["solid_fill", "uniform_outline"]
    assert {item["id"] for item in contract["text_style_presets"]} == {
        "plain", "creator", "retro", "bubble", "large-title", "ace", "clutch", "namecard",
    }
    assert {item["family"] for item in contract["text_fonts"]} == {
        "微软雅黑", "思源黑体 Medium", "Impact", "Noto Sans SC",
    }
