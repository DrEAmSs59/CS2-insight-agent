"""LiteCut preset apply pure functions."""

from app.features.lite_cut.models import (
    BgmConfig,
    ColorGradePresetBody,
    OverlayRecipeLayer,
    OverlayRecipePresetBody,
    PackagingBundleBody,
    TextStylePresetBody,
    TimelineClip,
    TransitionRhythmPresetBody,
    empty_project,
)
from app.features.lite_cut.api import _preset_asset_warnings
from app.features.lite_cut.preset_apply import (
    apply_color_grade,
    apply_overlay_recipe,
    apply_packaging_bundle,
    apply_preset_to_project,
    apply_text_style,
    apply_transition_rhythm,
    parse_project_body,
)


def _project_with_v1_clips():
    project = empty_project()
    main = next(t for t in project.tracks if t.id == "v1")
    main.clips = [
        TimelineClip(
            id="c1",
            source_type="recorded_clip",
            source_id=1,
            timeline_start=0.0,
            trim_in=0.0,
            trim_out=10.0,
            meta={"player_name": "Dream", "map_name": "de_mirage", "duration_sec": 10.0},
        ),
        TimelineClip(
            id="c2",
            source_type="recorded_clip",
            source_id=2,
            timeline_start=12.0,
            trim_in=0.0,
            trim_out=8.0,
            meta={"player_name": "Rival_X", "map_name": "de_inferno", "duration_sec": 8.0},
        ),
    ]
    return project


def test_parse_project_body_preserves_timeline_markers():
    out = parse_project_body(
        {
            "schema_version": 3,
            "tracks": [],
            "overlays": [],
            "markers": [{"id": "m1", "time_sec": 4.25, "label": "beat", "color": "#f59e0b"}],
        }
    )
    assert len(out.markers) == 1
    assert out.markers[0].id == "m1"
    assert out.markers[0].time_sec == 4.25


def test_parse_project_body_preserves_clip_speed_flags():
    out = parse_project_body(
        {
            "schema_version": 3,
            "tracks": [
                {
                    "id": "v1",
                    "type": "video",
                    "label": "V1",
                    "clips": [
                        {
                            "id": "clip-r",
                            "source_type": "recorded_clip",
                            "source_id": 1,
                            "timeline_start": 0,
                            "trim_in": 0,
                            "trim_out": 4,
                            "content_fit": "cover",
                            "preserve_pitch": False,
                            "reverse": True,
                        }
                    ],
                }
            ],
            "overlays": [],
        }
    )
    main = next(t for t in out.tracks if t.id == "v1")
    assert main.clips[0].content_fit == "cover"
    assert main.clips[0].preserve_pitch is False
    assert main.clips[0].reverse is True


def test_apply_text_style_each_clip_placeholder():
    project = _project_with_v1_clips()
    preset = TextStylePresetBody(content_template="ACE · {{player_name}}", font_size=64)
    out = apply_text_style(project, preset, scope="project")
    assert len(out.overlays) == 2
    contents = {ov.text.content for ov in out.overlays if ov.text}
    assert "ACE · Dream" in contents
    assert "ACE · Rival_X" in contents


def test_apply_color_grade_v1_main():
    project = _project_with_v1_clips()
    preset = ColorGradePresetBody(brightness=10, contrast=5, saturation=-3, apply_to="v1_main")
    out = apply_color_grade(project, preset)
    main = next(t for t in out.tracks if t.id == "v1")
    assert all(c.color and c.color.brightness == 10 for c in main.clips)


def test_apply_transition_rhythm_flash_every_n():
    project = _project_with_v1_clips()
    main = next(t for t in project.tracks if t.id == "v1")
    main.clips.append(
        TimelineClip(
            id="c3",
            source_type="recorded_clip",
            source_id=3,
            timeline_start=22.0,
            trim_out=6.0,
            meta={"duration_sec": 6.0},
        )
    )
    preset = TransitionRhythmPresetBody(
        default_type="fade",
        default_duration_sec=0.4,
        flash_every_n=2,
        flash_type="flash",
    )
    out = apply_transition_rhythm(project, preset)
    by_from = {event.from_.id: event for event in out.transitions if event.from_}
    assert by_from["c1"].type == "fade"
    assert by_from["c1"].to is None
    assert by_from["c2"].type == "flash"
    assert by_from["c2"].to is None


