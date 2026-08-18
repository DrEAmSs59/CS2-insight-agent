from types import SimpleNamespace

from app.obs_tuning import (
    ObsTuningGoal,
    _prioritize_gpu_rows,
    build_change_plan,
    discover_environment,
    preferred_hardware_recording_encoder,
    recommend,
)


def test_hybrid_gpu_list_prioritizes_discrete_gpu():
    result = _prioritize_gpu_rows([
        {"name": "AMD Radeon(TM) Graphics", "memory_mb": 512},
        {"name": "NVIDIA GeForce RTX 5070", "memory_mb": 12227},
    ])

    assert result[0]["name"] == "NVIDIA GeForce RTX 5070"


def test_preferred_hardware_recording_encoder_supports_each_vendor():
    cases = [
        ("NVIDIA GeForce RTX 5070", "nvenc_h264"),
        ("AMD Radeon RX 7900 XTX", "amf_h264"),
        ("Intel Arc A770", "qsv_h264"),
    ]

    for gpu_name, expected_id in cases:
        result = preferred_hardware_recording_encoder([{"name": gpu_name}])
        assert result is not None
        assert result["id"] == expected_id


def _discovery(*, gpu_name="NVIDIA GeForce RTX 4080", connected=True):
    encoders = [
        {"id": "nvenc_h264", "label": "NVIDIA NVENC H.264", "codec": "h264", "confidence": "inferred"},
        {"id": "nvenc_hevc", "label": "NVIDIA NVENC HEVC", "codec": "hevc", "confidence": "inferred"},
        {"id": "nvenc_av1", "label": "NVIDIA NVENC AV1", "codec": "av1", "confidence": "inferred"},
    ] if gpu_name else []
    return {
        "obs": {
            "connected": connected,
            "active_profile": "Streaming",
            "video": {
                "base_width": 2560,
                "base_height": 1440,
                "output_width": 2560,
                "output_height": 1440,
                "fps": 60,
                "fps_num": 60,
                "fps_den": 1,
            },
            "recording": {"encoder": "jim_nvenc"},
        },
        "hardware": {
            "gpus": [{"name": gpu_name}] if gpu_name else [],
            "encoders": encoders,
        },
        "ffmpeg": {"ffprobe_usable": True, "ffprobe_path": "C:/ffmpeg/ffprobe.exe"},
        "limits": {"game_fps_p10": None, "game_fps_source": "not_measured"},
    }


def test_recommendation_keeps_exact_integer_fps_and_marks_prediction():
    result = recommend(
        ObsTuningGoal(fps=480, resolution="current", codec="auto", priority="quality"),
        _discovery(),
    )

    assert result["target"]["fps_num"] == 480
    assert result["target"]["fps_den"] == 1
    assert result["target"]["width"] == 2560
    assert result["target"]["height"] == 1440
    assert result["prediction_only"] is True
    assert result["confidence"] == "medium"
    assert any("CS2 P10/P1" in risk for risk in result["risks"])


def test_recommendation_scores_lower_load_target_higher():
    discovery = _discovery()
    high = recommend(ObsTuningGoal(fps=480, resolution="current", priority="quality"), discovery)
    lower = recommend(ObsTuningGoal(fps=240, resolution="full-hd", priority="balanced"), discovery)

    assert lower["score"] > high["score"]
    assert lower["loads"]["encoder_percent"] < high["loads"]["encoder_percent"]
    assert high["safer_start"]["fps_num"] <= 360


def test_discovery_uses_real_inputs_without_returning_password(tmp_path):
    obs_exe = tmp_path / "obs64.exe"
    ffmpeg_exe = tmp_path / "ffmpeg.exe"
    obs_exe.write_bytes(b"")
    ffmpeg_exe.write_bytes(b"")
    cfg = SimpleNamespace(
        obs=SimpleNamespace(
            obs_path=str(obs_exe),
            host="localhost",
            port=4455,
            password="secret-value",
        ),
        ffmpeg_path=str(ffmpeg_exe),
    )
    status = {
        "obs_connected": True,
        "obs_version": "31.0.0",
        "obs_config_dir": str(tmp_path / "obs-studio"),
        "active_profile": "Streaming",
        "active_scene_collection": "Scenes",
        "video": {"output_width": 1920, "output_height": 1080, "fps_num": 60, "fps_den": 1},
        "recording": {"encoder": "jim_nvenc", "output_path": str(tmp_path)},
        "scene": {},
    }
    hardware = {
        "cpu": "Test CPU",
        "logical_cores": 16,
        "memory_bytes": 32 * 1024**3,
        "memory_gb": 32.0,
        "gpus": [{"name": "NVIDIA GeForce RTX 4080"}],
    }

    result = discover_environment(
        cfg,
        status_loader=lambda _obs: status,
        hardware_loader=lambda: hardware,
    )

    assert result["obs"]["install_path"] == str(obs_exe)
    assert result["obs"]["password_configured"] is True
    assert "password" not in result["obs"]
    assert any(item["id"] == "nvenc_av1" for item in result["hardware"]["encoders"])
    assert result["ffmpeg"]["usable"] is True


def test_plan_is_read_only_and_lists_protected_fields():
    discovery = _discovery()
    goal = ObsTuningGoal(fps=360, resolution="four-three", codec="h264")
    recommendation = recommend(goal, discovery)

    plan = build_change_plan(goal, discovery, recommendation)

    assert plan["plan_hash"]
    assert plan["can_apply"] is True
    assert any(change["target"] == "360/1" for change in plan["changes"])
    assert "audio.track_mapping" in plan["protected_fields"]
    assert "ffmpeg.path" in plan["protected_fields"]
    assert any("备份" in guard for guard in plan["safety_guards"])


def test_plan_blocks_when_connection_has_no_valid_video_settings():
    discovery = _discovery()
    discovery["obs"]["video"] = {
        "base_width": 0,
        "base_height": 0,
        "output_width": 0,
        "output_height": 0,
        "fps_num": 0,
        "fps_den": 1,
    }
    goal = ObsTuningGoal(fps=480, resolution="current")

    plan = build_change_plan(goal, discovery, recommend(goal, discovery))

    assert plan["can_apply"] is False
    assert "没有读到 OBS 当前视频设置" in plan["blockers"]
