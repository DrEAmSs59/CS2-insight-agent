"""LiteCut composer helper tests."""

import sys
import threading
from pathlib import Path
from types import SimpleNamespace

import pytest

from app.lite_cut.composer import (
    _audio_mix_filter_complex,
    _audio_track_clips_for_export,
    _video_layer_audio_clips_for_export,
    _resolve_audio_clip_paths,
    _audio_filter_chain,
    _builtin_text_font_file,
    _build_color_vf,
    _build_transitions,
    _clip_audio_fade,
    _clip_canvas_fit,
    _clip_duration_sec,
    _clip_freeze_frame_sec,
    _clip_preserve_pitch,
    _clip_reverse,
    _clip_speed,
    _clip_speed_keyframes,
    _clip_speed_segments,
    _clip_timeline_duration_sec,
    _clip_video_fade,
    _clip_video_filter_chain,
    _clip_canvas_transform_graph,
    _clip_visual_fade,
    _clip_volume,
    _clip_volume_filter,
    _composite_overlays_on_base,
    _drawtext_filter_complex,
    _stage_custom_font_for_ffmpeg,
    _first_missing_file_asset_for_export,
    _missing_file_assets_for_export,
    _is_file_overlay_clip,
    _is_audio_file_clip,
    _is_main_file_clip,
    _has_solo_audio_tracks,
    _map_transition_type,
    _mix_audio_tracks_on_base,
    _overlay_filter_complex,
    _overlay_height_from_transform,
    _overlay_video_decoder_args,
    _is_looping_animation_file,
    _overlay_keyframe_expr,
    _overlay_layout_from_transform,
    _overlay_opacity_from_transform,
    _project_bgm_clip_for_export,
    _project_canvas_settings,
    _project_encoder_tier,
    _project_export_range,
    _project_output_settings,
    _project_master_volume,
    _recorded_source_ids_for_export,
    _resolve_overlay_clip_paths,
    _run_ffmpeg_process,
    _schema_overlay_clips,
    _base_video_track_for_export,
    _main_video_clips_sorted,
    _overlay_track_clips,
    _timeline_video_layer_clip,
    _timeline_gap_plan,
    _has_soft_positional_transition,
    _lite_cut_clip_to_ts,
    _boundary_transition_filter_complex,
    _v1_clips_sorted,
    _v1_main_clips_sorted,
    _v1_recorded_clips_sorted,
)
from app.video_composer import MontageComposerError
from app.video_composer import _xfade_transition_name
from app.lite_cut.models import empty_project


def test_map_transition_types():
    assert _map_transition_type("dip") == "dip_black"
    assert _map_transition_type("slide_left") == "slide_left"


def test_builtin_text_fonts_keep_their_intended_faces_and_legacy_fallback():
    assert _builtin_text_font_file("思源黑体 Medium").endswith("NotoSansSC-Medium.ttf")
    assert _builtin_text_font_file("Noto Sans SC").endswith("NotoSansSC-Bold.ttf")
    assert _builtin_text_font_file("Rajdhani Bold").endswith("NotoSansSC-Bold.ttf")


def test_main_clip_transform_uses_preview_canvas_coordinates():
    graph = _clip_canvas_transform_graph(
        "[0:v]",
        "[vout]",
        clip={"transform": {"x": 0.1, "y": 0.75, "width": 0.5, "height": 0.4, "scale": 1.5, "rotation": 30, "opacity": 0.8}},
        fitted_filter="scale=1920:1080,format=yuv420p",
        width=1920,
        height=1080,
        fps=60,
        duration=3,
        background_color="black",
    )
    assert "scale=1440:648" in graph
    assert "W*(0.100000)-w/2" in graph
    assert "H*(0.750000)-h/2" in graph
    assert "colorchannelmixer=aa=0.800000" in graph
    assert "rotw(0.52359878)" in graph
    assert "[vout]" in graph


def test_main_clip_zero_rotation_skips_incompatible_rotate_filter():
    graph = _clip_canvas_transform_graph(
        "[0:v]", "[vout]",
        clip={"transform": {"x": 0.7, "y": 0.6, "width": 1, "height": 1, "scale": 0.72, "rotation": 0}},
        fitted_filter="scale=1920:1080,format=yuv420p",
        width=1920, height=1080, fps=60, duration=3, background_color="#000000",
    )
    assert "rotate=" not in graph


def test_main_clip_keyframes_animate_position_scale_rotation_and_opacity():
    graph = _clip_canvas_transform_graph(
        "[0:v]", "[vout]",
        clip={
            "transform": {"x": 0.5, "y": 0.5, "width": 1, "height": 1, "scale": 1, "rotation": 0, "opacity": 1},
            "keyframes": [
                {"time_sec": 0, "transform": {"x": 0.2, "y": 0.3, "width": 0.5, "height": 0.5, "scale": 1, "rotation": 0, "opacity": 0.4}},
                {"time_sec": 2, "transform": {"x": 0.8, "y": 0.7, "width": 0.8, "height": 0.8, "scale": 1.25, "rotation": 45, "opacity": 1}},
            ],
        },
        fitted_filter="scale=1920:1080,format=yuv420p",
        width=1920, height=1080, fps=60, duration=2, background_color="black",
    )
    assert "scale=w='max(2\\,trunc(1920*(if(" in graph
    assert ":eval=frame,format=rgba" in graph
    assert "geq=r='r(X,Y)':g='g(X,Y)':b='b(X,Y)':a='alpha(X,Y)*(if(lt(T" in graph
    assert "rotate=angle='(if(" in graph
    assert "overlay=x='W*(if(" in graph
    assert "eval=frame" in graph


def test_single_keyframe_holds_its_value_for_the_entire_clip():
    expr, animated = _overlay_keyframe_expr(
        [{"time_sec": 1, "transform": {"x": 0.75}}], "x", 0.5, 0, 3,
    )
    assert expr == "0.750000"
    assert animated is False


def test_alpha_webm_uses_libvpx_decoder_but_ordinary_video_keeps_default(monkeypatch, tmp_path):
    alpha = tmp_path / "overlay.webm"
    plain = tmp_path / "clip.mp4"
    monkeypatch.setitem(
        _overlay_video_decoder_args.__globals__,
        "ffprobe_streams",
        lambda *_args: {"streams": [{"codec_type": "video", "tags": {"alpha_mode": "1"}}]},
    )
    assert _overlay_video_decoder_args(alpha, tmp_path / "ffprobe.exe") == ["-c:v", "libvpx-vp9"]
    assert _overlay_video_decoder_args(plain, tmp_path / "ffprobe.exe") == []


def test_gif_is_treated_as_a_looping_animation_instead_of_a_still(tmp_path):
    assert _is_looping_animation_file(tmp_path / "sticker.gif") is True
    assert _is_looping_animation_file(tmp_path / "sticker.png") is False


def test_overlay_intermediate_steps_stay_out_of_export_directory(monkeypatch, tmp_path):
    work_dir = tmp_path / "work"
    export_dir = tmp_path / "exports"
    work_dir.mkdir()
    export_dir.mkdir()
    base = work_dir / "v1_concat.mp4"
    output = export_dir / "finished.mp4"
    base.touch()
    generated = []

    monkeypatch.setitem(
        _composite_overlays_on_base.__globals__,
        "probe_video_audio_summary",
        lambda *_args: {"duration": 5, "width": 1920, "height": 1080},
    )

    def fake_run(cmd, **_kwargs):
        target = Path(cmd[-1])
        target.touch()
        generated.append(target)
        return SimpleNamespace(returncode=0, stderr="", stdout="")

    monkeypatch.setitem(_composite_overlays_on_base.__globals__, "_run_ffmpeg_process", fake_run)
    overlays = [
        {"type": "text", "timeline_start": index, "duration": 1, "text": {"content": f"T{index}"}}
        for index in range(3)
    ]

    _composite_overlays_on_base(
        ffmpeg_bin=tmp_path / "ffmpeg.exe",
        ffprobe=tmp_path / "ffprobe.exe",
        base_mp4=base,
        overlay_clips=overlays,
        out_mp4=output,
        video_encode_quality=["-c:v", "libx264"],
    )

    intermediate = [path for path in generated if path.name.startswith("ov_step_")]
    assert intermediate
    assert all(path.parent == work_dir for path in intermediate)
    assert not list(export_dir.glob("ov_step_*.mp4"))
    assert output.is_file()


