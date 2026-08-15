import json
from pathlib import Path

import pytest

from app.features.lite_cut.scene_transform import scene_transform_pixels


CASES = json.loads(
    (Path(__file__).resolve().parent / "fixtures" / "lite_cut" / "lite_cut_scene_transform_cases.json").read_text(encoding="utf-8")
)["cases"]


@pytest.mark.parametrize("case", CASES, ids=lambda case: case["id"])
def test_scene_transform_fixture_projects_to_identical_output_pixels(case):
    width, height = case["canvas"]
    actual = scene_transform_pixels(case["transform"], width, height)
    assert actual == pytest.approx(case["pixels"], abs=1e-9)
