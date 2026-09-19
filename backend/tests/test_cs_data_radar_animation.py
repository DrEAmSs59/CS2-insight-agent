"""雷达开场动画：定格复用与烘焙帧率。"""

from pathlib import Path

from app.features.cs_data_radar.export_bake import bake_candidate_videos
from app.features.cs_data_radar.radar_animation import FPS, live_frame_count


def test_live_frame_count_stops_after_burst():
    assert live_frame_count(1) == 1
    assert live_frame_count(96) == 58
    assert live_frame_count(96) < 96


def test_bake_renders_at_animation_fps_not_source_fps(monkeypatch, tmp_path):
    captured = {}

    def fake_generate(**kwargs):
        captured.update(kwargs)
        dest = Path(kwargs["out_path"])
        dest.parent.mkdir(parents=True, exist_ok=True)
        dest.write_bytes(b"ok")
        return dest

    monkeypatch.setattr(
        "app.features.cs_data_radar.radar_animation.generate_radar_animation",
        fake_generate,
    )
    key = "demo::sid:111"
    out = bake_candidate_videos(
        ffmpeg_bin=tmp_path / "ffmpeg",
        used_keys=[key],
        candidates_by_key={
            key: {
                "has_parse_data": True,
                "player_name": "s1mple",
                "stats": {"kills": 20, "deaths": 10, "assists": 4, "kpr": 0.9, "adr": 101, "kast": 70, "survival_rate": 40},
                "team_key": 3,
                "team_label": "CT",
                "demo_source": "Blast",
                "map_name": "de_mirage",
                "kda": "20 / 10 / 4",
                "match_avg": {"kpr": 0.8, "adr": 80},
            }
        },
        candidate_state={},
        portraits={},
        out_dir=tmp_path,
        fps=60,
        width=1920,
        height=1080,
    )
    assert key in out
    assert captured["fps"] == FPS
    assert captured["output_fps"] == 60
    assert captured.get("workers") is None or captured.get("workers") >= 1


def test_render_reuses_freeze_frames(tmp_path):
    from app.features.cs_data_radar.radar_animation import FRAME_EXT, render_animation_frames

    frames = render_animation_frames(
        player_name="s1mple",
        radar={"kpr": 0.9, "survival_rate": 0.4, "adr": 90.0, "kast": 0.7, "multi_kill": 3.0},
        match_avg_radar={"kpr": 0.8, "survival_rate": 0.3, "adr": 80.0, "kast": 0.6, "multi_kill": 2.0},
        portrait_path=None,
        team_key=3,
        team_label="CT",
        out_dir=tmp_path,
        fps=8,
        duration=1.0,
        workers=1,
    )
    n = len(frames)
    live_n = live_frame_count(n)
    assert n >= 8
    assert live_n < n
    last_live = tmp_path / f"frame_{live_n - 1:04d}.{FRAME_EXT}"
    freeze = tmp_path / f"frame_{n - 1:04d}.{FRAME_EXT}"
    assert last_live.is_file() and freeze.is_file()
    assert last_live.read_bytes() == freeze.read_bytes()


def test_chinese_player_name_uses_cjk_font():
    from app.features.cs_data_radar.radar_renderer import _font_for_name, _text_needs_cjk

    assert _text_needs_cjk("简单")
    assert not _text_needs_cjk("s1mple")
    cjk = _font_for_name("简单", 32)
    latin = _font_for_name("s1mple", 32)
    assert "noto" in str(getattr(cjk, "path", "")).lower()
    assert "rajdhani" in str(getattr(latin, "path", "")).lower()
    assert cjk.getlength("简单") > latin.getlength("简单")