def test_export_preflight_reports_missing_overlay_audio_and_font_assets(tmp_path):
    base = tmp_path / "base.mp4"
    base.write_bytes(b"video")
    missing_audio = tmp_path / "missing.mp3"
    body = {
        "tracks": [
            {"id": "v1", "type": "video", "clips": [{"id": "base", "source_type": "file", "file_path": str(base)}]},
            {"id": "a1", "type": "audio", "clips": [{"id": "music", "source_type": "file", "file_path": str(missing_audio), "meta": {"kind": "audio"}}]},
        ],
        "overlays": [{"id": "title", "type": "text", "text": {"content": "ACE", "font_file": str(tmp_path / "missing.ttf")}}],
    }
    assert _first_missing_file_asset_for_export(body) == "missing.ttf"

    body["overlays"][0]["text"]["font_file"] = None
    assert _first_missing_file_asset_for_export(body) == "missing.mp3"
    assert _missing_file_assets_for_export(body) == [
        {"kind": "audio", "name": "missing.mp3", "path": str(missing_audio)},
    ]


@pytest.mark.parametrize("file_path", ["C:/assets/capture.mkv", "C:/assets/capture.m4v", "C:/assets/legacy.avi"])
def test_main_file_clip_accepts_supported_uploaded_video_containers(file_path):
    assert _is_main_file_clip({"source_type": "file", "file_path": file_path}) is True


def test_timeline_video_layer_keeps_clip_transform_for_export():
    transform = {"x": 0.72, "y": 0.28, "width": 0.44, "scale": 1.2, "rotation": 15, "opacity": 0.8}
    layer = _timeline_video_layer_clip({"id": "v2-clip", "transform": transform}, track_id="v2")
    assert layer["source_track_id"] == "v2"
    assert layer["transform"] == transform
    assert _map_transition_type("flash") == "flash"
    assert _map_transition_type("cut") == "cut"
    assert _map_transition_type("glitch") == "glitch"
    assert _map_transition_type("wipe_l") == "wipe_l"


def test_xfade_names_for_extended_transitions():
    assert _xfade_transition_name("glitch") == "pixelize"
    assert _xfade_transition_name("wipe_l") == "wipeleft"
    assert _xfade_transition_name("blur") == "hblur"
    assert _xfade_transition_name("spin") == "radial"


def test_cancellable_ffmpeg_process_raises_cancelled():
    cancel = threading.Event()
    cancel.set()
    with pytest.raises(MontageComposerError) as exc:
        _run_ffmpeg_process([sys.executable, "-c", "import time; time.sleep(10)"], cancel_event=cancel)
    assert exc.value.code == "MONTAGE_EXPORT_CANCELLED"


def test_color_preset_vf():
    vf = _build_color_vf({"filter_preset": "esports"})
    assert "saturation=1.35" in vf
    assert "contrast=1.12" in vf


def test_project_encoder_tier_defaults_to_quality_and_allows_fast():
    assert _project_encoder_tier({}) == "quality"
    assert _project_encoder_tier({"output": {"encoder_tier": "fast"}}) == "fast"
    assert _project_encoder_tier({"output": {"encoder_tier": "unexpected"}}) == "quality"


def test_color_preset_plus_user_sliders():
    vf = _build_color_vf({"filter_preset": "night", "brightness": 10, "contrast": 0, "saturation": 0})
    assert "hue=h=-8" in vf
    assert "rr=1.1000:gg=1.1000:bb=1.1000" in vf
    assert "brightness=" not in vf


def test_color_user_sliders_only():
    vf = _build_color_vf({"brightness": 20, "contrast": 15, "saturation": -10})
    assert vf.startswith("colorchannelmixer=")
    assert "rr=1.2000:gg=1.2000:bb=1.2000" in vf
    assert "contrast=1.1500:saturation=0.9000" in vf
    assert "brightness=" not in vf


def test_vintage_preset_matches_css_sepia_matrix_and_brightness_scale():
    vf = _build_color_vf({"filter_preset": "vintage"})
    assert "rr=0.66615:rg=0.42295:rb=0.10395" in vf
    assert "contrast=1.08" in vf
    assert "rr=0.95:gg=0.95:bb=0.95" in vf
    assert "saturation=0.85" not in vf


def test_v1_clips_sorted_by_timeline_start():
    body = {
        "tracks": [
            {
                "id": "v1",
                "type": "video",
                "clips": [
                    {"id": "b", "source_id": 2, "timeline_start": 10, "trim_in": 0, "trim_out": 5},
                    {"id": "a", "source_id": 1, "timeline_start": 0, "trim_in": 0, "trim_out": 8},
                ],
            }
        ]
    }
    clips = _v1_clips_sorted(body)
    assert [c["id"] for c in clips] == ["a", "b"]


def test_main_timeline_gap_plan_preserves_initial_and_internal_empty_ranges():
    clips = [
        {"timeline_start": 1.5, "trim_out": 3.5},
        {"timeline_start": 6.0, "trim_out": 8.0},
    ]
    assert _timeline_gap_plan(clips) == [(0, 1.5), (1, 1.0)]
    assert _timeline_gap_plan([
        {"timeline_start": 0, "trim_out": 4},
        {"timeline_start": 3.5, "trim_out": 6},
    ]) is None


def test_soft_transition_detection_distinguishes_boundaries_from_hard_cuts():
    clips = [{"timeline_start": 0, "trim_out": 4}, {"timeline_start": 6, "trim_out": 10}]
    assert _has_soft_positional_transition(clips, {"0": {"type": "fade", "duration": 0.4}}, 60) is True
    assert _has_soft_positional_transition(clips, {"0": {"type": "cut", "duration": 0}}, 60) is False


def test_boundary_transition_preserves_clip_timeline_length_and_supplies_silence():
    graph = _boundary_transition_filter_complex(
        transition_type="wipe_l",
        duration=0.5,
        previous_duration=6,
        next_duration=4,
        fps=60,
        previous_has_audio=False,
        next_has_audio=True,
    )
    assert "loop=loop=-1:size=1:start=0,setpts=N/60/TB,trim=duration=0.500000[hold]" in graph
    assert "[0:v]split=2[pvsrc][holdsrc]" in graph
    assert "[1:v]split=2[nintrosrc][ntailsrc]" in graph
    assert "xfade=transition=wipeleft:duration=0.500000:offset=0" in graph
    assert "[pv][xf][ntail]concat=n=3:v=1:a=0[vout]" in graph
    assert "anullsrc=r=48000:cl=stereo,atrim=0:6.000000" in graph
    assert "[pa][na]concat=n=2:v=0:a=1[aout]" in graph


def test_boundary_transition_keeps_requested_one_point_five_seconds_when_next_clip_allows_it():
    graph = _boundary_transition_filter_complex(
        transition_type="fade",
        duration=1.5,
        previous_duration=2.0,
        next_duration=3.0,
        fps=60,
        previous_has_audio=True,
        next_has_audio=True,
    )
    assert "loop=loop=-1:size=1:start=0,setpts=N/60/TB,trim=duration=1.500000[hold]" in graph
    assert "xfade=transition=fade:duration=1.500000:offset=0" in graph


