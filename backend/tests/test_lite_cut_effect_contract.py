from pathlib import Path

import pytest

from app.lite_cut.composer import (
    _FILTER_PRESET_VF,
    _MAIN_VIDEO_EXT,
    _build_color_vf,
    _clip_canvas_transform_graph,
)
from app.lite_cut.effect_contract import load_effect_contract, normalize_video_layer_transform


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
         {"x": 0, "y": 1, "width": 3, "height": 0.01, "scale": 3, "rotation": 180, "opacity": 0}),
        ({}, {"x": 0.5, "y": 0.5, "width": 1, "height": 1, "scale": 1, "rotation": 0, "opacity": 1}),
    ],
)
def test_video_transform_uses_contract_bounds(raw, expected):
    assert normalize_video_layer_transform(raw) == expected


def test_all_filter_canvas_and_media_combinations_have_an_export_contract():
    contract = load_effect_contract()
    combinations = 0
    for canvas in contract["canvas_presets"]:
        for preset in contract["filter_presets"]:
            for extension in contract["media_extensions"]:
                combinations += 1
                if extension not in {"png", "jpg", "jpeg", "gif"}:
                    assert f".{extension}" in _MAIN_VIDEO_EXT or extension == "webm"
                vf = _build_color_vf({"filter_preset": preset["id"]})
                assert vf == preset["ffmpeg"]
                graph = _clip_canvas_transform_graph(
                    "[in]",
                    "[out]",
                    clip={"transform": {"width": 1.2, "height": 0.8}},
                    fitted_filter="",
                    width=canvas["width"],
                    height=canvas["height"],
                    fps=60,
                    duration=1,
                    background_color="black",
                )
                assert f"s={canvas['width']}x{canvas['height']}" in graph
    assert combinations == len(contract["canvas_presets"]) * len(contract["filter_presets"]) * len(contract["media_extensions"])