def test_apply_transition_rhythm_pairs_contiguous_materials_at_one_edit_point():
    project = _project_with_v1_clips()
    main = next(t for t in project.tracks if t.id == "v1")
    main.clips[1].timeline_start = 10.0
    out = apply_transition_rhythm(project, TransitionRhythmPresetBody(default_type="wipe_l", default_duration_sec=0.8))
    assert len(out.transitions) == 1
    assert out.transitions[0].from_ and out.transitions[0].from_.id == "c1"
    assert out.transitions[0].to and out.transitions[0].to.id == "c2"
    assert out.transitions[0].type == "wipe_l"


def test_cut_transition_preset_uses_zero_duration_and_creates_no_event():
    project = _project_with_v1_clips()
    preset = TransitionRhythmPresetBody(default_type="cut", default_duration_sec=0)
    assert preset.default_duration_sec == 0
    out = apply_transition_rhythm(project, preset)
    assert out.transitions == []


def test_apply_overlay_recipe_each_clip_start():
    project = _project_with_v1_clips()
    preset = OverlayRecipePresetBody(
        layers=[
            OverlayRecipeLayer(
                type="text",
                anchor="each_clip_start",
                offset_sec=0.5,
                duration_sec="clip_length",
                text_style=TextStylePresetBody(content_template="{{player_name}}"),
            )
        ]
    )
    out = apply_overlay_recipe(project, preset)
    assert len(out.overlays) == 2
    assert {ov.text.content for ov in out.overlays if ov.text} == {"Dream", "Rival_X"}


def test_parse_project_body_preserves_overlay_asset_meta():
    raw = empty_project().model_dump(mode="json")
    raw["overlays"] = [
        {
            "id": "ov-asset",
            "type": "sticker",
            "timeline_start": 1.25,
            "duration": 3,
            "asset_path": "C:/clips/logo.png",
            "transform": {"x": 0.2, "y": 0.8, "width": 0.3, "height": 0.3, "scale": 1, "rotation": 0, "opacity": 0.75},
            "meta": {"asset_id": 42, "name": "logo.png", "kind": "image", "duration_sec": 3},
        }
    ]
    parsed = parse_project_body(raw).model_dump(mode="json")
    assert parsed["overlays"][0]["meta"]["asset_id"] == 42
    assert parsed["overlays"][0]["meta"]["name"] == "logo.png"
    assert parsed["overlays"][0]["meta"]["kind"] == "image"


def test_apply_packaging_bundle_dispatch():
    project = _project_with_v1_clips()
    bundle = PackagingBundleBody(
        color_grade=ColorGradePresetBody(saturation=20),
        transition_rhythm=TransitionRhythmPresetBody(default_type="zoom"),
    )
    out = apply_packaging_bundle(project, bundle)
    main = next(t for t in out.tracks if t.id == "v1")
    assert main.clips[0].color and main.clips[0].color.saturation == 20
    assert out.transitions[0].from_ and out.transitions[0].from_.id == "c1"
    assert out.transitions[0].to is None
    assert out.transitions[0].type == "zoom"


def test_apply_packaging_bundle_copies_bgm_configuration():
    project = _project_with_v1_clips()
    bundle = PackagingBundleBody(bgm=BgmConfig(path="C:/audio/theme.mp3", asset_id=9, volume=0.4))
    out = apply_packaging_bundle(project, bundle)
    assert out.audio.bgm and out.audio.bgm.path == "C:/audio/theme.mp3"
    assert out.audio.bgm.asset_id == 9


def test_preset_asset_warnings_identify_missing_bgm_and_font():
    warnings = _preset_asset_warnings(
        {
            "audio": {"bgm": {"path": "C:/missing/theme.mp3"}},
            "overlays": [{"type": "text", "text": {"font_file": "C:/missing/font.ttf"}}],
        }
    )
    assert {warning["kind"] for warning in warnings} == {"bgm", "font"}


def test_apply_preset_to_project_kind_dispatch():
    project = _project_with_v1_clips()
    out = apply_preset_to_project(
        project.model_dump(),
        "color_grade",
        {"brightness": 7, "contrast": 0, "saturation": 0, "apply_to": "v1_main"},
    )
    main = next(t for t in out.tracks if t.id == "v1")
    assert main.clips[0].color and main.clips[0].color.brightness == 7