def test_boundary_dip_black_reaches_a_true_black_midpoint_without_xfade_variation():
    graph = _boundary_transition_filter_complex(
        transition_type="dip_black",
        duration=1.0,
        previous_duration=2.0,
        next_duration=2.0,
        fps=30,
        previous_has_audio=True,
        next_has_audio=True,
    )
    assert "trim=start=1.500000:end=2.000000,setpts=PTS-STARTPTS,fade=t=out:st=0:d=0.500000:color=black[dipout]" in graph
    assert "trim=start=0.500000:end=1.000000" in graph
    assert "fade=t=in:st=0:d=0.500000:color=black[dipin]" in graph
    assert "[dipout][dipin]concat=n=2:v=1:a=0[xf]" in graph
    assert "xfade=transition=fadeblack" not in graph


def test_boundary_flash_reaches_a_true_white_midpoint_without_xfade_variation():
    graph = _boundary_transition_filter_complex(
        transition_type="flash",
        duration=1.0,
        previous_duration=2.0,
        next_duration=2.0,
        fps=30,
        previous_has_audio=True,
        next_has_audio=True,
    )
    assert "fade=t=out:st=0:d=0.500000:color=white[flashout]" in graph
    assert "fade=t=in:st=0:d=0.500000:color=white[flashin]" in graph
    assert "[flashout][flashin]concat=n=2:v=1:a=0[xf]" in graph
    assert "xfade=transition=fadewhite" not in graph


def test_clip_normalizer_keeps_slow_silent_clips_dual_stream_and_untruncated(monkeypatch, tmp_path):
    commands = []
    monkeypatch.setitem(_lite_cut_clip_to_ts.__globals__, "probe_video_audio_summary", lambda *_args: {"has_audio": False})
    monkeypatch.setitem(_lite_cut_clip_to_ts.__globals__, "resolve_ffprobe_binary", lambda _ffmpeg: tmp_path / "ffprobe.exe")
    monkeypatch.setitem(
        _lite_cut_clip_to_ts.__globals__,
        "_run_ffmpeg_process",
        lambda cmd, **_kwargs: commands.append(cmd) or SimpleNamespace(returncode=0, stderr="", stdout=""),
    )
    src = tmp_path / "silent.mp4"
    _lite_cut_clip_to_ts(
        ffmpeg_bin=tmp_path / "ffmpeg.exe",
        src=src,
        out_ts=tmp_path / "normalized.ts",
        clip={"trim_in": 2, "trim_out": 8, "speed": 0.5, "freeze_frame_sec": 2},
        width=1920,
        height=1080,
        fps=60,
        canvas_fit="contain",
        background_color="black",
        blur_amount=24,
        video_encode_quality=["-c:v", "libx264"],
    )

    cmd = commands[0]
    source_input = cmd.index(str(src))
    assert cmd[source_input - 3 : source_input] == ["-t", "6.000000", "-i"]
    assert "anullsrc=r=48000:cl=stereo" in cmd
    assert ["-map", "0:v:0", "-map", "1:a:0"] == cmd[cmd.index("-map") : cmd.index("-map") + 4]
    assert "14.100000" in cmd


def test_speed_ramp_uses_timeline_duration_for_video_fade_out():
    ramped_clip = {
        "trim_in": 0,
        "trim_out": 4,
        "speed_keyframes": [{"source_sec": 0, "speed": 0.5}, {"source_sec": 2, "speed": 2}],
        "fade_out_sec": 1,
    }
    visual_clip = {**ramped_clip, "speed": 1.0, "speed_keyframes": []}
    graph = _clip_video_filter_chain(
        visual_clip,
        width=1920,
        height=1080,
        fps=60,
        timeline_duration_override=_clip_timeline_duration_sec(ramped_clip),
    )
    assert "fade=t=out:st=4.000000:d=1.000000" in graph


def test_v1_hidden_track_is_not_exported():
    body = {
        "tracks": [
            {
                "id": "v1",
                "type": "video",
                "hidden": True,
                "clips": [{"id": "a", "source_id": 1, "timeline_start": 0, "trim_out": 8}],
            }
        ]
    }
    assert _v1_clips_sorted(body) == []


def test_v1_muted_track_mutes_clip_audio():
    body = {
        "tracks": [
            {
                "id": "v1",
                "type": "video",
                "muted": True,
                "clips": [{"id": "a", "source_id": 1, "timeline_start": 0, "trim_out": 8, "volume": 1}],
            }
        ]
    }
    clips = _v1_clips_sorted(body)
    assert clips[0]["muted"] is True
    assert _clip_volume(clips[0]) == 0.0


def test_track_gain_scales_clip_audio_and_automation_for_export():
    body = {
        "tracks": [
            {
                "id": "v1",
                "type": "video",
                "volume": 0.5,
                "clips": [{"id": "v", "source_id": 1, "timeline_start": 0, "trim_out": 8, "volume": 0.8, "audio_keyframes": [{"time_sec": 1, "volume": 1.2}]}],
            },
            {
                "id": "a1",
                "type": "audio",
                "volume": 0.25,
                "clips": [{"id": "a", "source_type": "file", "file_path": "C:/audio.mp3", "volume": 1.0, "audio_keyframes": [{"time_sec": 0, "volume": 0.8}], "meta": {"kind": "audio"}}],
            },
        ]
    }
    _, video = _base_video_track_for_export(body)
    audio = _audio_track_clips_for_export(body)
    assert video[0]["volume"] == 0.4
    assert video[0]["audio_keyframes"][0]["volume"] == 0.6
    assert audio[0]["volume"] == 0.25
    assert audio[0]["audio_keyframes"][0]["volume"] == 0.2


def test_solo_audio_track_mutes_main_video_audio_and_filters_audio_tracks():
    body = {
        "tracks": [
            {"id": "v1", "type": "video", "clips": [{"id": "v", "source_id": 1, "timeline_start": 0, "trim_out": 8}]},
            {"id": "a1", "type": "audio", "solo": True, "clips": [{"id": "solo", "source_type": "file", "file_path": "C:/solo.mp3", "meta": {"kind": "audio"}}]},
            {"id": "a2", "type": "audio", "clips": [{"id": "other", "source_type": "file", "file_path": "C:/other.mp3", "meta": {"kind": "audio"}}]},
        ]
    }
    assert _has_solo_audio_tracks(body) is True
    assert _v1_clips_sorted(body)[0]["muted"] is True
    assert [clip["id"] for clip in _audio_track_clips_for_export(body)] == ["solo"]


def test_build_transitions_uses_source_id():
    clips = [
        {"source_id": 42, "transition_out": {"type": "fade", "duration_sec": 0.5}},
    ]
    tr = _build_transitions(clips)
    assert tr["42"]["type"] == "fade"
    assert tr["42"]["duration"] == 0.5


def test_clip_duration_from_trim():
    clip = {"trim_in": 1.0, "trim_out": 6.5, "meta": {"duration_sec": 20}}
    assert abs(_clip_duration_sec(clip) - 5.5) < 1e-6


def test_clip_speed_and_volume_are_bounded():
    assert _clip_speed({"speed": 2.5}) == 2.5
    assert _clip_speed({"speed": 12}) == 4.0
    assert _clip_speed({"speed": 0.01}) == 0.25
    assert _clip_preserve_pitch({}) is True
    assert _clip_preserve_pitch({"preserve_pitch": False}) is False
    assert _clip_reverse({"reverse": True}) is True
    assert _clip_reverse({"reverse": False}) is False
    assert _clip_volume({"volume": 0.35}) == 0.35
    assert _clip_volume({"volume": 8}) == 5.0
    assert _clip_volume({"volume": 1, "muted": True}) == 0.0
    assert _clip_freeze_frame_sec({"freeze_frame_sec": 1.25}) == 1.25
    assert _clip_freeze_frame_sec({"freeze_frame_sec": 99}) == 30.0


def test_piecewise_speed_ramp_uses_source_time_and_changes_timeline_duration():
    clip = {
        "trim_in": 2,
        "trim_out": 12,
        "speed": 1,
        "speed_keyframes": [
            {"source_sec": 2, "speed": 0.5},
            {"source_sec": 6, "speed": 2},
            {"source_sec": 12, "speed": 2},
        ],
    }
    assert _clip_speed_keyframes(clip) == [(2.0, 0.5), (6.0, 2.0), (12.0, 2.0)]
    assert _clip_speed_segments(clip) == [(2.0, 6.0, 0.5), (6.0, 12.0, 2.0)]
    assert _clip_timeline_duration_sec(clip) == 11.0


def test_speed_ramp_audio_mix_and_video_overlay_build_concat_graphs():
    clip = {
        "timeline_start": 1,
        "trim_in": 0,
        "trim_out": 8,
        "speed_keyframes": [
            {"source_sec": 0, "speed": 0.5},
            {"source_sec": 4, "speed": 2},
            {"source_sec": 8, "speed": 2},
        ],
    }
    audio_graph = _audio_mix_filter_complex(has_base_audio=False, audio_clips=[clip])
    assert "atrim=start=0.000000:end=4.000000" in audio_graph
    assert "concat=n=2:v=0:a=1[arr1]" in audio_graph
    overlay_graph = _overlay_filter_complex(
        enable_expr="between(t,1,7)",
        timeline_start=1,
        duration=7,
        tx=0.5,
        ty=0.5,
        size_frac=1,
        rotation=0,
        video_input=True,
        speed_segments=[(0, 4, 0.5), (4, 8, 2)],
    )
    assert "concat=n=2:v=1:a=0[ovramp]" in overlay_graph
    assert "[ovramp]format=rgba" in overlay_graph


def test_audio_track_mix_trims_uploaded_source_before_delay_and_effects():
    graph = _audio_mix_filter_complex(
        has_base_audio=False,
        audio_clips=[
            {
                "timeline_start": 3,
                "trim_in": 1.5,
                "trim_out": 5.25,
                "volume": 0.8,
                "meta": {"kind": "audio"},
            }
        ],
    )
    assert "[1:a]atrim=start=1.500000:end=5.250000,asetpts=PTS-STARTPTS" in graph
    assert "adelay=3000:all=1" in graph


def test_audio_mix_passes_full_source_to_filter_to_avoid_double_trim(monkeypatch, tmp_path):
    base = tmp_path / "base.mp4"
    audio = tmp_path / "voice.wav"
    output = tmp_path / "mixed.mp4"
    base.write_bytes(b"base")
    audio.write_bytes(b"audio")
    commands = []
    monkeypatch.setitem(_mix_audio_tracks_on_base.__globals__, "probe_video_audio_summary", lambda *_args: {"has_audio": True})
    monkeypatch.setitem(
        _mix_audio_tracks_on_base.__globals__,
        "_run_ffmpeg_process",
        lambda cmd, **_kwargs: commands.append(cmd) or SimpleNamespace(returncode=0, stderr="", stdout=""),
    )

    _mix_audio_tracks_on_base(
        ffmpeg_bin=tmp_path / "ffmpeg.exe",
        ffprobe=tmp_path / "ffprobe.exe",
        base_mp4=base,
        audio_clips=[{"file_path": str(audio), "trim_in": 1.5, "trim_out": 5.25, "timeline_start": 3}],
        out_mp4=output,
    )

    assert commands
    command = commands[0]
    assert command.count("-i") == 2
    assert "-ss" not in command
    graph = command[command.index("-filter_complex") + 1]
    assert "[1:a]atrim=start=1.500000:end=5.250000" in graph


def test_clip_canvas_fit_uses_clip_override_or_project_fallback():
    assert _clip_canvas_fit({"canvas_fit": "cover"}, "contain") == "cover"
    assert _clip_canvas_fit({"canvas_fit": "blur"}, "cover") == "blur"
    assert _clip_canvas_fit({"canvas_fit": "inherit"}, "cover") == "cover"
    assert _clip_canvas_fit({"canvas_fit": "bad"}, "bad") == "contain"


def test_project_master_volume_is_bounded():
    assert _project_master_volume({"audio": {"master_volume": 0.35}}) == 0.35
    assert _project_master_volume({"audio": {"master_volume": -2}}) == 0.0
    assert _project_master_volume({"audio": {"master_volume": 8}}) == 2.0
    assert _project_master_volume({"audio": {"master_volume": "bad"}}) == 1.0


def test_project_output_settings_use_body_with_bounds():
    ref = {"width": 1280, "height": 720, "fps": 59.94}
    assert _project_output_settings({}, ref) == (1280, 720, 59.94)
    assert _project_output_settings({"output": {"width": 3840, "height": 2160, "fps": 30}}, ref) == (3840, 2160, 30.0)
    assert _project_output_settings({"output": {"width": 12, "height": 9000, "fps": 999}}, ref) == (320, 4320, 240.0)
    assert _project_output_settings({"output": {"width": "bad", "height": "bad", "fps": "bad"}}, ref) == (1280, 720, 59.94)


def test_project_canvas_settings_are_bounded():
    assert _project_canvas_settings({}) == ("contain", "black", 24)
    assert _project_canvas_settings({"output": {"canvas_fit": "cover", "background_color": "#f0a", "blur_amount": 99}}) == (
        "cover",
        "0xff00aa",
        80,
    )
    assert _project_canvas_settings({"output": {"canvas_fit": "bad", "background_color": "nope", "blur_amount": 1}}) == (
        "contain",
        "black",
        4,
    )


def test_project_export_range_defaults_to_full_and_bounds_custom():
    assert _project_export_range({}) == (0.0, None)
    assert _project_export_range({"output": {"range_mode": "full", "range_start_sec": 4, "range_end_sec": 8}}) == (0.0, None)
    assert _project_export_range({"output": {"range_mode": "custom", "range_start_sec": 2.5, "range_end_sec": 8}}) == (2.5, 8.0)
    assert _project_export_range({"output": {"range_mode": "custom", "range_start_sec": -2, "range_end_sec": 3}}) == (0.0, 3.0)
    assert _project_export_range({"output": {"range_mode": "custom", "range_start_sec": 8, "range_end_sec": 4}}) == (8.0, None)


def test_empty_project_output_preserves_canvas_settings():
    project = empty_project().model_dump(mode="json")
    assert project["output"]["canvas_fit"] == "contain"
    assert project["output"]["background_color"] == "#000000"
    assert project["output"]["blur_amount"] == 24
    assert project["output"]["range_mode"] == "full"
    assert project["output"]["range_start_sec"] == 0.0
    assert project["output"]["range_end_sec"] is None


def test_clip_audio_fade_is_bounded_to_clip_duration():
    clip = {"trim_in": 2, "trim_out": 5, "fade_in_sec": 12, "fade_out_sec": -1}
    assert _clip_audio_fade(clip, "fade_in_sec") == 3
    assert _clip_audio_fade(clip, "fade_out_sec") == 0.0


def test_clip_visual_fade_is_bounded_to_clip_duration():
    clip = {"timeline_start": 1, "duration": 2.5, "fade_in_sec": 9, "fade_out_sec": 0.75}
    assert _clip_visual_fade(clip, "fade_in_sec") == 2.5
    assert _clip_visual_fade(clip, "fade_out_sec") == 0.75


def test_clip_video_fade_uses_timeline_duration_after_speed():
    clip = {"trim_in": 0, "trim_out": 6, "speed": 2, "fade_in_sec": 9, "fade_out_sec": 1}
    assert _clip_timeline_duration_sec(clip) == 3
    assert _clip_video_fade(clip, "fade_in_sec") == 3
    assert _clip_video_fade(clip, "fade_out_sec") == 1


def test_video_and_audio_filters_append_final_frame_hold():
    vf = _clip_video_filter_chain({"trim_in": 0, "trim_out": 3, "freeze_frame_sec": 1.5}, width=1920, height=1080, fps=60)
    assert "tpad=stop_mode=clone:stop_duration=1.500000" in vf
    assert "apad=pad_dur=1.500000" in _audio_filter_chain(1, 1, freeze_frame_sec=1.5)


def test_audio_filter_chain_combines_speed_and_volume():
    chain = _audio_filter_chain(4.0, 0.5)
    assert chain == "atempo=2.000000,atempo=2.000000,volume=0.500000"


def test_clip_volume_filter_interpolates_audio_keyframes():
    value = _clip_volume_filter({"trim_in": 0, "trim_out": 6, "audio_keyframes": [{"time_sec": 0, "volume": 0.2}, {"time_sec": 3, "volume": 1.0}, {"time_sec": 6, "volume": 0.4}]})
    assert value.startswith("volume='if(lt(t\\,3.000000)")
    assert "(t-0.000000)/3.000000" in value
    assert "eval=frame" in value


def test_audio_filter_chain_supports_reverse():
    chain = _audio_filter_chain(2.0, 0.5, reverse=True)
    assert chain == "areverse,atempo=2.000000,volume=0.500000"


def test_audio_filter_chain_can_pitch_shift_with_speed():
    chain = _audio_filter_chain(2.0, 0.5, preserve_pitch=False)
    assert chain == "aresample=48000,asetrate=96000.000000,aresample=48000,volume=0.500000"


def test_audio_mix_filter_applies_speed_to_extra_audio_tracks():
    chain = _audio_mix_filter_complex(
        has_base_audio=False,
        audio_clips=[
            {
                "id": "detached",
                "timeline_start": 1,
                "trim_in": 0,
                "trim_out": 8,
                "speed": 2,
                "preserve_pitch": False,
                "reverse": True,
                "volume": 0.5,
                "fade_out_sec": 1,
            }
        ],
    )
    assert "areverse,aresample=48000,asetrate=96000.000000,aresample=48000" in chain
    assert "atempo=2.000000" not in chain
    assert "volume=0.500000" in chain
    assert "afade=t=out:st=3.000000:d=1.000000" in chain
    assert "adelay=1000:all=1" in chain


def test_clip_video_filter_chain_applies_visual_fades_after_speed():
    vf = _clip_video_filter_chain(
        {"trim_in": 0, "trim_out": 6, "speed": 2, "fade_in_sec": 0.5, "fade_out_sec": 1},
        width=1920,
        height=1080,
        fps=60,
    )
    assert "setpts=PTS/2.000000,fade=t=in:st=0:d=0.500000" in vf
    assert "fade=t=out:st=2.000000:d=1.000000" in vf


def test_clip_video_filter_chain_supports_reverse_before_speed_and_fades():
    vf = _clip_video_filter_chain(
        {"trim_in": 0, "trim_out": 6, "speed": 2, "reverse": True, "fade_in_sec": 0.5},
        width=1920,
        height=1080,
        fps=60,
    )
    assert "format=yuv420p,reverse,setpts=PTS/2.000000,fade=t=in:st=0:d=0.500000" in vf


def test_clip_video_filter_chain_applies_horizontal_and_vertical_flips():
    vf = _clip_video_filter_chain(
        {"flip_horizontal": True, "flip_vertical": True},
        width=1920,
        height=1080,
        fps=60,
    )
    assert "format=yuv420p,hflip,vflip" in vf


def test_clip_video_filter_chain_applies_normalized_crop_before_canvas_fit():
    vf = _clip_video_filter_chain(
        {"crop": {"x": 0.2, "y": 0.1, "width": 0.5, "height": 0.75}},
        width=1280,
        height=720,
        fps=30,
    )
    assert vf.startswith("crop=iw*0.500000:ih*0.750000:iw*0.200000:ih*0.100000,")


def test_clip_video_filter_chain_clamps_crop_to_source_bounds():
    vf = _clip_video_filter_chain(
        {"crop": {"x": 0.9, "y": -1, "width": 0.4, "height": 2}},
        width=1280,
        height=720,
        fps=30,
    )
    assert vf.startswith("crop=iw*0.400000:ih*1.000000:iw*0.600000:ih*0.000000,")


def test_clip_video_filter_chain_uses_project_render_settings():
    vf = _clip_video_filter_chain({}, width=1280, height=720, fps=30, background_color="0x112233")
    assert "scale=1280:720:force_original_aspect_ratio=decrease" in vf
    assert "pad=1280:720:(ow-iw)/2:(oh-ih)/2:color=0x112233" in vf
    assert "fps=30" in vf


def test_clip_video_filter_chain_supports_cover_and_blur_canvas_modes():
    cover = _clip_video_filter_chain({}, width=1280, height=720, fps=30, canvas_fit="cover")
    assert "force_original_aspect_ratio=increase" in cover
    assert "crop=1280:720" in cover
    assert "pad=" not in cover

    blur = _clip_video_filter_chain({}, width=1280, height=720, fps=30, canvas_fit="blur", blur_amount=18)
    assert "split=2[fg][bg]" in blur
    assert "gblur=sigma=18" in blur
    assert "[bgfit][fgfit]overlay=(W-w)/2:(H-h)/2" in blur


def test_clip_video_filter_chain_uses_clip_canvas_fit_override():
    vf = _clip_video_filter_chain(
        {"canvas_fit": "cover"},
        width=1280,
        height=720,
        fps=30,
        canvas_fit="contain",
    )
    assert "force_original_aspect_ratio=increase" in vf
    assert "crop=1280:720" in vf
    assert "pad=" not in vf


def test_audio_track_clips_for_export():
    body = {
        "tracks": [
            {"id": "v1", "type": "video", "clips": []},
            {
                "id": "a1",
                "type": "audio",
                "clips": [
                    {
                        "id": "aud",
                        "source_type": "file",
                        "file_path": "C:/x/bgm.mp3",
                        "timeline_start": 3,
                        "trim_out": 10,
                    }
                ],
            },
            {
                "id": "a2",
                "type": "audio",
                "hidden": True,
                "clips": [
                    {
                        "id": "hidden-aud",
                        "source_type": "file",
                        "file_path": "C:/x/hidden.mp3",
                        "timeline_start": 1,
                        "trim_out": 4,
                    }
                ],
            },
        ]
    }
    clips = _audio_track_clips_for_export(body)
    assert [c["id"] for c in clips] == ["aud"]
    assert _is_audio_file_clip(clips[0])


def test_video_layer_audio_is_mixed_with_track_gain_and_recording_path(tmp_path):
    recording = tmp_path / "angle.mp4"
    recording.write_bytes(b"video")
    body = {
        "tracks": [
            {"id": "v1", "type": "video", "volume": 0.5, "clips": [{"id": "angle", "source_type": "recorded_clip", "source_id": 9, "volume": 1.2}]},
            {"id": "v2", "type": "video", "clips": [{"id": "base", "source_type": "file", "file_path": str(recording)}]},
            {"id": "v3", "type": "video", "hidden": True, "clips": [{"id": "hidden", "source_type": "recorded_clip", "source_id": 10}]},
        ],
    }

    layer_audio = _video_layer_audio_clips_for_export(body, base_track_id="v2")
    assert layer_audio == [{"id": "angle", "source_type": "recorded_clip", "source_id": 9, "volume": 0.6}]
    assert _resolve_audio_clip_paths(layer_audio, {9: recording}) == [
        {"id": "angle", "source_type": "recorded_clip", "source_id": 9, "volume": 0.6, "file_path": str(recording)},
    ]


def test_project_bgm_clip_for_export_maps_audio_config():
    clip = _project_bgm_clip_for_export(
        {
            "audio": {
                "bgm": {
                    "path": "C:/x/theme.mp3",
                    "name": "theme.mp3",
                    "asset_id": 9,
                    "duration_sec": 12.5,
                    "volume": 0.35,
                    "start_sec": 2.25,
                    "fade_in_sec": 0.5,
                    "fade_out_sec": 1.0,
                }
            }
        }
    )
    assert clip["id"] == "project-bgm"
    assert clip["file_path"] == "C:/x/theme.mp3"
    assert clip["timeline_start"] == 2.25
    assert clip["volume"] == 0.35
    assert clip["fade_in_sec"] == 0.5
    assert clip["fade_out_sec"] == 1.0
    assert clip["meta"]["asset_id"] == 9
    assert clip["meta"]["duration_sec"] == 12.5
    assert _is_audio_file_clip(clip)
    fc = _audio_mix_filter_complex(has_base_audio=False, audio_clips=[clip])
    assert "volume=0.350000" in fc
    assert "afade=t=in:st=0:d=0.500000" in fc
    assert "afade=t=out:st=11.500000:d=1.000000" in fc


def test_audio_mix_filter_ducks_project_bgm_under_foreground_audio():
    fc = _audio_mix_filter_complex(
        has_base_audio=True,
        audio_clips=[
            {"timeline_start": 0, "volume": 1, "meta": {"kind": "audio"}},
            {
                "timeline_start": 0,
                "volume": 0.6,
                "meta": {"kind": "audio", "project_bgm": True, "ducking_enabled": True, "ducking_volume": 0.3},
            },
        ],
    )
    assert "sidechaincompress=" in fc
    assert "[duckside]" in fc
    assert "adelay=0:all=1[a1]" in fc


def test_audio_mix_filter_delays_timeline_audio():
    fc = _audio_mix_filter_complex(
        has_base_audio=True,
        audio_clips=[
            {"timeline_start": 1.25, "volume": 0.5},
            {"timeline_start": 0, "volume": 1.0},
        ],
    )
    assert "[0:a]asetpts=PTS-STARTPTS[basea]" in fc
    assert "adelay=1250:all=1[a1]" in fc
    assert "volume=0.500000" in fc
    assert "amix=inputs=3" in fc


def test_audio_mix_filter_applies_master_volume_to_base_only():
    fc = _audio_mix_filter_complex(
        has_base_audio=True,
        audio_clips=[],
        master_volume=0.4,
    )
    assert "[0:a]asetpts=PTS-STARTPTS[basea]" in fc
    assert "[basea]anull[premaster]" in fc
    assert "[premaster]volume=0.400000[mixa]" in fc


def test_audio_mix_filter_applies_mute_and_fades():
    fc = _audio_mix_filter_complex(
        has_base_audio=False,
        audio_clips=[
            {
                "timeline_start": 0.5,
                "trim_in": 0,
                "trim_out": 4,
                "volume": 1,
                "muted": True,
                "fade_in_sec": 0.5,
                "fade_out_sec": 1.25,
            },
        ],
    )
    assert "volume=0.000000" in fc
    assert "afade=t=in:st=0:d=0.500000" in fc
    assert "afade=t=out:st=2.750000:d=1.250000" in fc
    assert "adelay=500:all=1[a1]" in fc


def test_overlay_layout_matches_preview_defaults():
    tx, ty, size, rot = _overlay_layout_from_transform({})
    assert tx == 0.5
    assert ty == 0.5
    assert abs(size - 0.33 * 0.38) < 1e-6
    assert rot == 0.0


def test_overlay_layout_width_and_scale():
    tx, ty, size, rot = _overlay_layout_from_transform(
        {"x": 0.2, "y": 0.8, "width": 0.4, "scale": 0.5, "rotation": 45}
    )
    assert tx == 0.2
    assert ty == 0.8
    assert abs(size - 0.2) < 1e-6
    assert rot == 45.0


def test_overlay_height_and_filter_support_non_uniform_export():
    height = _overlay_height_from_transform({"height": 0.4, "scale": 0.5})
    assert height == 0.2
    assert _overlay_height_from_transform({"width": 0.4, "scale": 0.5}) is None

    fc = _overlay_filter_complex(
        enable_expr="between(t,0,3)",
        timeline_start=0,
        duration=3,
        tx=0.5,
        ty=0.5,
        size_frac=0.3,
        height_frac=height,
        rotation=0,
        video_input=False,
    )
    assert "w='1920*(0.300000)'" in fc
    assert "h='1080*(0.200000)'" in fc
    assert "force_original_aspect_ratio" not in fc


def test_overlay_opacity_is_bounded():
    assert _overlay_opacity_from_transform({"opacity": 0.35}) == 0.35
    assert _overlay_opacity_from_transform({"opacity": 8}) == 1.0
    assert _overlay_opacity_from_transform({"opacity": -1}) == 0.0


def test_overlay_filter_uses_center_anchor():
    fc = _overlay_filter_complex(
        enable_expr="between(t,0,3)",
        timeline_start=0,
        duration=3,
        tx=0.5,
        ty=0.5,
        size_frac=0.125,
        rotation=0,
        video_input=False,
    )
    assert "main_w*0.500000-w/2" in fc
    assert "main_h*0.500000-h/2" in fc
    assert "scale=w='1920*(0.125000)'" in fc
    assert "[0:v]null[vbase]" in fc
    assert "[vbase][ov]overlay=" in fc


def test_overlay_keyframes_generate_linear_export_expressions():
    keyframes = [
        {"time_sec": 0, "transform": {"x": 0.1, "y": 0.2, "width": 0.25, "scale": 1, "rotation": 0}},
        {"time_sec": 2, "transform": {"x": 0.9, "y": 0.8, "width": 0.5, "scale": 2, "rotation": 90}},
    ]
    x_expr, dynamic_x = _overlay_keyframe_expr(keyframes, "x", 0.5, 3, 2)
    size_expr, dynamic_size = _overlay_keyframe_expr(keyframes, "size", 0.33, 3, 2)
    assert dynamic_x is True and "t-3.000000" in x_expr and "0.900000" in x_expr
    assert dynamic_size is True and "1.000000" in size_expr
    fc = _overlay_filter_complex(
        enable_expr="between(t,3,5)", timeline_start=3, duration=2, tx=0.5, ty=0.5, size_frac=0.33, rotation=0,
        video_input=False, keyframes=keyframes,
    )
    assert "eval=frame" in fc
    assert "rotate='(" in fc
    assert "main_w*(if(" in fc


def test_overlay_filter_applies_opacity():
    fc = _overlay_filter_complex(
        enable_expr="between(t,0,3)",
        timeline_start=0,
        duration=3,
        tx=0.5,
        ty=0.5,
        size_frac=0.125,
        rotation=0,
        opacity=0.42,
        video_input=False,
    )
    assert "colorchannelmixer=aa=0.420000" in fc


def test_overlay_filter_applies_horizontal_and_vertical_flips():
    fc = _overlay_filter_complex(
        enable_expr="between(t,0,3)",
        timeline_start=0,
        duration=3,
        tx=0.5,
        ty=0.5,
        size_frac=0.125,
        rotation=0,
        video_input=True,
        flip_horizontal=True,
        flip_vertical=True,
    )
    assert "[ovbase]hflip,vflip[ovflip]" in fc


def test_overlay_wipe_uses_an_alpha_reveal_without_sliding_the_overlay_box():
    fc = _overlay_filter_complex(
        enable_expr="between(t,0,2)",
        timeline_start=0,
        duration=2,
        tx=0.5,
        ty=0.5,
        size_frac=0.5,
        height_frac=0.4,
        rotation=0,
        video_input=False,
        transition_in={"type": "wipe_l", "duration_sec": 1.0},
    )
    assert "geq=r='r(X,Y)':g='g(X,Y)':b='b(X,Y)'" in fc
    assert "alpha(X,Y)*lte(X/W\\,clip((T-0.000000)/1.000000" in fc
    assert "main_w*((0.500000)-(1-" not in fc


def test_overlay_slide_uses_its_own_box_size_instead_of_the_full_canvas():
    fc = _overlay_filter_complex(
        enable_expr="between(t,0,2)",
        timeline_start=0,
        duration=2,
        tx=0.5,
        ty=0.5,
        size_frac=0.46,
        height_frac=0.34,
        rotation=0,
        video_input=False,
        transition_in={"type": "slide_up", "duration_sec": 1.0},
    )
    assert "(0.500000)+((1-(clip((t-0.000000)/1.000000" in fc
    assert "*(0.340000)" in fc


def test_video_layer_overlay_filter_keeps_source_color_and_reverse_processing():
    fc = _overlay_filter_complex(
        enable_expr="between(t,0,3)",
        timeline_start=0,
        duration=3,
        tx=0.5,
        ty=0.5,
        size_frac=1,
        rotation=0,
        video_input=True,
        source_filters=["eq=contrast=1.1200:saturation=1.3500"],
        reverse=True,
    )
    assert "[1:v]eq=contrast=1.1200:saturation=1.3500,reverse,format=rgba" in fc


def test_overlay_filter_applies_visual_fades():
    fc = _overlay_filter_complex(
        enable_expr="between(t,1,4)",
        timeline_start=1,
        duration=3,
        tx=0.5,
        ty=0.5,
        size_frac=0.125,
        rotation=0,
        fade_in=0.5,
        fade_out=0.75,
        video_input=False,
    )
    assert "setpts=PTS-STARTPTS+1.000000/TB" in fc
    assert "fade=t=in:st=1.000000:d=0.500000:alpha=1" in fc
    assert "fade=t=out:st=3.250000:d=0.750000:alpha=1" in fc


def test_overlay_filter_interpolates_keyframed_opacity():
    fc = _overlay_filter_complex(
        enable_expr="between(t,1,5)",
        timeline_start=1,
        duration=4,
        tx=0.5,
        ty=0.5,
        size_frac=0.5,
        rotation=0,
        opacity=1,
        video_input=False,
        keyframes=[
            {"time_sec": 0, "transform": {"opacity": 0.2}},
            {"time_sec": 4, "transform": {"opacity": 0.8}},
        ],
    )
    assert "geq=r='r(X,Y)':g='g(X,Y)':b='b(X,Y)':a='alpha(X,Y)*(if(lt(T\\,5.000000)" in fc
    assert "(T-1.000000)/4.000000" in fc


def test_overlay_filter_applies_video_speed_to_pts():
    fc = _overlay_filter_complex(
        enable_expr="between(t,1,3)",
        timeline_start=1,
        duration=2,
        tx=0.5,
        ty=0.5,
        size_frac=1,
        rotation=0,
        video_input=True,
        speed=2,
    )
    assert "setpts=(PTS-STARTPTS)/2.000000+1.000000/TB" in fc


def test_schema_text_overlay_is_exportable():
    body = {
        "overlays": [
            {
                "id": "txt",
                "type": "text",
                "timeline_start": 1.5,
                "duration": 2.5,
                "fade_in_sec": 0.3,
                "fade_out_sec": 0.4,
                "transform": {"x": 0.4, "y": 0.2, "scale": 1.1},
                "text": {"content": "ACE", "font_size": 64, "preset_id": "ace"},
            }
        ]
    }
    overlays = _schema_overlay_clips(body)
    assert len(overlays) == 1
    assert overlays[0]["type"] == "text"
    assert overlays[0]["timeline_start"] == 1.5
    assert overlays[0]["trim_out"] == 2.5
    assert overlays[0]["fade_in_sec"] == 0.3
    assert overlays[0]["fade_out_sec"] == 0.4


def test_schema_file_overlay_preserves_source_trim():
    body = {
        "overlays": [
            {
                "id": "ov-webm",
                "type": "webm",
                "asset_path": "C:/x/sticker.webm",
                "timeline_start": 3,
                "duration": 3.5,
                "trim_in": 5.5,
                "fade_in_sec": 0.2,
                "fade_out_sec": 0.4,
                "transform": {"x": 0.4, "y": 0.6},
                "meta": {"kind": "webm", "duration_sec": 20},
            }
        ]
    }
    overlays = _schema_overlay_clips(body)
    assert len(overlays) == 1
    assert overlays[0]["type"] == "file"
    assert overlays[0]["trim_in"] == 5.5
    assert overlays[0]["trim_out"] == 9.0
    assert overlays[0]["duration"] == 3.5
    assert overlays[0]["meta"]["kind"] == "webm"
    assert _clip_duration_sec(overlays[0]) == 3.5


def test_hidden_overlay_track_is_not_exported():
    body = {
        "tracks": [
            {
                "id": "v2",
                "type": "video",
                "hidden": True,
                "clips": [
                    {
                        "id": "ov",
                        "source_type": "file",
                        "file_path": "C:/x/sticker.png",
                        "timeline_start": 0,
                        "trim_out": 3,
                    }
                ],
            }
        ]
    }
    assert _overlay_track_clips(body) == []


def test_hidden_schema_overlay_track_is_not_exported():
    body = {
        "overlay_tracks": [
            {"id": "ot1", "label": "Text 1", "hidden": True},
            {"id": "ot2", "label": "Text 2", "hidden": False},
        ],
        "overlays": [
            {
                "id": "hidden-title",
                "type": "text",
                "timeline_start": 0,
                "duration": 3,
                "text": {"content": "hidden"},
                "meta": {"overlay_track_id": "ot1"},
            },
            {
                "id": "visible-title",
                "type": "text",
                "timeline_start": 0,
                "duration": 3,
                "text": {"content": "visible"},
                "meta": {"overlay_track_id": "ot2"},
            },
        ],
    }
    overlays = _schema_overlay_clips(body)
    assert len(overlays) == 1
    assert overlays[0]["text"]["content"] == "visible"


def test_drawtext_filter_uses_center_anchor_and_escapes_text():
    fc = _drawtext_filter_complex(
        text_clip={
            "type": "text",
            "transform": {"x": 0.25, "y": 0.75, "scale": 1, "opacity": 0.5},
            "text": {"content": "A:B's 100%", "font_size": 48, "preset_id": "clutch"},
        },
        enable_expr="between(t,1,4)",
    )
    assert "drawtext=" in fc
    assert "A\\:B\\'s 100\\%" in fc
    assert "w*0.250000-text_w/2" in fc
    assert "h*0.750000-text_h/2" in fc
    assert "fontcolor=0x67e8f9" in fc
    assert "alpha='0.500000'" in fc


def test_drawtext_filter_applies_visual_fades():
    fc = _drawtext_filter_complex(
        text_clip={
            "type": "text",
            "timeline_start": 1,
            "duration": 3,
            "fade_in_sec": 0.5,
            "fade_out_sec": 0.75,
            "transform": {"x": 0.25, "y": 0.75, "scale": 1, "opacity": 0.8},
            "text": {"content": "ACE", "font_size": 48, "preset_id": "clutch"},
        },
        enable_expr="between(t,1,4)",
    )
    assert "alpha='if(gt(t\\,3.250000)\\,0.800000*(4.000000-t)/0.750000\\,if(lt(t\\,1.500000)" in fc


def test_drawtext_filter_applies_text_animation_expressions():
    fc = _drawtext_filter_complex(
        text_clip={
            "type": "text",
            "timeline_start": 2,
            "duration": 4,
            "transform": {"x": 0.5, "y": 0.3, "scale": 1, "opacity": 1},
            "text": {
                "content": "CLUTCH",
                "font_size": 48,
                "preset_id": "clutch",
                "anim_in": "slide_left",
                "anim_out": "fade",
            },
        },
        enable_expr="between(t,2,6)",
    )
    assert "x='if(lt(t\\,2.450000)\\,w*0.500000-text_w/2+w*0.120000*(1-(t-2.000000)/0.450000)" in fc
    assert "alpha='if(gt(t\\,5.550000)\\,1.000000*(6.000000-t)/0.450000\\,1.000000)'" in fc


def test_drawtext_filter_applies_clip_transition_timing_and_slide_position():
    fc = _drawtext_filter_complex(
        text_clip={
            "type": "text",
            "timeline_start": 2,
            "duration": 4,
            "transform": {"x": 0.5, "y": 0.3, "scale": 1, "opacity": 1},
            "transition_in": {"type": "slide_left", "duration_sec": 0.6},
            "transition_out": {"type": "wipe_l", "duration_sec": 0.5},
            "text": {"content": "CLUTCH", "font_size": 48},
        },
        enable_expr="between(t,2,6)",
    )
    assert "x='if(lt(t\\,2.600000)\\,w*0.500000-text_w/2+w*0.120000*(1-(t-2.000000)/0.600000)" in fc
    assert "alpha='if(gt(t\\,5.500000)\\,1.000000*(6.000000-t)/0.500000\\,1.000000)'" in fc


def test_drawtext_filter_uses_custom_font_file():
    fc = _drawtext_filter_complex(
        text_clip={
            "type": "text",
            "transform": {"x": 0.5, "y": 0.5},
            "text": {
                "content": "ACE",
                "font_file": "C:/Users/Dream/AppData/Roaming/CS2Insight/lite_cut_assets/frag font.ttf",
                "font_size": 48,
            },
        },
        enable_expr="between(t,0,3)",
    )
    assert "fontfile='C\\:/Users/Dream/AppData/Roaming/CS2Insight/lite_cut_assets/frag font.ttf'" in fc


def test_custom_font_is_staged_to_ascii_only_path(tmp_path):
    source_dir = tmp_path / "未命名工程"
    source_dir.mkdir()
    source = source_dir / "导入字体.ttf"
    source.write_bytes(b"test-font-bytes")
    cache_dir = tmp_path / "font-cache"

    staged = _stage_custom_font_for_ffmpeg(str(source), cache_dir=cache_dir)

    try:
        str(staged).encode("ascii")
        assert staged.parent == cache_dir
        assert staged.suffix == ".ttf"
        assert staged.read_bytes() == b"test-font-bytes"
    finally:
        staged.unlink(missing_ok=True)


def test_v1_main_clips_include_uploaded_video_on_v1():
    body = {
        "tracks": [
            {
                "id": "v1",
                "clips": [
                    {"id": "a", "source_type": "recorded_clip", "source_id": 1, "timeline_start": 0, "trim_out": 10},
                    {
                        "id": "b",
                        "source_type": "file",
                        "file_path": "C:/x/uploaded.mp4",
                        "timeline_start": 10,
                        "trim_out": 3,
                    },
                ],
            }
        ]
    }
    recorded = _v1_recorded_clips_sorted(body)
    assert [c["id"] for c in recorded] == ["a"]
    main = _v1_main_clips_sorted(body)
    assert [c["id"] for c in main] == ["a", "b"]
    overlays = _overlay_track_clips(body)
    assert overlays == []


def test_non_v1_file_clip_stays_overlay():
    body = {
        "tracks": [
            {
                "id": "v2",
                "type": "video",
                "clips": [
                    {
                        "id": "sticker",
                        "source_type": "file",
                        "file_path": "C:/x/sticker.png",
                        "timeline_start": 1,
                        "trim_out": 3,
                    },
                ],
            }
        ]
    }
    overlays = _overlay_track_clips(body)
    assert [c["id"] for c in overlays] == ["sticker"]
    assert _is_file_overlay_clip(overlays[0])


def test_non_v1_recorded_clip_exports_as_full_canvas_video_layer(tmp_path):
    body = {
        "tracks": [
            {
                "id": "v1",
                "type": "video",
                "clips": [
                    {
                        "id": "top",
                        "source_type": "recorded_clip",
                        "source_id": 2,
                        "timeline_start": 1.5,
                        "trim_in": 0.5,
                        "trim_out": 3.5,
                    }
                ],
            },
            {
                "id": "v2",
                "type": "video",
                "clips": [{"id": "base", "source_type": "recorded_clip", "source_id": 1, "timeline_start": 0, "trim_out": 8}],
            },
        ]
    }
    overlays = _overlay_track_clips(body)
    assert [c["id"] for c in overlays] == ["top"]
    assert overlays[0]["is_timeline_video_layer"] is True
    assert overlays[0]["transform"]["width"] == 1.0
    assert _recorded_source_ids_for_export(body) == [1, 2]

    top_path = tmp_path / "top.mp4"
    top_path.write_bytes(b"not-real-video")
    resolved = _resolve_overlay_clip_paths(overlays, {2: top_path})
    assert resolved[0]["file_path"] == str(top_path)


def test_non_v1_uploaded_video_exports_as_full_canvas_video_layer():
    body = {
        "tracks": [
            {
                "id": "v1",
                "type": "video",
                "clips": [
                    {
                        "id": "uploaded",
                        "source_type": "file",
                        "file_path": "C:/x/angle.mp4",
                        "timeline_start": 2,
                        "trim_out": 4,
                    }
                ],
            },
            {
                "id": "v2",
                "type": "video",
                "clips": [{"id": "base", "source_type": "recorded_clip", "source_id": 1, "timeline_start": 0, "trim_out": 8}],
            },
        ]
    }
    overlays = _overlay_track_clips(body)
    assert [c["id"] for c in overlays] == ["uploaded"]
    assert overlays[0]["is_timeline_video_layer"] is True
    assert overlays[0]["transform"]["width"] == 1.0
    assert overlays[0]["transform"]["scale"] == 1.0


def test_export_base_can_fall_back_to_first_visible_video_track():
    body = {
        "tracks": [
            {"id": "v1", "type": "video", "clips": []},
            {
                "id": "v2",
                "type": "video",
                "clips": [
                    {"id": "top", "source_type": "recorded_clip", "source_id": 11, "timeline_start": 1, "trim_out": 3}
                ],
            },
            {
                "id": "v3",
                "type": "video",
                "clips": [
                    {"id": "base", "source_type": "recorded_clip", "source_id": 10, "timeline_start": 0, "trim_out": 7}
                ],
            },
        ]
    }
    base_track_id, clips = _base_video_track_for_export(body)
    assert base_track_id == "v3"
    assert [c["id"] for c in clips] == ["base"]
    assert [c["id"] for c in _main_video_clips_sorted(body)] == ["base"]

    overlays = _overlay_track_clips(body, base_track_id=base_track_id)
    assert [c["id"] for c in overlays] == ["top"]
    assert overlays[0]["is_timeline_video_layer"] is True
    assert _recorded_source_ids_for_export(body) == [10, 11]


def test_video_track_order_controls_export_layer_order():
    body = {
        "tracks": [
            {
                "id": "v2",
                "type": "video",
                "clips": [
                    {"id": "new-top", "source_type": "recorded_clip", "source_id": 22, "timeline_start": 1, "trim_out": 3}
                ],
            },
            {
                "id": "v1",
                "type": "video",
                "clips": [
                    {"id": "new-base", "source_type": "recorded_clip", "source_id": 21, "timeline_start": 0, "trim_out": 8}
                ],
            },
        ]
    }

    base_track_id, base_clips = _base_video_track_for_export(body)
    overlays = _overlay_track_clips(body, base_track_id=base_track_id)

    assert base_track_id == "v1"
    assert [clip["id"] for clip in base_clips] == ["new-base"]
    assert [clip["id"] for clip in overlays] == ["new-top"]
